import { Client, estypes } from "@elastic/elasticsearch";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  ELASTICSEARCHFS_CHUNKS_INDEX,
  ELASTICSEARCHFS_META_INDEX,
  ELASTICSEARCHFS_PATH_TREE_DOC_ID,
  ELASTICSEARCHFS_PATH_TREE_ENCODING,
} from "../elasticsearchfs-constants.js";
import { pathToSlug } from "../core/path-tree.js";
import type { JsonObject, PathTreePolicy } from "./path-tree-policy.js";

export const DEFAULT_DATA_ROOT = "./data";

/** Reads a JSON mapping file bundled alongside this module and returns it as a plain object. */
function loadMappingFile(fileName: string): JsonObject {
  const raw = readFileSync(new URL(`../es-adapter/${fileName}`, import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${fileName}: expected mapping object.`);
  }
  return parsed as JsonObject;
}

const elasticsearchfsChunksMapping = loadMappingFile("mappings.json");
const elasticsearchfsMetaMapping = loadMappingFile("meta-mapping.json");

type IngestSummary = {
  files: number;
  slugs: string[];
};

type FileDocument = {
  slug: string;
  content: string;
  updated_at: string;
};

type BulkOperation = { index: { _index: string } } | FileDocument;

/** Recursively walks `rootDir` and returns absolute paths of all `.mdx` files, sorted alphabetically. */
async function collectFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".mdx") continue;
      out.push(fullPath);
    }
  }

  await walk(rootDir);
  out.sort();
  return out;
}

/** Drops the index if it already exists, then recreates it with the given mappings. */
async function recreateIndex(client: Client, index: string, mappings: JsonObject): Promise<void> {
  const exists = await client.indices.exists({ index });
  if (exists) {
    await client.indices.delete({ index });
    console.log(`Deleted index "${index}".`);
  }
  await client.indices.create({ index, mappings });
  console.log(`Created index "${index}".`);
}

/**
 * Serialises the path tree to JSON, compresses it with gzip, and returns the result as a base64
 * string. The compact encoding keeps the stored document small for a path tree that can be large.
 */
function encodePathTreePayload(pathTree: PathTreePolicy): string {
  const json = JSON.stringify(pathTree);
  const gzipped = gzipSync(Buffer.from(json, "utf8"));
  return gzipped.toString("base64");
}

/**
 * Writes the path tree as a single meta document with a fixed ID so it can be retrieved by ID
 * without a search query. `refresh: true` ensures it is immediately visible after indexing.
 */
async function indexPathTreeDocument(client: Client, pathTree: PathTreePolicy): Promise<void> {
  const now = new Date().toISOString();
  await client.index({
    index: ELASTICSEARCHFS_META_INDEX,
    id: ELASTICSEARCHFS_PATH_TREE_DOC_ID,
    refresh: true,
    document: {
      doc_type: ELASTICSEARCHFS_PATH_TREE_DOC_ID,
      tree_version: now,
      encoding: ELASTICSEARCHFS_PATH_TREE_ENCODING,
      payload: encodePathTreePayload(pathTree),
      created_at: now,
      updated_at: now,
    },
  });
  console.log(`Indexed path tree doc "${ELASTICSEARCHFS_PATH_TREE_DOC_ID}" in "${ELASTICSEARCHFS_META_INDEX}".`);
}

/**
 * Full ingest run: discovers all `.mdx` files under `options.dataRoot`, recreates both indices,
 * bulk-indexes one document per file, and stores the path tree document.
 * Returns a summary of how many files and slugs were processed.
 */
export async function runIngestPipeline(
  client: Client,
  dataRoot: string,
  pathTree: PathTreePolicy,
): Promise<IngestSummary> {
  const resolvedDataRoot = path.resolve(dataRoot);
  const files = await collectFiles(resolvedDataRoot);
  if (files.length === 0) {
    throw new Error(`No ingestible files found under ${dataRoot}.`);
  }

  await recreateIndex(client, ELASTICSEARCHFS_META_INDEX, elasticsearchfsMetaMapping);
  await recreateIndex(client, ELASTICSEARCHFS_CHUNKS_INDEX, elasticsearchfsChunksMapping);

  const operations: BulkOperation[] = [];
  const slugSet = new Set<string>();

  for (const filePath of files) {
    const rel = path.relative(resolvedDataRoot, filePath);
    const slug = pathToSlug(rel.split(path.sep).join("/"));
    slugSet.add(slug);
    const fileStat = await stat(filePath);
    const content = await readFile(filePath, "utf8");
    operations.push({ index: { _index: ELASTICSEARCHFS_CHUNKS_INDEX } });
    operations.push({
      slug,
      content,
      updated_at: fileStat.mtime.toISOString(),
    });
  }

  if (operations.length > 0) {
    const bulkResponse = await client.bulk({
      operations: operations as estypes.BulkOperationContainer[],
      refresh: true,
    });
    if (bulkResponse.errors) {
      throw new Error("Bulk ingest reported errors. Inspect Elasticsearch response for details.");
    }
  }

  await indexPathTreeDocument(client, pathTree);

  const summary: IngestSummary = {
    files: files.length,
    slugs: [...slugSet].sort(),
  };
  console.log(`Indexed ${summary.files} files.`);
  return summary;
}

import "dotenv/config";
import path from "node:path";
import { createESClient } from "../es-adapter/client.js";
import { DEFAULT_DATA_ROOT, runIngestPipeline } from "./ingest.js";
import { loadPathTreeAccessPolicy } from "./path-tree-policy.js";

const DEFAULT_PATH_TREE_PATH = "./data/path_tree.json";
const SYSTEM_PROFILE = "SYSTEM";

/**
 * Orchestrates the bootstrap sequence: ingest data files.
 */
async function main(): Promise<void> {
  
  // 1. Create an ES client with the SYSTEM profile
  const client = createESClient(SYSTEM_PROFILE);

  // 2. Load the path-tree policy used for ingest metadata
  const dataRoot = path.resolve(process.cwd(), DEFAULT_DATA_ROOT);
  const pathTreePath = path.resolve(process.cwd(), DEFAULT_PATH_TREE_PATH);
  const pathTreePolicy = await loadPathTreeAccessPolicy(pathTreePath);

  // 3. Run the ingest pipeline
  try {
    const ingest = await runIngestPipeline(client, dataRoot, pathTreePolicy);

    console.log(`Bootstrap complete: ${ingest.files} files, ${ingest.chunks} chunks.`);
  } finally {
    await client.close();
  }
}

await main();

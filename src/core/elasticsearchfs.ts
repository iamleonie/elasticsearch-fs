import nodePath from 'node:path/posix';
import type { Client } from '@elastic/elasticsearch';
import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';
import { ELASTICSEARCHFS_FILES_INDEX } from '../elasticsearchfs-constants.js';
import { escapeRegexpLiteral, hasRegexMeta } from './grep.js';
import type {
  DirentEntry,
  ReadFileOptions,
  WriteFileOptions,
} from './just-bash-fs-types.js';
import { normalizePath, pathToSlug } from './path-tree.js';

// POSIX EROFS — mutating operations are not allowed on this read-only VFS.
function erofs(): Error {
  const err = new Error(
    'EROFS: read-only file system',
  ) as NodeJS.ErrnoException;
  err.code = 'EROFS';
  return err;
}

// POSIX ENOTDIR — path refers to a file where a directory was required (e.g. `ls` on a file).
function enotdir(): Error {
  const err = new Error('ENOTDIR: not a directory') as NodeJS.ErrnoException;
  err.code = 'ENOTDIR';
  return err;
}

// POSIX ENOENT — path is not present in the tree (no such file or directory).
function enoent(): Error {
  const err = new Error(
    'ENOENT: no such file or directory',
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

// POSIX EINVAL — e.g. `readlink` on a path that exists but is not a symlink.
function einval(message: string): Error {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = 'EINVAL';
  return err;
}

interface FileHitSource {
  content?: string;
  slug?: string;
}

/**
 * Coarse grep filter used by {@link ElasticsearchFs.findMatchingFiles}.
 */
interface GrepCoarseFilter {
  pattern: string;
  ignoreCase: boolean;
  fixedStrings: boolean;
}

const SEARCH_PAGE_SIZE = 1000;

/**
 * Read-only virtual filesystem backed by Elasticsearch file documents and a preloaded path tree.
 */
export class ElasticsearchFs implements IFileSystem {
  private readonly files: Set<string>;
  private readonly dirs: Map<string, string[]>;
  private readonly client: Client;

  constructor(options: {
    client: Client;
    files: ReadonlySet<string>;
    dirs: ReadonlyMap<string, string[]>;
  }) {
    this.client = options.client;
    this.files = new Set(options.files);
    this.dirs = new Map(options.dirs);
  }

  /** Map a normalized path to canonical tree file key (`files` stores `/<slug>.mdx`). */
  private resolveTreeFileKey(normalized: string): string | undefined {
    return this.files.has(normalized) ? normalized : undefined;
  }

  /**
   * Path must exist as a file in the pruned tree (QUERY_SPEC);
   * this validates a specific path for reading.
   * @returns Ingest `slug` for file content documents (e.g. `auth/oauth`).
   */
  private resolveReadFileSlug(path: string): string {
    const normalized = normalizePath(path);
    if (this.dirs.has(normalized)) {
      throw enotdir();
    }
    const treeKey = this.resolveTreeFileKey(normalized);
    if (treeKey === undefined) {
      throw enoent();
    }
    return pathToSlug(treeKey);
  }

  /**
   * Ingest `slug` for a visible canonical file (`elasticsearchfs-chunks`), or `null` if not in the tree.
   */
  getFileSlug(vfsPath: string): string | null {
    const normalized = normalizePath(vfsPath);
    const treeKey = this.resolveTreeFileKey(normalized);
    if (treeKey === undefined) return null;
    return pathToSlug(treeKey);
  }

  /**
   * Normalized visible file paths in the pruned tree (same keys as `files`).
   */
  getVisibleFilePaths(): string[] {
    return [...this.files].sort();
  }

  /**
   * Paginate over `elasticsearchfs-chunks` with `search_after`, processing each page via callbacks.
   * Stops when a page is empty, shorter than `SEARCH_PAGE_SIZE`, or the cursor extractor returns `undefined`.
   */
  private async searchAllPages(
    params: Parameters<Client['search']>[0],
    extractCursor: (
      hits: { _source?: FileHitSource }[],
    ) => unknown[] | undefined,
    onPage: (hits: { _source?: FileHitSource }[]) => void,
  ): Promise<void> {
    let searchAfter: unknown[] | undefined;
    while (true) {
      const res = await this.client.search<FileHitSource>({
        ...params,
        size: SEARCH_PAGE_SIZE,
        ...(searchAfter !== undefined ? { search_after: searchAfter } : {}),
      } as Parameters<Client['search']>[0]);
      const hits = res.hits.hits;
      if (hits.length === 0) break;
      onPage(hits);
      if (hits.length < SEARCH_PAGE_SIZE) break;
      const cursor = extractCursor(hits);
      if (cursor === undefined) break;
      searchAfter = cursor;
    }
  }

  /**
   * Coarse stage for `grep`: distinct file `slug` values that may match.
   *
   * @param slugsUnderDirs In-scope ingest slugs (e.g. `auth/oauth`).
   * @returns Slugs that passed the coarse query and optional match_phrase/regexp filter.
   */
  async findMatchingFiles(
    coarseFilter: GrepCoarseFilter,
    slugsUnderDirs: string[],
  ): Promise<string[]> {
    if (slugsUnderDirs.length === 0) return [];

    const isLiteralPattern =
      coarseFilter.fixedStrings || !hasRegexMeta(coarseFilter.pattern);

    const query = {
      bool: {
        filter: [{ terms: { slug: slugsUnderDirs } }],
        must: isLiteralPattern
          ? coarseFilter.ignoreCase
            ? [
                {
                  match_phrase: {
                    content: coarseFilter.pattern,
                  },
                },
              ]
            : [
                {
                  regexp: {
                    'content.pattern': {
                      value: `.*(${escapeRegexpLiteral(coarseFilter.pattern)}).*`,
                      case_insensitive: false,
                    },
                  },
                },
              ]
          : [
              {
                regexp: {
                  'content.pattern': {
                    value: `.*(${coarseFilter.pattern}).*`,
                    case_insensitive: coarseFilter.ignoreCase,
                  },
                },
              },
            ],
      },
    };

    const slugs = new Set<string>();
    await this.searchAllPages(
      {
        index: ELASTICSEARCHFS_FILES_INDEX,
        track_total_hits: false,
        _source: ['slug'],
        sort: [{ slug: { order: 'asc' } }],
        query,
      },
      (hits) => {
        const last = hits[hits.length - 1];
        const lastSlug = last?._source?.slug;
        if (typeof lastSlug !== 'string' || lastSlug.length === 0) {
          return undefined;
        }
        return [lastSlug];
      },
      (hits) => {
        for (const hit of hits) {
          const s = hit._source?.slug;
          if (typeof s === 'string' && s.length > 0) slugs.add(s);
        }
      },
    );
    return [...slugs];
  }

  /**
   * Read the contents of a file as a string (default: utf8)
   * @throws Error if file doesn't exist or is a directory
   */
  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    void options;
    const slug = this.resolveReadFileSlug(path);

    const res = await this.client.search<FileHitSource>({
      index: ELASTICSEARCHFS_FILES_INDEX,
      size: 1,
      _source: ['content'],
      query: { bool: { filter: [{ term: { slug } }] } },
    });
    const hit = res.hits.hits[0];
    const content = hit?._source?.content;
    if (content === undefined) {
      throw enoent();
    }

    return content;
  }

  /**
   * Read the contents of a file as a Uint8Array (binary)
   * Same logical file as {@link readFile}, as UTF-8 bytes (corpus is text in ES).
   * Implemented by reusing `readFile` then `TextEncoder`.
   * @throws Error if file doesn't exist or is a directory
   */
  async readFileBuffer(path: string): Promise<Uint8Array> {
    const text = await this.readFile(path);
    return new TextEncoder().encode(text);
  }

  /**
   * Does not write content to a file, nor create it if it doesn't exist.
   * @throws Error if called to enforce read-only interaction.
   */
  async writeFile(
    _path: string,
    _content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    throw erofs();
  }

  /**
   * Does not append content to a file, nor create it if it doesn't exist.
   * @throws Error if called to enforce read-only interaction.
   */
  async appendFile(
    _path: string,
    _content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    throw erofs();
  }

  /**
   * Check if a path exists
   */
  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);

    // Directory: any path that appears as a parent in `buildFileTree` (see `path-tree.ts`).
    if (this.dirs.has(normalized)) return true;

    // File: canonical `/<slug>.mdx` only.
    if (this.resolveTreeFileKey(normalized) !== undefined) return true;

    return false;
  }

  /**
   * Get file/directory information
   * @throws Error if path doesn't exist
   */
  async stat(path: string): Promise<FsStat> {
    const normalized = normalizePath(path);

    if (this.dirs.has(normalized)) {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o40755, // directory, user rwx / group+other rx (placeholder; not enforced on this VFS)
        size: 0, // POSIX often reports 0 for dirs; we have no per-dir byte size in the tree
        mtime: new Date(0), // synthetic — virtual dirs are inferred from file paths, not stored in ES
      };
    }

    const treeKey = this.resolveTreeFileKey(normalized);
    if (treeKey !== undefined) {
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o100644, // regular file, user rw / group+other r (placeholder; not enforced on this VFS)
        size: 0,
        mtime: new Date(0),
      };
    }

    throw enoent();
  }

  /**
   * Does not create a directory.
   * @throws Error if called to enforce read-only interaction.
   */
  async mkdir(_path: string, _options?: MkdirOptions): Promise<void> {
    throw erofs();
  }

  /**
   * Read directory contents
   * @returns Array of entry names (not full paths)
   * @throws Error if path doesn't exist or is not a directory
   */
  async readdir(path: string): Promise<string[]> {
    return this.readdirNormalized(normalizePath(path));
  }

  /** @param normalized Result of {@link normalizePath} for `path`. */
  private readdirNormalized(normalized: string): string[] {
    const names = this.dirs.get(normalized);

    if (names !== undefined) {
      return [...names];
    }

    if (this.files.has(normalized)) {
      throw enotdir();
    }

    throw enoent();
  }

  /**
   * Read directory contents with file type information (optional)
   * This is more efficient than readdir + stat for each entry
   * @returns Array of DirentEntry objects with name and type
   * @throws Error if path doesn't exist or is not a directory
   */
  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const normalized = normalizePath(path);
    const names = this.readdirNormalized(normalized);
    const out: DirentEntry[] = [];

    for (const name of names) {
      const childPath = normalizePath(nodePath.join(normalized, name));
      const isDirectory = this.dirs.has(childPath);
      const isFile = !isDirectory && this.files.has(childPath);

      out.push({
        name,
        isFile,
        isDirectory,
        isSymbolicLink: false,
      });
    }

    return out;
  }

  /**
   * Does not remove a file or directory.
   * @throws Error if called to enforce read-only interaction.
   */
  async rm(_path: string, _options?: RmOptions): Promise<void> {
    throw erofs();
  }

  /**
   * Does not copy a file or directory.
   * @throws Error if called to enforce read-only interaction.
   */
  async cp(_src: string, _dest: string, _options?: CpOptions): Promise<void> {
    throw erofs();
  }

  /**
   * Does not move or rename a file or directory.
   * @throws Error if called to enforce read-only interaction.
   */
  async mv(_src: string, _dest: string): Promise<void> {
    throw erofs();
  }

  /**
   * Resolve a relative path against a base path
   */
  resolvePath(base: string, path: string): string {
    const rel = path.trim();
    if (rel.startsWith('/')) {
      return normalizePath(rel);
    }
    return normalizePath(nodePath.join(normalizePath(base), rel));
  }

  /**
   * Get all paths in the filesystem (useful for glob matching)
   * Optional - implementations may return empty array if not supported
   */
  getAllPaths(): string[] {
    return [...this.files, ...this.dirs.keys()].sort();
  }

  /**
   * Does not change file or directory permissions.
   * @throws Error if called to enforce read-only interaction.
   */
  async chmod(_path: string, _mode: number): Promise<void> {
    throw erofs();
  }

  /**
   * Does not create a symbolic link.
   * @throws Error if called to enforce read-only interaction.
   */
  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw erofs();
  }

  /**
   * Does not create a hard link.
   * @throws Error if called to enforce read-only interaction.
   */
  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw erofs();
  }

  /**
   * Read the target of a symbolic link
   * @throws Error if path doesn't exist or is not a symlink
   */
  async readlink(path: string): Promise<string> {
    const n = normalizePath(path);
    if (!(await this.exists(n))) {
      throw enoent();
    }
    throw einval('readlink: not a symbolic link');
  }

  /**
   * Get file/directory information without following symlinks
   * Same as {@link stat} — this VFS does not model symlinks (`symlink` is read-only / unsupported),
   * so there is nothing to follow; `lstat` and `stat` return identical `FsStat` values.
   * @throws Error if path doesn't exist
   */
  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  /**
   * Resolve all symlinks in a path to get the canonical physical path.
   * This is equivalent to POSIX realpath() - it resolves all symlinks
   * in the path and returns the absolute physical path.
   * Used by pwd -P and cd -P for symlink resolution.
   * @throws Error if path doesn't exist or contains a broken symlink
   */
  async realpath(path: string): Promise<string> {
    const n = normalizePath(path);
    if (!(await this.exists(n))) {
      throw enoent();
    }
    return n;
  }

  /**
   * Does not set access or modification times of a file.
   * @throws Error if called to enforce read-only interaction.
   */
  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    throw erofs();
  }
}

/**
 * Session init for native-ES-DLS mode:
 * fetch `__path_tree__` from Elasticsearch metadata and prune by selected profile.
 */
import type { Client } from '@elastic/elasticsearch';
import {
  type PathTreePolicy,
  parsePathTreeAccessPolicy,
} from './bootstrap/path-tree-policy.js';
import { buildFileTreeFromSlugs } from './core/path-tree.js';
import {
  ELASTICSEARCHFS_META_INDEX,
  ELASTICSEARCHFS_PATH_TREE_DOC_ID,
} from './elasticsearchfs-constants.js';

interface InitSessionTreeState {
  files: ReadonlySet<string>;
  dirs: ReadonlyMap<string, string[]>;
}

/** Fetches the `__path_tree__` document from the meta index, decodes base64 UTF-8 JSON `payload`, and parses it into a `PathTreePolicy`. */
async function fetchPathTreePolicy(client: Client): Promise<PathTreePolicy> {
  const res = await client.get<{ payload?: string }>({
    index: ELASTICSEARCHFS_META_INDEX,
    id: ELASTICSEARCHFS_PATH_TREE_DOC_ID,
  });
  const payload = res._source?.payload;
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error(
      'Session init failed: invalid __path_tree__ metadata payload.',
    );
  }

  const json = Buffer.from(payload, 'base64').toString('utf8');
  const parsed = JSON.parse(json) as unknown;
  return parsePathTreeAccessPolicy(parsed);
}

/**
 * Returns the set of slugs visible for a selected profile based on `isPublic/groups`.
 */
function resolveVisibleSlugsFromProfile(
  pathTree: PathTreePolicy,
  profile: string,
): Set<string> {
  const normalizedProfile = profile.trim().toLowerCase();
  if (normalizedProfile === 'system') {
    return new Set(Object.keys(pathTree));
  }

  const visible = new Set<string>();

  for (const [slug, entry] of Object.entries(pathTree)) {
    if (entry.isPublic) {
      visible.add(slug);
      continue;
    }
    for (const group of entry.groups) {
      if (group.trim().toLowerCase() === normalizedProfile) {
        visible.add(slug);
        break;
      }
    }
  }

  return visible;
}

/**
 * 1. Fetch `__path_tree__` from metadata index.
 * 2. Resolve visible slugs from selected profile and `isPublic/groups`.
 * 3. Build in-memory file tree for ElasticsearchFs path operations.
 */
export async function initSessionTree(
  client: Client,
  profile: string,
): Promise<InitSessionTreeState> {
  const pathTree = await fetchPathTreePolicy(client);
  const authorizedSlugs = resolveVisibleSlugsFromProfile(pathTree, profile);
  const { files, dirs } = buildFileTreeFromSlugs(authorizedSlugs);

  return { files, dirs };
}

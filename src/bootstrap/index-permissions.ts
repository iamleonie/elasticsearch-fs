import {
  ELASTICSEARCHFS_CHUNKS_INDEX,
  ELASTICSEARCHFS_META_INDEX,
} from "../elasticsearchfs-constants.js";

export type IndexPermissionDescriptor = {
  names: string[];
  privileges: string[];
  query?: { terms: { slug: string[] } };
};

/**
 * Builds index permission descriptors for both the chunks and meta indices.
 * When `slugs` is provided, the chunks entry is scoped to those slugs via a DLS `terms` query.
 */
export function buildReadOnlyIndexPermissions(slugs?: string[]): IndexPermissionDescriptor[] {
  const chunksEntry: IndexPermissionDescriptor = {
    names: [ELASTICSEARCHFS_CHUNKS_INDEX],
    privileges: ["read"],
  };
  if (Array.isArray(slugs)) {
    chunksEntry.query = { terms: { slug: slugs } };
  }
  const metaEntry: IndexPermissionDescriptor = {
    names: [ELASTICSEARCHFS_META_INDEX],
    privileges: ["read"],
  };
  return [chunksEntry, metaEntry];
}

/** Builds the `role_descriptors` map for an API key that restricts access to the given slugs. */
export function buildApiKeyRoleDescriptors(
  roleName: string,
  slugs: string[],
): Record<string, unknown> {
  return {
    [roleName]: {
      cluster: [],
      indices: buildReadOnlyIndexPermissions(slugs),
    },
  };
}

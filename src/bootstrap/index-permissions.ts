import {
  ELASTICSEARCHFS_FILES_INDEX,
  ELASTICSEARCHFS_META_INDEX,
} from '../elasticsearchfs-constants.js';

export type IndexPermissionDescriptor = {
  names: string[];
  privileges: string[];
  query?: { terms: { slug: string[] } };
};

/**
 * Builds index permission descriptors for both the file-content (`elasticsearchfs-chunks`) and meta indices.
 * When `slugs` is provided, the files index entry is scoped to those slugs via a DLS `terms` query.
 */
export function buildReadOnlyIndexPermissions(
  slugs?: string[],
): IndexPermissionDescriptor[] {
  const filesIndexEntry: IndexPermissionDescriptor = {
    names: [ELASTICSEARCHFS_FILES_INDEX],
    privileges: ['read'],
  };
  if (slugs !== undefined) {
    filesIndexEntry.query = { terms: { slug: slugs } };
  }
  const metaEntry: IndexPermissionDescriptor = {
    names: [ELASTICSEARCHFS_META_INDEX],
    privileges: ['read'],
  };
  return [filesIndexEntry, metaEntry];
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

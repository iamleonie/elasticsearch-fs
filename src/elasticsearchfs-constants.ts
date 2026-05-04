/** Elasticsearch index holding full file bodies (one document per path slug). Index name is historical. */
export const ELASTICSEARCHFS_FILES_INDEX = 'elasticsearchfs-chunks';
export const ELASTICSEARCHFS_META_INDEX = 'elasticsearchfs-meta';
export const ELASTICSEARCHFS_PATH_TREE_DOC_ID = '__path_tree__';
export const ELASTICSEARCHFS_PATH_TREE_ENCODING = 'gzip+base64';

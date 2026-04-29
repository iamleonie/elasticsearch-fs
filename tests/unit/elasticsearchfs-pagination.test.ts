import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { ElasticsearchFs } from '../../src/core/elasticsearchfs.js';

type SearchResponse = {
  hits: {
    hits: Array<{
      _source?: {
        slug?: string;
        chunk_index?: number;
      };
    }>;
  };
};

function makeChunkHit(slug: string, chunkIndex: number): SearchResponse['hits']['hits'][number] {
  return { _source: { slug, chunk_index: chunkIndex } };
}

describe('ElasticsearchFs pagination', () => {
  it('paginates coarse grep search and deduplicates slugs', async () => {
    const firstPage = [
      ...Array.from({ length: 999 }, (_, i) => makeChunkHit('alpha', i)),
      makeChunkHit('beta', 0),
    ];
    const secondPage = [makeChunkHit('beta', 1), makeChunkHit('gamma', 0)];

    const searchMock = vi
      .fn<(request: object) => Promise<SearchResponse>>()
      .mockResolvedValueOnce({ hits: { hits: firstPage } })
      .mockResolvedValueOnce({ hits: { hits: secondPage } });

    const client = { search: searchMock } as object as Client;
    const fs = new ElasticsearchFs({
      client,
      files: new Set(),
      dirs: new Map(),
    });

    const out = await fs.findMatchingFiles(
      { pattern: 'access_token', ignoreCase: true, fixedStrings: false },
      ['alpha', 'beta', 'gamma'],
    );

    expect(new Set(out)).toEqual(new Set(['alpha', 'beta', 'gamma']));
    expect(searchMock).toHaveBeenCalledTimes(2);

    expect(searchMock.mock.calls[0]?.[0]).toMatchObject({
      size: 1000,
      sort: [{ slug: { order: 'asc' } }, { chunk_index: { order: 'asc' } }],
    });
    expect(searchMock.mock.calls[0]?.[0]).not.toHaveProperty('search_after');
    expect(searchMock.mock.calls[1]?.[0]).toMatchObject({
      search_after: ['beta', 0],
    });
  });
});

import type { Client } from '@elastic/elasticsearch';
import { describe, expect, it, vi } from 'vitest';
import { ElasticsearchFs } from '../../src/core/elasticsearchfs.js';

type SearchResponse = {
  hits: {
    hits: Array<{
      _source?: {
        slug?: string;
      };
    }>;
  };
};

function makeFileHit(slug: string): SearchResponse['hits']['hits'][number] {
  return { _source: { slug } };
}

describe('ElasticsearchFs pagination', () => {
  it('paginates coarse grep search and deduplicates slugs', async () => {
    const firstPage = [
      ...Array.from({ length: 999 }, (_, i) => makeFileHit(`alpha-${i}`)),
      makeFileHit('beta'),
    ];
    const secondPage = [makeFileHit('beta'), makeFileHit('gamma')];

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

    const scopeSlugs = [
      ...Array.from({ length: 999 }, (_, i) => `alpha-${i}`),
      'beta',
      'gamma',
    ];
    const out = await fs.findMatchingFiles(
      { pattern: 'access_token', ignoreCase: true, fixedStrings: false },
      scopeSlugs,
    );

    expect(new Set(out)).toEqual(new Set(scopeSlugs));
    expect(searchMock).toHaveBeenCalledTimes(2);

    expect(searchMock.mock.calls[0]?.[0]).toMatchObject({
      size: 1000,
      sort: [{ slug: { order: 'asc' } }],
    });
    expect(searchMock.mock.calls[0]?.[0]).not.toHaveProperty('search_after');
    expect(searchMock.mock.calls[1]?.[0]).toMatchObject({
      search_after: ['beta'],
    });
  });
});

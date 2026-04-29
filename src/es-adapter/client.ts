import { Client } from '@elastic/elasticsearch';

/**
 * Creates an Elasticsearch client using `ELASTICSEARCH_URL` and `ELASTICSEARCH_API_KEY_<profile>`
 * from the environment. Throws if either variable is missing.
 */
export function createESClient(profile: string): Client {
  const url = process.env.ELASTICSEARCH_URL;
  const apiKey = process.env[`ELASTICSEARCH_API_KEY_${profile}`];

  if (!url) {
    throw new Error('Missing ELASTICSEARCH_URL');
  }

  if (!apiKey) {
    throw new Error(
      `Missing ${`ELASTICSEARCH_API_KEY_${profile}`}. Define it to use profile "${profile}".`,
    );
  }
  return new Client({ node: url, auth: { apiKey } });
}

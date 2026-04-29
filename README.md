# ElasticsearchFs: Virtual Filesystem over Elasticsearch

This project is a **proof-of-concept** implementation of a virtual filesystem over Elasticsearch using [`just-bash`](https://github.com/vercel-labs/just-bash), a virtual Bash environment with an in-memory filesystem written in TypeScript for AI agents.

This project is inspired by recent discussions around virtual filesystems for AI agents, including:
- LangChain/LangSmith discussion: [Filesystem memory system post](https://x.com/hwchase17/status/2011814697889316930)
- Mintlify: [How we built a virtual filesystem for our assistant](https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant)

You can find the related write-up describing this implementation in [`BLOG_NOTES.md`](./BLOG_NOTES.md).


## Setup and Usage

### Requirements

- Node.js (v18+)
- Elasticsearch endpoint URL
- Credentials for profiles you use (`SYSTEM`, `PUBLIC`, `BILLING`, `INTERNAL`)

### Environment

Copy `.env.example` to `.env` and fill in your values:

```
ELASTICSEARCH_URL=https://your-project.es.region.aws.elastic.cloud
# Ingestion/bootstrap key
# ELASTICSEARCH_API_KEY_SYSTEM=...
#
# Runtime profile keys:
# ELASTICSEARCH_API_KEY_PUBLIC=read_key_for_public_role
# ELASTICSEARCH_API_KEY_BILLING=read_key_for_billing_role
# ELASTICSEARCH_API_KEY_INTERNAL=read_key_for_internal_role
```

`createESClient(profile)` reads these values from `process.env`. The bootstrap entrypoint loads `.env` via `dotenv/config`.
The profile must be uppercase (e.g., `PUBLIC`, `BILLING`, `INTERNAL`, `SYSTEM`) and maps exactly to:
- `ELASTICSEARCH_API_KEY_<PROFILE>` (for example `ELASTICSEARCH_API_KEY_BILLING`)
There is no fallback to a default key or alternate environment variable names.

### Create ingestion API key (`SYSTEM`)

1. Open your S[Serverless project](https://cloud.elastic.co/projects)
2. Open the project in Kibana under `https://<your-kibana-host>/app/management/security/api_keys`
3. Go to **API keys** and create a key (without setting additional privileges).
4. Use that value as:

```bash
ELASTICSEARCH_API_KEY_SYSTEM=<ingestion_api_key>
```

### Create runtime profile API keys manually (Kibana)

If you want to scope our different user roles with different document permissions, you can define profile specific API keys:

1. Open your S[Serverless project](https://cloud.elastic.co/projects)
2. Open the project in Kibana under `https://<your-kibana-host>/app/management/security/api_keys`
3. Go to **API keys** and create a key with additional security priviledge by pasting `role_descriptors` (see "Example Usage")
4. Use that value as `ELASTICSEARCH_API_KEY_<PROFILE>`


### Install

```bash
npm install
```

### Bootstrap

Before running the assistant, run bootstrap. It:
- processes **`.mdx`** files only
- chunks content into `500`-character segments
- runs in reset mode by deleting and recreating `elasticsearchfs-chunks` and `elasticsearchfs-meta` on every run
- uses `createESClient("SYSTEM")` for ingest
- reads content from `./data`
- reads path tree policy from `./data/path_tree.json`

For bootstrap, set `ELASTICSEARCH_API_KEY_SYSTEM` to your ingestion key.

```bash
npm run bootstrap
```

Path tree policy shape:

```json
{
  "auth/oauth": { "isPublic": true, "groups": [] },
  "auth/api-keys": { "isPublic": true, "groups": [] },
  "internal/billing": { "isPublic": false, "groups": ["internal", "billing"] },
  "api-reference/payments": { "isPublic": false, "groups": ["billing"] }
}
```

### Tests

End-to-end tests ([Vitest](https://vitest.dev/)) call Elasticsearch through profile-specific API keys. Set **`ELASTICSEARCH_URL`** and the required profile keys in `.env` (`ELASTICSEARCH_API_KEY_PUBLIC`, `ELASTICSEARCH_API_KEY_BILLING`, `ELASTICSEARCH_API_KEY_INTERNAL`).

```bash
npm test
```

### just-bash quickstarts

After ingest and `.env` are set, you can smoke-test **grep + cat** with just-bash:

```bash
# Local ./data on disk (ReadWriteFs) — no Elasticsearch
npx tsx scripts/just-bash-examples-quickstart.ts

# ElasticsearchFs via session init (`initSessionTree`)
npx tsx scripts/just-bash-elasticsearchfs-quickstart.ts PUBLIC
```


### Test Coverage

Current tests:

- `tests/e2e/bash-commands.test.ts` validates command behavior (`pwd`, `cd`, `ls`, `cat`, `find`) through `just-bash` on `ElasticsearchFs`.
- `tests/e2e/grep.test.ts` validates `grep` end-to-end behavior including recursive searches and regex vs fixed-string matching.
- `tests/e2e/permissions.test.ts` validates profile visibility and explicit allowed/denied path access across `PUBLIC`, `BILLING`, `INTERNAL`, and `SYSTEM`.
- `tests/unit/grep-core.test.ts` keeps a small fast unit layer for grep parser/predicate helpers.
- `tests/unit/elasticsearchfs-pagination.test.ts` validates `search_after` pagination behavior used by coarse grep search.

Generate an end-to-end command report (expected vs actual command output):

```bash
npm run test:report
```

Artifacts are written to:
- `reports/e2e-command-report.jsonl`
- `reports/e2e-command-report.md`
- `reports/e2e-command-report-summary.json`
- `reports/vitest-results.json` (used to include skipped-test overview)

These `reports/` artifacts are generated locally and ignored by Git.

Project sequencing note: comprehensive end-to-end/contract testing is treated as the **final step** before declaring v1 scope complete.


# Example Usage

In the folder /data you will find a minimal sample dataset, including a path-tree.json file.


`PUBLIC`:

```json
{
  "PUBLIC": {
    "cluster": [],
    "indices": [
      {
        "names": ["elasticsearchfs-chunks"],
        "privileges": ["read"],
        "query": {
          "bool": {
            "should": [
              { "prefix": { "slug": "auth/" } },
              { "prefix": { "slug": "api-reference/search-use-case/" } },
              { "term": { "slug": "api-reference/users" } }
            ],
            "minimum_should_match": 1
          }
        }
      },
      {
        "names": ["elasticsearchfs-meta"],
        "privileges": ["read"]
      }
    ]
  }
}
```

`BILLING` (public content + billing content):

```json
{
  "BILLING": {
    "cluster": [],
    "indices": [
      {
        "names": ["elasticsearchfs-chunks"],
        "privileges": ["read"],
        "query": {
          "bool": {
            "should": [
              { "prefix": { "slug": "auth/" } },
              { "prefix": { "slug": "api-reference/search-use-case/" } },
              { "term": { "slug": "api-reference/users" } },
              { "term": { "slug": "api-reference/payments" } },
              { "term": { "slug": "internal/billing" } }
            ],
            "minimum_should_match": 1
          }
        }
      },
      {
        "names": ["elasticsearchfs-meta"],
        "privileges": ["read"]
      }
    ]
  }
}
```

`INTERNAL` (public content + internal content):

```json
{
  "INTERNAL": {
    "cluster": [],
    "indices": [
      {
        "names": ["elasticsearchfs-chunks"],
        "privileges": ["read"],
        "query": {
          "bool": {
            "should": [
              { "prefix": { "slug": "auth/" } },
              { "prefix": { "slug": "api-reference/search-use-case/" } },
              { "term": { "slug": "api-reference/users" } },
              { "prefix": { "slug": "internal/" } }
            ],
            "minimum_should_match": 1
          }
        }
      },
      {
        "names": ["elasticsearchfs-meta"],
        "privileges": ["read"]
      }
    ]
  }
}
```
import { Bash, defineCommand } from 'just-bash';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { ElasticsearchFs } from '../../src/core/elasticsearchfs.js';
import { runElasticGrep } from '../../src/core/grep.js';
import { createESClient } from '../../src/es-adapter/client.js';
import { initSessionTree } from '../../src/session.js';
import type {
  CommandCaseRecord,
  CommandExpectation,
  Profile,
} from '../e2e-report-types.js';

const E2E_REPORT_JSONL_PATH = resolve(process.cwd(), 'reports/e2e-command-report.jsonl');
for (const line of readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [key, value] = line.split('=', 2);
  if (key?.startsWith('ELASTICSEARCH_') && value) process.env[key] = value;
}

const globalState = globalThis as typeof globalThis & { __elasticsearchfsReportInitialized?: boolean };
if (!globalState.__elasticsearchfsReportInitialized) {
  mkdirSync(resolve(process.cwd(), 'reports'), { recursive: true });
  writeFileSync(E2E_REPORT_JSONL_PATH, '', 'utf8');
  globalState.__elasticsearchfsReportInitialized = true;
}

interface ElasticSession {
  client: ReturnType<typeof createESClient>;
  fs: ElasticsearchFs;
}

type CommandCase = {
  suite: string;
  test: string;
  profile: Profile;
  command: string;
  expected: CommandExpectation;
};

export function hasProfileEnv(profile: Profile): boolean {
  return Boolean(process.env.ELASTICSEARCH_URL && process.env[`ELASTICSEARCH_API_KEY_${profile}`]);
}

export function hasProfilesEnv(profiles: readonly Profile[]): boolean {
  return profiles.every((profile) => hasProfileEnv(profile));
}


export async function createElasticSession(profile: Profile): Promise<ElasticSession> {
  const client = createESClient(profile);
  const session = await initSessionTree(client, profile);
  const fs = new ElasticsearchFs({
    client,
    files: session.files,
    dirs: session.dirs,
  });
  return { client, fs };
}

export async function createBashSession(profile: Profile): Promise<ElasticSession & { bash: Bash }> {
  const { client, fs } = await createElasticSession(profile);
  const grep = defineCommand('grep', async (args, ctx) => runElasticGrep(args, ctx, fs));
  const bash = new Bash({ fs, cwd: '/', customCommands: [grep] });
  return { client, fs, bash };
}

function runContainsChecks(label: string, value: string, needles: string[]): string[] {
  const failures: string[] = [];
  for (const needle of needles) {
    if (!value.includes(needle)) {
      failures.push(`${label} missing expected snippet: ${JSON.stringify(needle)}`);
    }
  }
  return failures;
}

function appendCommandCaseRecord(record: CommandCaseRecord): void {
  appendFileSync(E2E_REPORT_JSONL_PATH, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function assertCommandCase(
  bash: Bash,
  testCase: CommandCase,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const actual = await bash.exec(testCase.command);
  const failures: string[] = [];

  if (actual.exitCode !== testCase.expected.exitCode) {
    failures.push(
      `exitCode mismatch: expected ${testCase.expected.exitCode}, got ${actual.exitCode}`,
    );
  }
  if (testCase.expected.stdoutExact !== undefined && actual.stdout !== testCase.expected.stdoutExact) {
    failures.push('stdout exact mismatch');
  }
  if (testCase.expected.stderrExact !== undefined && actual.stderr !== testCase.expected.stderrExact) {
    failures.push('stderr exact mismatch');
  }
  if (testCase.expected.stdoutContains) {
    failures.push(...runContainsChecks('stdout', actual.stdout, testCase.expected.stdoutContains));
  }
  if (testCase.expected.stderrContains) {
    failures.push(...runContainsChecks('stderr', actual.stderr, testCase.expected.stderrContains));
  }

  appendCommandCaseRecord({
    suite: testCase.suite,
    test: testCase.test,
    profile: testCase.profile,
    command: testCase.command,
    expected: testCase.expected,
    actual: {
      exitCode: actual.exitCode,
      stdout: actual.stdout,
      stderr: actual.stderr,
    },
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    createdAt: new Date().toISOString(),
  });

  expect(failures).toEqual([]);
  return actual;
}

/**
 * Conditionally run a describe block with a SYSTEM bash session, skipping when
 * the SYSTEM profile env vars are absent. Registers beforeAll/afterAll for the
 * session lifecycle. Use `ctx.bash` inside `it` callbacks.
 */
export function describeSystemBash(
  suite: string,
  tests: (ctx: { bash: Bash }) => void,
): void {
  const run = hasProfilesEnv(['SYSTEM']) ? describe : describe.skip;
  run(suite, () => {
    const ctx = {} as { bash: Bash };
    let closeClient: (() => Promise<void>) | null = null;

    beforeAll(async () => {
      const session = await createBashSession('SYSTEM');
      ctx.bash = session.bash;
      closeClient = async () => session.client.close();
    });

    afterAll(async () => {
      await closeClient?.();
    });

    tests(ctx);
  });
}

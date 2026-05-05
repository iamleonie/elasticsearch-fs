import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  CommandCaseRecord,
  CommandExpectation,
} from '../tests/e2e-report-types.js';

type VitestAssertion = {
  ancestorTitles?: string[];
  title?: string;
  fullName?: string;
  status?: string;
};

type VitestSuiteResult = {
  name?: string;
  assertionResults?: VitestAssertion[];
};

type VitestReport = {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: VitestSuiteResult[];
};

const jsonlPath = resolve(process.cwd(), 'reports/e2e-command-report.jsonl');
const markdownPath = resolve(process.cwd(), 'reports/e2e-command-report.md');
const summaryPath = resolve(
  process.cwd(),
  'reports/e2e-command-report-summary.json',
);
const vitestResultsPath = resolve(process.cwd(), 'reports/vitest-results.json');

type OverviewRow = {
  id: string;
  displayId?: string;
  suite: string;
  test: string;
  profile: string;
  command: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  source: 'command-case' | 'vitest-assertion';
  record?: CommandCaseRecord;
  vitestFile?: string;
  vitestStatus?: string;
};

type OverviewRowsBySuite = Array<{ suite: string; rows: OverviewRow[] }>;

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, '<br>').replace(/\r/g, '');
}

function clip(text: string, max = 140): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatStatusCell(status: OverviewRow['status']): string {
  const styles: Record<
    OverviewRow['status'],
    { background: string; color: string }
  > = {
    PASSED: { background: '#d1fae5', color: '#065f46' },
    FAILED: { background: '#fee2e2', color: '#991b1b' },
    SKIPPED: { background: '#e5e7eb', color: '#374151' },
  };
  const style = styles[status];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-weight:600;background-color:${style.background};color:${style.color};">${status}</span>`;
}

function toCodeBlock(text: string): string {
  if (text.length === 0) return '`(empty)`';
  return `\`\`\`\n${text}\n\`\`\``;
}

function expectedStatusForRow(row: OverviewRow): OverviewRow['status'] {
  if (row.source === 'command-case') {
    return row.record?.expected.exitCode === 0 ? 'PASSED' : 'FAILED';
  }
  return 'PASSED';
}

function formatExpectation(expected: CommandExpectation): string {
  const parts: string[] = [`- exitCode: ${expected.exitCode}`];
  if (expected.stdoutContains && expected.stdoutContains.length > 0) {
    parts.push(`- stdoutContains: ${JSON.stringify(expected.stdoutContains)}`);
  }
  if (expected.stdoutExact !== undefined) {
    parts.push(`- stdoutExact: ${JSON.stringify(expected.stdoutExact)}`);
  }
  if (expected.stderrContains && expected.stderrContains.length > 0) {
    parts.push(`- stderrContains: ${JSON.stringify(expected.stderrContains)}`);
  }
  if (expected.stderrExact !== undefined) {
    parts.push(`- stderrExact: ${JSON.stringify(expected.stderrExact)}`);
  }
  return parts.join('\n');
}

function parseRecords(): CommandCaseRecord[] {
  try {
    const raw = readFileSync(jsonlPath, 'utf8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.map((line) => JSON.parse(line) as CommandCaseRecord);
  } catch {
    return [];
  }
}

function parseVitestReport(): VitestReport | null {
  try {
    const raw = readFileSync(vitestResultsPath, 'utf8');
    return JSON.parse(raw) as VitestReport;
  } catch {
    return null;
  }
}

function slugifyId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function cleanSuiteName(suite: string): string {
  return suite.replace(/\s+\(([A-Z_,\s-]+)\)$/u, '').trim();
}

function resolveVitestMetadata(
  suite: string,
  test: string,
): { profile: string; command: string } {
  const cleanedSuite = cleanSuiteName(suite);
  if (cleanedSuite === 'grep e2e') {
    const grepCommands: Record<string, string> = {
      'supports grep -ri "access_token" /': 'grep -ri "access_token" /',
      'supports grep -ri "webhook" /': 'grep -ri "webhook" /',
      'supports grep -ri "billing" /': 'grep -ri "billing" /',
      'distinguishes regex matching from fixed-string matching':
        'grep -r "access.token" /auth; grep -rF "access.token" /auth',
      'returns grep parse/runtime errors with exit code 2': 'grep -r "(" /auth',
    };
    return {
      profile: 'SYSTEM',
      command: grepCommands[test] ?? '-',
    };
  }

  if (cleanedSuite === 'bash commands e2e') {
    const bashCommands: Record<string, string> = {
      'supports pwd and cd': 'pwd; cd /auth; pwd',
      'lists visible entries with ls': 'ls /',
      'reads public files with cat': 'cat /auth/oauth.mdx',
      'reads internal files with system profile': 'cat /internal/audit-log.mdx',
      'find enumerates files under a directory': 'find /auth -type f',
    };
    return {
      profile: 'SYSTEM',
      command: bashCommands[test] ?? '-',
    };
  }

  if (cleanedSuite === 'permissions e2e') {
    if (test.includes('for PUBLIC'))
      return { profile: 'PUBLIC', command: 'fs.getVisibleFilePaths()' };
    if (test.includes('for BILLING'))
      return { profile: 'BILLING', command: 'fs.getVisibleFilePaths()' };
    if (test.includes('for INTERNAL'))
      return { profile: 'INTERNAL', command: 'fs.getVisibleFilePaths()' };
    if (test.includes('for SYSTEM'))
      return { profile: 'SYSTEM', command: 'fs.getVisibleFilePaths()' };
    const deniedMatch = test.match(
      /^denies\s+'?([A-Z]+)'?\s+access to\s+'?(.+?)'?$/u,
    );
    if (deniedMatch) {
      return {
        profile: deniedMatch[1] ?? '-',
        command: `cat ${deniedMatch[2] ?? 'path'} -> ENOENT`,
      };
    }
    const allowedMatch = test.match(
      /^allows\s+'?([A-Z]+)'?\s+access to\s+'?(.+?)'?$/u,
    );
    if (allowedMatch) {
      return {
        profile: allowedMatch[1] ?? '-',
        command: `cat ${allowedMatch[2] ?? 'path'} -> contains marker`,
      };
    }
  }

  return { profile: '-', command: '-' };
}

function collectVitestAssertions(vitestReport: VitestReport | null): Array<{
  file: string;
  suite: string;
  test: string;
  status: string;
}> {
  if (!vitestReport?.testResults) return [];
  const assertions: Array<{
    file: string;
    suite: string;
    test: string;
    status: string;
  }> = [];
  for (const suiteResult of vitestReport.testResults) {
    const file = suiteResult.name ?? '(unknown)';
    for (const assertion of suiteResult.assertionResults ?? []) {
      const suite =
        Array.isArray(assertion.ancestorTitles) &&
        assertion.ancestorTitles.length > 0
          ? assertion.ancestorTitles.join(' > ')
          : '(no suite)';
      assertions.push({
        file,
        suite,
        test: assertion.title ?? assertion.fullName ?? '(unknown test)',
        status: assertion.status ?? 'unknown',
      });
    }
  }
  return assertions;
}

function buildOverviewRows(
  commandRecords: CommandCaseRecord[],
  vitestAssertions: Array<{
    file: string;
    suite: string;
    test: string;
    status: string;
  }>,
): OverviewRow[] {
  const rows: OverviewRow[] = [];
  const seen = new Set<string>();

  for (const record of commandRecords) {
    const key = `${record.suite}::${record.test}`;
    seen.add(key);
    const cleanedSuite = cleanSuiteName(record.suite);
    rows.push({
      id: `case-${slugifyId(`${record.suite}-${record.test}-${record.createdAt}`)}`,
      suite: cleanedSuite,
      test: record.test,
      profile: record.profile,
      command: record.command,
      status: record.status === 'passed' ? 'PASSED' : 'FAILED',
      source: 'command-case',
      record,
    });
  }

  for (const assertion of vitestAssertions) {
    const key = `${assertion.suite}::${assertion.test}`;
    if (seen.has(key)) continue;
    const cleanedSuite = cleanSuiteName(assertion.suite);
    const meta = resolveVitestMetadata(assertion.suite, assertion.test);
    const statusMap: Record<string, 'PASSED' | 'FAILED' | 'SKIPPED'> = {
      passed: 'PASSED',
      failed: 'FAILED',
      skipped: 'SKIPPED',
    };
    rows.push({
      id: `case-${slugifyId(`${assertion.suite}-${assertion.test}-${assertion.status}`)}`,
      suite: cleanedSuite,
      test: assertion.test,
      profile: meta.profile,
      command: meta.command,
      status: statusMap[assertion.status] ?? 'SKIPPED',
      source: 'vitest-assertion',
      vitestFile: assertion.file,
      vitestStatus: assertion.status,
    });
  }

  return rows;
}

function groupOverviewRowsBySuite(rows: OverviewRow[]): OverviewRowsBySuite {
  const grouped = new Map<string, OverviewRow[]>();
  const order: string[] = [];
  for (const row of rows) {
    let bucket = grouped.get(row.suite);
    if (!bucket) {
      bucket = [];
      grouped.set(row.suite, bucket);
      order.push(row.suite);
    }
    bucket.push(row);
  }
  return order.map((suite) => ({ suite, rows: grouped.get(suite) ?? [] }));
}

function main(): void {
  mkdirSync(resolve(process.cwd(), 'reports'), { recursive: true });
  const records = parseRecords();
  const vitestReport = parseVitestReport();
  const vitestAssertions = collectVitestAssertions(vitestReport);
  const skippedTests = vitestAssertions.filter((a) => a.status === 'skipped');
  const overviewRows = buildOverviewRows(records, vitestAssertions).map(
    (row, i) => ({
      ...row,
      displayId: `T${String(i + 1).padStart(3, '0')}`,
    }),
  );
  const overviewRowsBySuite = groupOverviewRowsBySuite(overviewRows);

  const passed = records.filter((record) => record.status === 'passed').length;
  const failed = records.filter((record) => record.status === 'failed').length;
  const suites = [...new Set(records.map((record) => record.suite))];

  const markdown: string[] = [];
  markdown.push('# E2E Command Test Report');
  markdown.push('');
  markdown.push(`- Generated at: ${new Date().toISOString()}`);
  markdown.push(`- Command cases run: ${records.length}`);
  markdown.push(`- Passed: ${passed}`);
  markdown.push(`- Failed: ${failed}`);
  markdown.push(`- Skipped: ${skippedTests.length}`);
  markdown.push(
    `- Suites: ${suites.length > 0 ? suites.join(', ') : '(none)'}`,
  );
  if (vitestReport) {
    markdown.push(
      `- Vitest totals: total=${vitestReport.numTotalTests ?? 0}, passed=${vitestReport.numPassedTests ?? 0}, failed=${vitestReport.numFailedTests ?? 0}, skipped=${vitestReport.numPendingTests ?? 0}`,
    );
  } else {
    markdown.push('- Vitest totals: unavailable (run `npm run test:report`)');
  }
  markdown.push('');

  if (records.length === 0) {
    markdown.push(
      'No command cases were recorded. This usually means E2E tests were skipped.',
    );
  }
  markdown.push('');
  if (overviewRows.length > 0) {
    markdown.push('## Overview');
    markdown.push('');
    for (const group of overviewRowsBySuite) {
      markdown.push(`### ${group.suite}`);
      markdown.push('');
      markdown.push('| ID | Test | Profile | Command | Status |');
      markdown.push('|---|---|---|---|---|');
      for (const row of group.rows) {
        markdown.push(
          `| [${row.displayId}](#${row.id}) | ${escapeTableCell(row.test)} | ${escapeTableCell(row.profile)} | \`${escapeTableCell(clip(row.command, 70))}\` | ${formatStatusCell(row.status)} |`,
        );
      }
      markdown.push('');
    }
  }

  markdown.push('## Test Details');
  markdown.push('');
  for (const row of overviewRows) {
    const expectedStatus = expectedStatusForRow(row);
    markdown.push(`<a id="${row.id}"></a>`);
    markdown.push(`### ${row.displayId} — ${row.suite} :: ${row.test}`);
    markdown.push('');
    markdown.push(`- Status: ${row.status}`);
    markdown.push(`- Expected result: ${expectedStatus}`);
    markdown.push(`- Actual result: ${row.status}`);
    markdown.push(`- Profile: ${row.profile}`);
    markdown.push(`- Command: \`${row.command}\``);
    if (row.source === 'vitest-assertion' && row.vitestFile) {
      markdown.push(`- File: \`${row.vitestFile}\``);
      markdown.push(`- Vitest status: ${row.vitestStatus ?? 'unknown'}`);
    }
    markdown.push('');
    if (row.source === 'command-case' && row.record) {
      const record = row.record;
      markdown.push(`- Timestamp: ${record.createdAt}`);
      markdown.push('');
      markdown.push('### Expected');
      markdown.push('');
      markdown.push(formatExpectation(record.expected));
      markdown.push('');
      markdown.push('### Actual');
      markdown.push('');
      markdown.push(`- exitCode: ${record.actual.exitCode}`);
      markdown.push('- stdout:');
      markdown.push(toCodeBlock(record.actual.stdout));
      markdown.push('- stderr:');
      markdown.push(toCodeBlock(record.actual.stderr));
      markdown.push('');
      if (record.failures.length > 0) {
        markdown.push('### Failures');
        markdown.push('');
        for (const failure of record.failures) {
          markdown.push(`- ${failure}`);
        }
        markdown.push('');
      }
    } else {
      markdown.push('### Expected');
      markdown.push('');
      markdown.push(`- status: ${expectedStatus}`);
      markdown.push('- note: test should pass in a successful run');
      markdown.push('');
      markdown.push('### Actual');
      markdown.push('');
      markdown.push(`- status: ${row.status}`);
      markdown.push(`- vitestStatus: ${row.vitestStatus ?? 'unknown'}`);
      if (row.status === 'SKIPPED') {
        markdown.push(
          '- note: this test was skipped by Vitest in the last run',
        );
      } else {
        markdown.push(
          '- note: this test result comes from Vitest status metadata',
        );
      }
      markdown.push('');
    }
  }

  writeFileSync(markdownPath, markdown.join('\n'), 'utf8');
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: records.length,
        passed,
        failed,
        suites,
        sourceJsonlPath: jsonlPath,
        vitestResultsPath,
        vitest: vitestReport
          ? {
              total: vitestReport.numTotalTests ?? 0,
              passed: vitestReport.numPassedTests ?? 0,
              failed: vitestReport.numFailedTests ?? 0,
              skipped: vitestReport.numPendingTests ?? 0,
            }
          : null,
        skippedTests: skippedTests.map((s) => ({
          suite: s.suite,
          test: s.test,
          file: s.file,
        })),
        vitestAssertionsCount: vitestAssertions.length,
        overviewRows: overviewRows.map((row) => ({
          id: row.id,
          displayId: row.displayId,
          suite: row.suite,
          test: row.test,
          profile: row.profile,
          command: row.command,
          status: row.status,
          source: row.source,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`Wrote ${markdownPath}`);
  console.log(`Wrote ${summaryPath}`);
}

main();

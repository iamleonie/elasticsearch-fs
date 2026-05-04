/**
 * Two-stage `grep` for just-bash over ElasticsearchFs: coarse + fine in-memory match.
 */

import type { CommandContext, ExecResult } from 'just-bash';
import yargsParser from 'yargs-parser';
import type { ElasticsearchFs } from './elasticsearchfs.js';
import { normalizePath, slugToPath } from './path-tree.js';

/** Returns true if the string contains any regex metacharacters (used to decide whether to treat a pattern as literal or regex). */
export function hasRegexMeta(pattern: string): boolean {
  return /[\\^$.*+?()[\]{}|]/.test(pattern);
}

/** Escapes all regex metacharacters in `value` so it can be embedded safely in a `RegExp` as a literal string. */
export function escapeRegexpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- argv (yargs-parser) ---

interface ParsedGrepArgv {
  pattern: string;
  fileArgs: string[];
  ignoreCase: boolean;
  recursive: boolean;
  filesWithMatches: boolean;
  lineNumber: boolean;
  fixedStrings: boolean;
  invertMatch: boolean;
  quiet: boolean;
}

/**
 * Parse `grep` argv (command name already stripped).
 * Supports `grep [flags] pattern [files...]` and `grep [flags] -e pattern [files...]`.
 */
export function parseGrepArgv(
  args: string[],
  defaultFixedStrings?: boolean,
): ParsedGrepArgv {
  const parsed = yargsParser(args, {
    configuration: {
      'short-option-groups': true,
      'camel-case-expansion': false,
      'unknown-options-as-args': true,
    },
    boolean: [
      'i',
      'ignore-case',
      'r',
      'R',
      'recursive',
      'l',
      'files-with-matches',
      'n',
      'line-number',
      'F',
      'fixed-strings',
      'v',
      'invert-match',
      'q',
      'quiet',
    ],
    string: ['e'],
    alias: {
      'ignore-case': 'i',
      recursive: ['r', 'R'],
      'files-with-matches': 'l',
      'line-number': 'n',
      'fixed-strings': 'F',
      'invert-match': 'v',
      quiet: 'q',
    },
  });

  const fixedStrings = Boolean(parsed.F ?? defaultFixedStrings);

  const hasExplicitPattern = typeof parsed.e === 'string' && parsed.e !== '';

  let pattern: string | undefined;
  const pos = parsed._ as string[];
  if (hasExplicitPattern) {
    pattern = parsed.e;
  } else if (pos.length > 0) {
    pattern = pos[0];
  }

  const fileArgs = hasExplicitPattern ? pos : pos.slice(1);

  if (pattern === undefined || pattern === '') {
    throw new Error('grep: missing pattern');
  }

  return {
    pattern,
    fileArgs,
    ignoreCase: Boolean(parsed.i),
    recursive: Boolean(parsed.r ?? parsed.R ?? parsed.recursive),
    filesWithMatches: Boolean(parsed.l),
    lineNumber: Boolean(parsed.n),
    fixedStrings,
    invertMatch: Boolean(parsed.v),
    quiet: Boolean(parsed.q),
  };
}

/**
 * Resolve CLI path arguments to vfs file paths for grep.
 * Directories require `-r` / `-R` / `--recursive` (matches GNU grep).
 */
async function listVfsFilesForGrep(
  fs: ElasticsearchFs,
  cwd: string,
  fileArgs: string[],
  recursive: boolean,
): Promise<
  | { ok: true; vfsPaths: string[] }
  | { ok: false; stderr: string; exitCode: number }
> {
  const roots = fileArgs.length > 0 ? fileArgs : ['.'];
  const out = new Set<string>();
  const allFiles = fs.getVisibleFilePaths();

  for (const r of roots) {
    const abs = normalizePath(fs.resolvePath(cwd, r));
    if (!(await fs.exists(abs))) {
      return {
        ok: false,
        stderr: `grep: ${r}: No such file or directory\n`,
        exitCode: 2,
      };
    }
    const st = await fs.stat(abs);
    if (st.isFile) {
      out.add(abs);
      continue;
    }
    if (st.isDirectory) {
      if (!recursive) {
        return {
          ok: false,
          stderr: `grep: ${r}: Is a directory\n`,
          exitCode: 2,
        };
      }
      const prefix = abs;
      for (const fp of allFiles) {
        if (prefix === '/' || fp === prefix || fp.startsWith(`${prefix}/`)) {
          out.add(fp);
        }
      }
    }
  }

  return { ok: true, vfsPaths: [...out].sort() };
}

/**
 * Builds a per-line match function from grep pattern options.
 * Handles `fixedStrings` (literal match), `ignoreCase`, and `invertMatch` modes.
 */
export function buildLinePredicate(
  pattern: string,
  opts: {
    fixedStrings: boolean;
    ignoreCase: boolean;
    invertMatch: boolean;
  },
): (line: string) => boolean {
  let test: (line: string) => boolean;

  if (opts.fixedStrings) {
    const needle = opts.ignoreCase ? pattern.toLowerCase() : pattern;
    test = (line) => {
      const h = opts.ignoreCase ? line.toLowerCase() : line;
      return h.includes(needle);
    };
  } else {
    const flags = opts.ignoreCase ? 'imu' : 'mu';
    const re = new RegExp(pattern, flags);
    test = (line) => re.test(line);
  }

  if (!opts.invertMatch) return test;
  return (line) => !test(line);
}

interface GrepLineHit {
  lineNo: number;
  line: string;
}

/** Runs `predicate` against each line of `content` and returns 1-indexed line numbers with the matching text. */
function findMatchingLines(
  content: string,
  predicate: (line: string) => boolean,
): GrepLineHit[] {
  const lines = content.split(/\r?\n/u);
  const out: GrepLineHit[] = [];
  for (const [i, line] of lines.entries()) {
    if (predicate(line)) {
      out.push({ lineNo: i + 1, line });
    }
  }
  return out;
}

/**
 * Formats grep hits as a string following GNU grep output conventions.
 * In `filesWithMatches` mode returns only the path; otherwise formats each hit as
 * `[path:][lineNo:]line`, prefixing the path only when `multiFile` is true.
 */
export function formatGrepOutput(
  vfsPath: string,
  hits: GrepLineHit[],
  opts: {
    filesWithMatches: boolean;
    lineNumber: boolean;
    multiFile: boolean;
  },
): string {
  if (opts.filesWithMatches) {
    return hits.length > 0 ? `${vfsPath}\n` : '';
  }
  let buf = '';
  for (const h of hits) {
    if (opts.multiFile) {
      buf += opts.lineNumber
        ? `${vfsPath}:${h.lineNo}:${h.line}\n`
        : `${vfsPath}:${h.line}\n`;
    } else {
      buf += opts.lineNumber ? `${h.lineNo}:${h.line}\n` : `${h.line}\n`;
    }
  }
  return buf;
}

/**
 * Fine stage: in-memory line match over `readFile`
 * (no stock just-bash `grep` builtin; that would recurse into our custom command).
 */
async function execBuiltin(
  parsed: ParsedGrepArgv,
  vfsPaths: string[],
  fs: ElasticsearchFs,
  forceMultiFileOutput = false,
): Promise<ExecResult> {
  if (vfsPaths.length === 0) {
    return { stdout: '', stderr: '', exitCode: 1 };
  }

  let predicate: (line: string) => boolean;
  try {
    predicate = buildLinePredicate(parsed.pattern, {
      fixedStrings: parsed.fixedStrings,
      ignoreCase: parsed.ignoreCase,
      invertMatch: parsed.invertMatch,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      stdout: '',
      stderr: `grep: invalid regular expression: ${msg}\n`,
      exitCode: 2,
    };
  }

  let stdout = '';
  let matchedAny = false;

  for (const vfsPath of vfsPaths) {
    try {
      const text = await fs.readFile(vfsPath);
      const hits = findMatchingLines(text, predicate);
      if (hits.length > 0) {
        matchedAny = true;
        if (parsed.quiet) {
          break;
        }
        stdout += formatGrepOutput(vfsPath, hits, {
          filesWithMatches: parsed.filesWithMatches,
          lineNumber: parsed.lineNumber,
          multiFile: forceMultiFileOutput || vfsPaths.length > 1,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { stdout: '', stderr: `grep: ${vfsPath}: ${msg}\n`, exitCode: 2 };
    }
  }

  return { stdout, stderr: '', exitCode: matchedAny ? 0 : 1 };
}

/**
 * Two-stage ElasticsearchFs `grep` implementation for use with `defineCommand('grep', …)` (see
 * `scripts/just-bash-elasticsearchfs-quickstart.ts`).
 */
export async function runElasticGrep(
  args: string[],
  ctx: CommandContext,
  elasticsearchFs: ElasticsearchFs,
): Promise<ExecResult> {
  let grepArgv: ParsedGrepArgv;
  try {
    grepArgv = parseGrepArgv(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { stdout: '', stderr: `${msg}\n`, exitCode: 2 };
  }

  const scope = await listVfsFilesForGrep(
    elasticsearchFs,
    ctx.cwd,
    grepArgv.fileArgs,
    grepArgv.recursive,
  );

  if (!scope.ok) {
    return { stdout: '', stderr: scope.stderr, exitCode: scope.exitCode };
  }

  const vfsPaths = scope.vfsPaths;
  if (vfsPaths.length === 0) {
    return { stdout: '', stderr: '', exitCode: 1 };
  }
  const shouldPrefixFilePath = vfsPaths.length > 1;

  const slugsUnderDirs = vfsPaths
    .map((p) => elasticsearchFs.getFileSlug(p))
    .filter((s): s is string => s !== null);
  const coarseFilter = {
    pattern: grepArgv.pattern,
    ignoreCase: grepArgv.ignoreCase,
    fixedStrings: grepArgv.fixedStrings,
  };
  const isRegexPattern =
    !grepArgv.fixedStrings && hasRegexMeta(grepArgv.pattern);

  let matchedSlugs: string[];
  try {
    matchedSlugs = await elasticsearchFs.findMatchingFiles(
      coarseFilter,
      slugsUnderDirs,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return isRegexPattern
      ? {
          stdout: '',
          stderr: `grep: invalid regular expression: ${msg}\n`,
          exitCode: 2,
        }
      : { stdout: '', stderr: `grep: ${msg}\n`, exitCode: 2 };
  }
  if (matchedSlugs.length === 0) return { stdout: '', stderr: '', exitCode: 1 };

  // TODO: await elasticsearchFs.bulkPrefetch(matchedSlugs);

  const matchedPaths = matchedSlugs.map((slug) => slugToPath(slug));

  return execBuiltin(
    grepArgv,
    matchedPaths,
    elasticsearchFs,
    shouldPrefixFilePath,
  );
}

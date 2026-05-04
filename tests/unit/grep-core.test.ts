import { describe, expect, it } from 'vitest';
import {
  buildLinePredicate,
  formatGrepOutput,
  parseGrepArgv,
} from '../../src/core/grep.js';

describe('grep core helpers', () => {
  it('parses pattern and files', () => {
    const p = parseGrepArgv(['-i', 'foo', '/a', '/b']);
    expect(p.pattern).toBe('foo');
    expect(p.fileArgs).toEqual(['/a', '/b']);
    expect(p.ignoreCase).toBe(true);
  });

  it('parses -e pattern and inherited defaults', () => {
    const p = parseGrepArgv(['-e', 'bar', '/x'], true);
    expect(p.pattern).toBe('bar');
    expect(p.fileArgs).toEqual(['/x']);
    expect(p.fixedStrings).toBe(true);
  });

  it('matches fixed strings and regex patterns', () => {
    const fixed = buildLinePredicate('token', {
      fixedStrings: true,
      ignoreCase: false,
      invertMatch: false,
    });
    expect(fixed('contains token')).toBe(true);
    expect(fixed('contains tok.en')).toBe(false);

    const regex = buildLinePredicate('t.ke.', {
      fixedStrings: false,
      ignoreCase: false,
      invertMatch: false,
    });
    expect(regex('contains token')).toBe(true);
  });

  it('throws on invalid regex', () => {
    expect(() =>
      buildLinePredicate('(', {
        fixedStrings: false,
        ignoreCase: false,
        invertMatch: false,
      }),
    ).toThrow();
  });

  it('formats multi-file line-number output', () => {
    const out = formatGrepOutput('/f.mdx', [{ lineNo: 2, line: 'hello' }], {
      filesWithMatches: false,
      lineNumber: true,
      multiFile: true,
    });
    expect(out).toBe('/f.mdx:2:hello\n');
  });
});

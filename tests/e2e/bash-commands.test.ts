import { it } from 'vitest';
import { assertCommandCase, describeSystemBash } from './helpers.js';

const SUITE = 'bash commands e2e (SYSTEM)';

describeSystemBash(SUITE, (ctx) => {
  it('supports pwd and cd', async () => {
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'supports pwd and cd (pwd at root)',
      profile: 'SYSTEM',
      command: 'pwd',
      expected: { exitCode: 0, stdoutContains: ['/'] },
    });
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'supports pwd and cd (cd /auth && pwd)',
      profile: 'SYSTEM',
      command: 'cd /auth && pwd',
      expected: { exitCode: 0, stdoutContains: ['/auth'] },
    });
  });

  it('lists visible entries with ls', async () => {
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'lists visible entries with ls',
      profile: 'SYSTEM',
      command: 'ls /',
      expected: {
        exitCode: 0,
        stdoutContains: ['auth', 'api-reference'],
      },
    });
  });

  it('reads public files with cat', async () => {
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'reads public files with cat',
      profile: 'SYSTEM',
      command: 'cat /auth/oauth.mdx',
      expected: {
        exitCode: 0,
        stdoutContains: ['# OAuth'],
      },
    });
  });

  it('reads internal files with system profile', async () => {
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'reads internal files with system profile',
      profile: 'SYSTEM',
      command: 'cat /internal/audit-log.mdx',
      expected: {
        exitCode: 0,
        stdoutContains: ['# Audit log'],
      },
    });
  });

  it('find enumerates files under a directory', async () => {
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'find enumerates files under a directory',
      profile: 'SYSTEM',
      command: 'find /auth -type f',
      expected: {
        exitCode: 0,
        stdoutContains: ['/auth/oauth.mdx', '/auth/api-keys.mdx'],
      },
    });
  });
});

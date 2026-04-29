import { it } from 'vitest';
import { assertCommandCase, describeSystemBash } from './helpers.js';

const SUITE = 'grep e2e (SYSTEM)';

describeSystemBash(SUITE, (ctx) => {
  it('supports grep -ri "access_token" /', async () => {
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'supports grep -ri "access_token" /',
      profile: 'SYSTEM',
      command: 'grep -ri "access_token" /',
      expected: {
        exitCode: 0,
        stdoutContains: ['/auth/oauth.mdx', '/api-reference/users.mdx'],
      },
    });
  });

  it('supports grep -ri "webhook" /', async () => {
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'supports grep -ri "webhook" /',
      profile: 'SYSTEM',
      command: 'grep -ri "webhook" /',
      expected: {
        exitCode: 0,
        stdoutContains: ['Verify webhook signatures'],
      },
    });
  });

  it('supports grep -ri "billing" /', async () => {
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'supports grep -ri "billing" /',
      profile: 'SYSTEM',
      command: 'grep -ri "billing" /',
      expected: {
        exitCode: 0,
        stdoutContains: ['/api-reference/payments.mdx'],
      },
    });
  });

  it('distinguishes regex matching from fixed-string matching', async () => {
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'distinguishes regex matching from fixed-string matching (regex)',
      profile: 'SYSTEM',
      command: 'grep -r "access.token" /auth',
      expected: {
        exitCode: 0,
        stdoutContains: ['/auth/oauth.mdx'],
      },
    });
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'distinguishes regex matching from fixed-string matching (fixed string)',
      profile: 'SYSTEM',
      command: 'grep -rF "access.token" /auth',
      expected: {
        exitCode: 1,
        stdoutExact: '',
      },
    });
  });

  it('returns grep parse/runtime errors with exit code 2', async () => {
    await assertCommandCase(ctx.bash, {
      suite: SUITE,
      test: 'returns grep parse/runtime errors with exit code 2',
      profile: 'SYSTEM',
      command: 'grep -r "(" /auth',
      expected: {
        exitCode: 2,
        stderrContains: ['invalid regular expression'],
      },
    });
  });
});

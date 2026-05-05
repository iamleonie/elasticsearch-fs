import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  compileAccessPlanFromPolicy,
  loadPathTreeAccessPolicy,
} from '../../src/bootstrap/path-tree-policy.js';
import { pathToSlug } from '../../src/core/path-tree.js';
import type { Profile } from '../e2e-report-types.js';
import {
  assertCommandCase,
  createBashSession,
  createElasticSession,
  hasProfileEnv,
} from './helpers.js';

const PROFILES: readonly Profile[] = [
  'PUBLIC',
  'BILLING',
  'INTERNAL',
  'SYSTEM',
] as const;
const run = hasProfileEnv('SYSTEM') ? describe : describe.skip;
const SUITE = 'permissions e2e';

run(SUITE, () => {
  let expectedByProfile: Record<Profile, string[]>;
  let allSlugs: string[];

  beforeAll(async () => {
    const { client, fs } = await createElasticSession('SYSTEM');
    try {
      allSlugs = fs.getVisibleFilePaths().map(pathToSlug).sort();
      const policy = await loadPathTreeAccessPolicy(
        resolve(process.cwd(), 'data/path_tree.json'),
      );
      const resolved = compileAccessPlanFromPolicy(policy);
      expectedByProfile = {
        PUBLIC: resolved.publicSlugs,
        BILLING: resolved.groupSlugs.billing ?? [],
        INTERNAL: resolved.groupSlugs.internal ?? [],
        SYSTEM: allSlugs,
      };
    } finally {
      await client.close();
    }
  });

  for (const profile of PROFILES) {
    const testForProfile = hasProfileEnv(profile) ? it : it.skip;
    testForProfile(`lists visible files for ${profile}`, async () => {
      const { client, fs } = await createElasticSession(profile);
      try {
        const actual = fs.getVisibleFilePaths().map(pathToSlug).sort();
        expect(actual).toEqual(expectedByProfile[profile]);
      } finally {
        await client.close();
      }
    });
  }

  const deniedChecks: Array<{
    profile: Exclude<Profile, 'SYSTEM'>;
    path: string;
  }> = [
    { profile: 'PUBLIC', path: '/internal/billing.mdx' },
    { profile: 'BILLING', path: '/internal/audit-log.mdx' },
    { profile: 'INTERNAL', path: '/api-reference/payments.mdx' },
  ];
  for (const check of deniedChecks) {
    const testForProfile = hasProfileEnv(check.profile) ? it : it.skip;
    testForProfile(
      `denies '${check.profile}' access to '${check.path}'`,
      async () => {
        const { client, bash } = await createBashSession(check.profile);
        try {
          await assertCommandCase(bash, {
            suite: SUITE,
            test: `denies '${check.profile}' access to '${check.path}'`,
            profile: check.profile,
            command: `cat ${check.path}`,
            expected: {
              exitCode: 1,
              stderrContains: ['No such file or directory'],
            },
          });
        } finally {
          await client.close();
        }
      },
    );
  }

  const allowedChecks: Array<{
    profile: Profile;
    path: string;
    marker: string;
  }> = [
    { profile: 'PUBLIC', path: '/auth/oauth.mdx', marker: '# OAuth' },
    {
      profile: 'BILLING',
      path: '/api-reference/payments.mdx',
      marker: '# Payments',
    },
    {
      profile: 'INTERNAL',
      path: '/internal/audit-log.mdx',
      marker: '# Audit log',
    },
    { profile: 'SYSTEM', path: '/internal/billing.mdx', marker: '# Billing' },
  ];
  for (const check of allowedChecks) {
    const testForProfile = hasProfileEnv(check.profile) ? it : it.skip;
    testForProfile(
      `allows '${check.profile}' access to '${check.path}'`,
      async () => {
        const { client, bash } = await createBashSession(check.profile);
        try {
          await assertCommandCase(bash, {
            suite: SUITE,
            test: `allows '${check.profile}' access to '${check.path}'`,
            profile: check.profile,
            command: `cat ${check.path}`,
            expected: {
              exitCode: 0,
              stdoutContains: [check.marker],
            },
          });
        } finally {
          await client.close();
        }
      },
    );
  }
});

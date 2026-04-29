import { ElasticsearchFs } from '../src/core/elasticsearchfs.js';
import { runElasticGrep } from '../src/core/grep.js';
import { Bash, defineCommand } from 'just-bash';
import { createESClient } from '../src/es-adapter/client.js';
import { initSessionTree } from '../src/session.js';

const profile = process.argv[2];
if (!profile) {
  throw new Error('Missing profile. Pass it as argv[2] (example: PUBLIC).');
}

const client = createESClient(profile);
const auth = await client.security.authenticate();
const currentUser = auth.username ?? '(unknown)';
const currentRoles = Array.isArray(auth.roles) ? auth.roles.join(', ') : '';
console.log(
  `Authenticated as: ${currentUser}${currentRoles ? ` (roles: ${currentRoles})` : ''} [profile=${profile}]`,
);

const session = await initSessionTree(client, profile);

// Set up virtual filesystem
const elasticsearchFs = new ElasticsearchFs({
  client,
  files: session.files,
  dirs: session.dirs,
});

// Define custom grep command
const grep = defineCommand('grep', async (args, ctx) => runElasticGrep(args, ctx, elasticsearchFs));

// Set up virtual bash environment
const bash = new Bash({
  fs: elasticsearchFs,
  cwd: '/',
  customCommands: [grep],
});

console.log("Command: grep -ri 'OAuth' /auth");
const { stdout: grepStdout, stderr: grepStderr } = await bash.exec('grep -ri "OAuth" /auth');
console.log(`stdout:\n${grepStdout}`);
console.log(`stderr:\n${grepStderr}`);

console.log('Command: cat /auth/oauth.mdx');
const { stdout: catStdout, stderr: catStderr} = await bash.exec('cat /auth/oauth.mdx');
console.log(`stdout:\n${catStdout.slice(0, 100)}`);
console.log(`stderr:' ${catStderr}`);

console.log('Command: ls /api-reference');
const { stdout: lsStdout, stderr: lsStderr } = await bash.exec('ls /api-reference');
console.log(`stdout:\n${lsStdout}`);
console.log(`stderr: ${lsStderr}`);
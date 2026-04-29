import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bash, ReadWriteFs } from 'just-bash';

const examples = resolve(dirname(fileURLToPath(import.meta.url)), '../data');

const bash = new Bash({
  fs: new ReadWriteFs({ root: examples }),
  cwd: '/',
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
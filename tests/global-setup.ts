import { execFileSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';

// install-skill copies dist/server.js; tests must see this checkout's build, not a stale or missing one.
export default async function setup() {
  execFileSync(npm, ['run', 'build', '-w', '@codechart/core'], { stdio: 'inherit', shell });
  execFileSync(npm, ['run', 'build', '-w', 'codechart'], { stdio: 'inherit', shell });
}

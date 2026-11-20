import { execFileSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// install-skill copies dist/server.js; tests must see this checkout's build, not a stale or missing one.
export default async function setup() {
  execFileSync(npm, ['run', 'build', '-w', '@codechart/core'], { stdio: 'inherit' });
  execFileSync(npm, ['run', 'build', '-w', 'codechart'], { stdio: 'inherit' });
}

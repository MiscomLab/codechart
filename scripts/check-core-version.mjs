import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', cwd: root }).trim();
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (git('rev-parse', '--is-shallow-repository') === 'true') fail('Shallow clone: fetch full history (actions/checkout fetch-depth: 0) to check the @codechart/core version.');

const { version } = readJson('packages/core/package.json');
const versionAt = (rev) => {
  try {
    return JSON.parse(execFileSync('git', ['show', `${rev}:packages/core/package.json`], { encoding: 'utf8', cwd: root, stdio: 'pipe' })).version;
  } catch {
    return undefined;
  }
};
const sha = git('log', '--format=%H', '--', 'packages/core/package.json')
  .split('\n')
  .find((c) => c && versionAt(c) !== versionAt(`${c}^`));
if (!sha) fail("Can't find the commit that last changed the version in packages/core/package.json.");

const tracked = ['packages/core/src', 'packages/core/package.json', 'packages/core/tsup.config.ts'];
const succeeds = (...args) => spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status === 0;
// A branch (HEAD not in main) is compared with main's tree, as its squash merge will be: commit ancestry
// breaks when a branch stacks on another that was squash-merged. main and tags use the last version commit.
const MAIN = 'refs/remotes/origin/main';
const onBranch = succeeds('rev-parse', '--verify', '--quiet', MAIN) && !succeeds('merge-base', '--is-ancestor', 'HEAD', MAIN);
const base = onBranch ? MAIN : sha;
const changed = onBranch && versionAt(MAIN) !== version ? '' : git('diff', '--name-only', base, 'HEAD', '--', ...tracked);
if (changed) fail(`@codechart/core changed since ${version} (${onBranch ? 'main' : sha.slice(0, 7)}) but its version wasn't bumped: bump packages/core/package.json and the CLI's dependency on it.\n${changed}`);

const pinned = readJson('packages/cli/package.json').dependencies?.['@codechart/core'];
if (pinned !== version) fail(`packages/cli/package.json depends on @codechart/core ${pinned}, but core is ${version}: pin the CLI to the exact core version.`);

console.log(`core version ok: ${version}`);

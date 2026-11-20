import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/check-core-version.mjs');
const dirs: string[] = [];

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
const write = (cwd: string, path: string, content: string) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
};
const corePkg = (version: string, deps: Record<string, string> = {}) => `${JSON.stringify({ name: '@codechart/core', version, dependencies: deps }, null, 2)}\n`;
const cliPkg = (core: string) => `${JSON.stringify({ name: 'codechart', version: '1.0.0', dependencies: { '@codechart/core': core } }, null, 2)}\n`;
const commit = (cwd: string, msg: string) => {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', msg);
};
const repo = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'codechart-core-version-'));
  dirs.push(cwd);
  git(cwd, 'init', '-q');
  write(cwd, 'packages/core/package.json', corePkg('0.1.0'));
  write(cwd, 'packages/core/src/index.ts', 'export const a = 1;\n');
  write(cwd, 'packages/cli/package.json', cliPkg('0.1.0'));
  commit(cwd, 'init');
  return cwd;
};
const check = (cwd: string) => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('scripts/check-core-version.mjs', () => {
  it('passes when core is unchanged since its version commit', () => {
    const r = check(repo());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('core version ok: 0.1.0');
  });

  it('ignores changes outside core and its package files', () => {
    const cwd = repo();
    write(cwd, 'packages/core/tests/a.test.ts', 'x\n');
    write(cwd, 'packages/cli/src/a.ts', 'x\n');
    commit(cwd, 'other');
    expect(check(cwd).status).toBe(0);
  });

  it('fails and lists the file when core src changes without a bump', () => {
    const cwd = repo();
    write(cwd, 'packages/core/src/index.ts', 'export const a = 2;\n');
    commit(cwd, 'change');
    const r = check(cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("but its version wasn't bumped");
    expect(r.stderr).toContain('packages/core/src/index.ts');
  });

  it('fails when the tsup config changes without a bump', () => {
    const cwd = repo();
    write(cwd, 'packages/core/tsup.config.ts', 'export default {};\n');
    commit(cwd, 'config');
    expect(check(cwd).status).toBe(1);
  });

  it('fails when only a non-version key in core package.json changes', () => {
    const cwd = repo();
    write(cwd, 'packages/core/package.json', corePkg('0.1.0', { zod: '4.6.7' }));
    commit(cwd, 'dep');
    const r = check(cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/core/package.json');
  });

  it('does not count reformatting the version line as a bump', () => {
    const cwd = repo();
    write(cwd, 'packages/core/src/index.ts', 'export const a = 2;\n');
    write(cwd, 'packages/core/package.json', corePkg('0.1.0').replace('"version": "0.1.0"', '"version":  "0.1.0"'));
    commit(cwd, 'change and reformat');
    const r = check(cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/core/src/index.ts');
  });

  it('passes once a later commit bumps the version and the CLI pin', () => {
    const cwd = repo();
    write(cwd, 'packages/core/src/index.ts', 'export const a = 2;\n');
    commit(cwd, 'change');
    write(cwd, 'packages/core/package.json', corePkg('0.1.1'));
    write(cwd, 'packages/cli/package.json', cliPkg('0.1.1'));
    commit(cwd, 'bump');
    const r = check(cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('core version ok: 0.1.1');
  });

  it('passes when core changes after a bump made on the branch, not yet in main', () => {
    const cwd = repo();
    git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    write(cwd, 'packages/core/package.json', corePkg('0.2.0'));
    write(cwd, 'packages/cli/package.json', cliPkg('0.2.0'));
    commit(cwd, 'bump');
    write(cwd, 'packages/core/src/index.ts', 'export const a = 2;\n');
    commit(cwd, 'fix');
    expect(check(cwd).status).toBe(0);
  });

  it('still checks the CLI pin after a bump made on the branch', () => {
    const cwd = repo();
    git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    write(cwd, 'packages/core/package.json', corePkg('0.2.0'));
    commit(cwd, 'bump core only');
    write(cwd, 'packages/core/src/index.ts', 'export const a = 2;\n');
    commit(cwd, 'fix');
    const r = check(cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('depends on @codechart/core 0.1.0, but core is 0.2.0');
  });

  it('fails when core changes after a bump that is already in main', () => {
    const cwd = repo();
    write(cwd, 'packages/core/package.json', corePkg('0.2.0'));
    write(cwd, 'packages/cli/package.json', cliPkg('0.2.0'));
    commit(cwd, 'bump');
    git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    write(cwd, 'packages/core/src/index.ts', 'export const a = 2;\n');
    commit(cwd, 'change');
    expect(check(cwd).status).toBe(1);
  });

  it('fails a branch stacked on a squash-merged bump that changes core again', () => {
    const cwd = repo();
    const init = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    write(cwd, 'packages/core/package.json', corePkg('0.2.0'));
    write(cwd, 'packages/cli/package.json', cliPkg('0.2.0'));
    write(cwd, 'packages/core/src/index.ts', 'export const a = 2;\n');
    commit(cwd, 'branch A: bump and change');
    const tipA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    write(cwd, 'packages/core/src/b.ts', 'export const b = 1;\n');
    commit(cwd, 'branch B on A: change core without a bump');
    // Squash A onto main: one new commit with A's tree, not an ancestor of B.
    const tree = execFileSync('git', ['rev-parse', `${tipA}^{tree}`], { cwd, encoding: 'utf8' }).trim();
    const squash = execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', init, '-m', 'squash A'], { cwd, encoding: 'utf8' }).trim();
    git(cwd, 'update-ref', 'refs/remotes/origin/main', squash);
    const r = check(cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/core/src/b.ts');
  });

  it("fails when the CLI's dependency differs from core's version", () => {
    const cwd = repo();
    write(cwd, 'packages/core/package.json', corePkg('0.1.1'));
    commit(cwd, 'bump core only');
    const r = check(cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('depends on @codechart/core 0.1.0, but core is 0.1.1');
  });
});

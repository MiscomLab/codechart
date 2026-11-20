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

  it("fails when the CLI's dependency differs from core's version", () => {
    const cwd = repo();
    write(cwd, 'packages/core/package.json', corePkg('0.1.1'));
    commit(cwd, 'bump core only');
    const r = check(cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('depends on @codechart/core 0.1.0, but core is 0.1.1');
  });
});

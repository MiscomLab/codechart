import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCodeFiles, parseRepo, readCodeFile } from '../../src/code/repo.js';

const APP = join(import.meta.dirname, '..', 'fixtures', 'code', 'ts-app');
let repo: string;

const write = (path: string, text = 'export const x = 1;\n') => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'codechart-code-'));
  cpSync(APP, repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  write('.gitignore', 'generated/\n');
  write('src/gone.ts');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  unlinkSync(join(repo, 'src', 'gone.ts'));
  const ignored = ['generated/api.ts', 'node_modules/lib/index.js', 'dist/app.js', 'packages/a/build/x.ts', '.venv/lib/x.py', 'web/vendor.min.js', 'web/site.min.css'];
  for (const p of [...ignored, 'legacy/old.ts', 'src/untracked.ts']) write(p);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('listCodeFiles', () => {
  it('lists tracked and untracked v1 files, minus git ignores, build output and dependencies', () => {
    // src/gone.ts is deleted but still tracked: listed here, skipped when read.
    expect(listCodeFiles(repo)).toEqual(['legacy/old.ts', 'src/app.py', 'src/gone.ts', 'src/legacy/util.js', 'src/payments/service.ts', 'src/ui/Button.tsx', 'src/untracked.ts']);
  });

  it('applies the project ignore globs', () => {
    expect(listCodeFiles(repo, ['legacy/**', '**/*.py', 'src/gone.ts'])).toEqual(['src/legacy/util.js', 'src/payments/service.ts', 'src/ui/Button.tsx', 'src/untracked.ts']);
  });
});

describe('readCodeFile', () => {
  it('reads files up to 1 MB', () => {
    write('edge.ts', 'a'.repeat(1024 * 1024));
    write('big.ts', 'a'.repeat(1024 * 1024 + 1));
    expect([readCodeFile(repo, 'edge.ts')?.length, readCodeFile(repo, 'big.ts')]).toEqual([1024 * 1024, undefined]);
  });

  it('skips files that are gone, binary or symlinks', () => {
    write('bin.js', 'a\0b');
    symlinkSync(join(repo, 'src', 'untracked.ts'), join(repo, 'link.ts'));
    expect(readCodeFile(repo, 'src/untracked.ts')).toBe('export const x = 1;\n');
    expect([readCodeFile(repo, 'gone.ts'), readCodeFile(repo, 'bin.js'), readCodeFile(repo, 'link.ts')]).toEqual([undefined, undefined, undefined]);
  });
});

describe('parseRepo', () => {
  it('parses every readable listed file', async () => {
    const files = await parseRepo(repo, { ignore: ['legacy/**'] });
    expect(files.map((f) => f.file.path)).toEqual(['src/app.py', 'src/legacy/util.js', 'src/payments/service.ts', 'src/ui/Button.tsx', 'src/untracked.ts']);
    expect(files.find((f) => f.file.path === 'src/payments/service.ts')!.symbols).toHaveLength(8);
  });
});

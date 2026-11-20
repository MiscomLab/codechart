import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  execFileSync('git', ['add', '-A'], { cwd: repo });
  for (const p of ['generated/api.ts', 'node_modules/lib/index.js', 'dist/app.js', 'web/vendor.min.js', 'legacy/old.ts', 'src/untracked.ts']) write(p);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('listCodeFiles', () => {
  it('lists tracked and untracked v1 files, minus git ignores, build output and dependencies', () => {
    expect(listCodeFiles(repo)).toEqual(['legacy/old.ts', 'src/app.py', 'src/legacy/util.js', 'src/payments/service.ts', 'src/ui/Button.tsx', 'src/untracked.ts']);
  });

  it('applies the project ignore globs', () => {
    expect(listCodeFiles(repo, ['legacy/**', '**/*.py'])).toEqual(['src/legacy/util.js', 'src/payments/service.ts', 'src/ui/Button.tsx', 'src/untracked.ts']);
  });
});

describe('readCodeFile', () => {
  it('skips files that are gone, binary or symlinks', () => {
    write('bin.js', 'a\0b');
    symlinkSync(join(repo, 'src', 'untracked.ts'), join(repo, 'link.ts'));
    expect(readCodeFile(repo, 'src/untracked.ts')).toBe('export const x = 1;\n');
    expect([readCodeFile(repo, 'gone.ts'), readCodeFile(repo, 'bin.js'), readCodeFile(repo, 'link.ts')]).toEqual([undefined, undefined, undefined]);
  });
});

describe('parseRepo', () => {
  it('parses every listed file', async () => {
    const files = await parseRepo(repo, { ignore: ['legacy/**'] });
    expect(files.map((f) => [f.file.path, f.symbols.length])).toEqual([
      ['src/app.py', 0],
      ['src/legacy/util.js', 2],
      ['src/payments/service.ts', 8],
      ['src/ui/Button.tsx', 1],
      ['src/untracked.ts', 0],
    ]);
  });
});

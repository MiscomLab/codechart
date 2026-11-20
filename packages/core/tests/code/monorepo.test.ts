import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Import } from '../../src/code/model.js';
import type { ParsedFile } from '../../src/code/parse.js';
import { parseRepo } from '../../src/code/repo.js';

const MONO = join(import.meta.dirname, '..', 'fixtures', 'code', 'ts-monorepo');
let repo: string;
let files: ParsedFile[];

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'codechart-mono-'));
  cpSync(MONO, repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  files = await parseRepo(repo);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

const importsOf = (path: string): Import[] => files.find((f) => f.file.path === path)!.imports;
const outcome = (i: Import) => [i.spec, i.status, i.resolved];

describe('parseRepo on an npm workspaces monorepo', () => {
  it('resolves, or marks unknown or external, every import of the app', () => {
    expect(importsOf('packages/app/src/main.ts').map(outcome)).toEqual([
      ['@mono/lib', 'resolved', 'packages/lib/src/index.ts'],
      ['@mono/lib/utils/slug', 'resolved', 'packages/lib/src/utils/slug.ts'],
      ['@mono/lib/internal/secret', 'unknown', undefined],
      ['@app/util/helper.js', 'resolved', 'packages/app/src/util/helper.ts'],
      ['@app/nothing', 'unknown', undefined],
      ['node:fs', 'external', undefined],
      ['path', 'external', undefined],
      ['zod', 'external', undefined],
      ['./gone.js', 'unknown', undefined],
      ['#config', 'resolved', 'packages/app/src/config.ts'],
      ['./views', 'resolved', 'packages/app/src/views/index.ts'],
      ['./esm.mjs', 'resolved', 'packages/app/src/esm.mts'],
      ['./lazy.js', 'resolved', 'packages/app/src/lazy.ts'],
    ]);
  });

  it('follows names through the barrel to their defining files', () => {
    const names = importsOf('packages/app/src/main.ts')[0]!.names!.map((n) => [n.local, n.definedIn]);
    expect(names).toEqual([
      ['add', 'packages/lib/src/math.ts'],
      ['upper', 'packages/lib/src/strings.ts'],
      ['formatDate', 'packages/lib/src/time.ts'],
      ['clock', 'packages/lib/src/time.ts'],
      // dup-a and dup-b both export it: ambiguous, so not proven.
      ['twice', undefined],
      ['missing', undefined],
    ]);
  });

  it('resolves require in a CommonJS file', () => {
    expect(importsOf('packages/app/src/legacy.cjs').map(outcome)).toEqual([['./util/old.cjs', 'resolved', 'packages/app/src/util/old.cjs']]);
  });

  it('records each import with its kind, names and line', () => {
    const main = importsOf('packages/app/src/main.ts');
    expect(main.find((i) => i.spec === './esm.mjs')).toMatchObject({ kind: 'import', typeOnly: true, names: [{ imported: 'Mode', local: 'Mode', typeOnly: true, definedIn: 'packages/app/src/esm.mts' }] });
    expect(main.find((i) => i.spec === './views')!.names).toEqual([{ imported: '*', local: 'views', definedIn: 'packages/app/src/views/index.ts' }]);
    expect(main.find((i) => i.spec === './lazy.js')).toMatchObject({ kind: 'dynamic' });
    expect(main.find((i) => i.spec === './lazy.js')!.names).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { createResolver } from '../../../src/code/resolve/resolver.js';

/** A resolver over an in-memory repo: path → text. */
const repo = (tree: Record<string, string>) => createResolver(Object.keys(tree), (p) => tree[p]);
const json = (v: unknown) => JSON.stringify(v);
const to = (resolved: string) => ({ status: 'resolved', resolved });
const UNKNOWN = { status: 'unknown' };
const EXTERNAL = { status: 'external' };

describe('relative specifiers', () => {
  const r = repo({ 'src/a.ts': '', 'src/b.ts': '', 'src/b.js': '', 'src/c.tsx': '', 'src/d.mts': '', 'src/e.cts': '', 'src/f.d.ts': '', 'src/dir/index.ts': '', 'src/data.json': '', 'src/x.js': '', 'main.js': '' });

  it('adds extensions, finds index files and loads named files', () => {
    expect(r.resolve('src/a.ts', './c')).toEqual(to('src/c.tsx'));
    expect(r.resolve('src/a.ts', './f')).toEqual(to('src/f.d.ts'));
    expect(r.resolve('src/a.ts', './dir')).toEqual(to('src/dir/index.ts'));
    expect(r.resolve('src/dir/index.ts', '../a')).toEqual(to('src/a.ts'));
    expect(r.resolve('src/a.ts', './data.json')).toEqual(to('src/data.json'));
    expect(r.resolve('main.js', './src/x')).toEqual(to('src/x.js'));
  });

  it('maps the emitted name back to TypeScript source', () => {
    expect(r.resolve('src/a.ts', './c.js')).toEqual(to('src/c.tsx'));
    expect(r.resolve('src/a.ts', './c.jsx')).toEqual(to('src/c.tsx'));
    expect(r.resolve('src/a.ts', './d.mjs')).toEqual(to('src/d.mts'));
    expect(r.resolve('src/a.ts', './e.cjs')).toEqual(to('src/e.cts'));
    expect(r.resolve('src/a.ts', './x.js')).toEqual(to('src/x.js'));
  });

  it('gives a TS importer the .ts file and a JS importer the .js file when both exist', () => {
    expect([r.resolve('src/a.ts', './b'), r.resolve('src/a.ts', './b.js')]).toEqual([to('src/b.ts'), to('src/b.ts')]);
    expect([r.resolve('src/x.js', './b'), r.resolve('src/x.js', './b.js')]).toEqual([to('src/b.js'), to('src/b.js')]);
  });

  it('prefers the JavaScript a declaration file describes, for a TS importer too', () => {
    const r = repo({ 'lib/x.js': '', 'lib/x.d.ts': '', 'lib/y.d.ts': '', 'a.ts': '' });
    expect(['./lib/x.js', './lib/x', './lib/y.js', './lib/y'].map((s) => r.resolve('a.ts', s))).toEqual([to('lib/x.js'), to('lib/x.js'), to('lib/y.d.ts'), to('lib/y.d.ts')]);
  });

  it('drops a query (Vite ?raw, ?worker&url, cache busting) from relative specifiers', () => {
    expect([r.resolve('src/a.ts', './c.js?worker&url'), r.resolve('src/a.ts', './data.json?raw'), r.resolve('src/a.ts', './nope?raw')]).toEqual([to('src/c.tsx'), to('src/data.json'), UNKNOWN]);
  });

  it('loads a directory by its package.json entry before its index', () => {
    const r = repo({ 'lib/package.json': json({ main: './entry.js' }), 'lib/entry.js': '', 'lib/index.js': '', 'only/package.json': json({ main: './dist/m.js' }), 'only/src/m.ts': '', 'plain/package.json': '{}', 'plain/index.js': '', 'a.js': '' });
    expect(['./lib', './only', './plain'].map((s) => r.resolve('a.js', s))).toEqual([to('lib/entry.js'), to('only/src/m.ts'), to('plain/index.js')]);
  });

  it('loads a file before a folder of the same name', () => {
    const r = repo({ 'x.ts': '', 'x/package.json': json({ main: './m.js' }), 'x/m.js': '', 'a.ts': '' });
    expect(r.resolve('a.ts', './x')).toEqual(to('x.ts'));
  });

  it('marks missing files and paths leaving the repo unknown', () => {
    expect([r.resolve('src/a.ts', './nope'), r.resolve('src/a.ts', '../../a'), r.resolve('src/a.ts', '/abs/a')]).toEqual([UNKNOWN, UNKNOWN, UNKNOWN]);
  });
});

describe('bare specifiers', () => {
  it('marks built-ins and other packages external, URLs and loader schemes unknown', () => {
    const r = repo({ 'a.ts': '' });
    expect(['node:fs', 'fs', 'fs/promises', 'react', '@scope/pkg/sub', 'bun:test', 'npm:zod@4', 'jsr:@std/path'].map((s) => r.resolve('a.ts', s))).toEqual(Array(8).fill(EXTERNAL));
    expect(['https://x.dev/m.js', 'virtual:icons', ''].map((s) => r.resolve('a.ts', s))).toEqual(Array(3).fill(UNKNOWN));
  });

  it('resolves tsconfig paths: exact first, then the longest prefix, relative to baseUrl or else the config', () => {
    const r = repo({
      'tsconfig.json': json({ compilerOptions: { paths: { '@/*': ['./src/*'], '@/lib/*': ['./lib/*'], exact: ['./src/exact.ts'] } } }),
      'web/tsconfig.json': json({ compilerOptions: { baseUrl: '..', paths: { '~/*': ['src/*'] } } }),
      'src/a.ts': '',
      'src/exact.ts': '',
      'lib/a.ts': '',
      'web/w.ts': '',
    });
    expect(r.resolve('src/a.ts', '@/a')).toEqual(to('src/a.ts'));
    expect(r.resolve('src/a.ts', '@/lib/a')).toEqual(to('lib/a.ts'));
    expect(r.resolve('src/a.ts', 'exact')).toEqual(to('src/exact.ts'));
    expect(r.resolve('web/w.ts', '~/a.js')).toEqual(to('src/a.ts'));
    // The nearest config only: web/ doesn't see the root's aliases.
    expect(r.resolve('web/w.ts', '@/a')).toEqual(EXTERNAL);
  });

  it('marks an alias without a file unknown, unless it names a declared dependency', () => {
    const r = repo({ 'tsconfig.json': json({ compilerOptions: { paths: { '*': ['./types/*'] } } }), 'package.json': json({ dependencies: { react: '1' } }), 'a.ts': '' });
    expect([r.resolve('a.ts', 'react'), r.resolve('a.ts', 'fs'), r.resolve('a.ts', 'left-pad')]).toEqual([EXTERNAL, EXTERNAL, UNKNOWN]);
  });

  it('tries alias targets in order, matches suffix patterns and an empty *', () => {
    const r = repo({
      'tsconfig.json': json({ compilerOptions: { paths: { '@/*': ['./missing/*', './src/*'], '*.css': ['./styles/*.css'] } } }),
      'src/a.ts': '',
      'src/index.ts': '',
      'styles/main.css': '',
      'x.ts': '',
    });
    expect(['@/a', 'main.css', '@/'].map((s) => r.resolve('x.ts', s))).toEqual([to('src/a.ts'), to('styles/main.css'), to('src/index.ts')]);
  });

  it('marks an alias unknown under a solution-style tsconfig whose references it does not follow', () => {
    const r = repo({
      'tsconfig.json': json({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': json({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'package.json': json({ dependencies: { react: '1' } }),
      'src/a.ts': '',
      'src/b.ts': '',
    });
    expect(['@/b', 'react', 'fs', 'left-pad'].map((s) => r.resolve('src/a.ts', s))).toEqual([UNKNOWN, EXTERNAL, EXTERNAL, UNKNOWN]);
  });

  it('counts a declared @types package as declaring the package it types', () => {
    const r = repo({
      'tsconfig.json': json({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'package.json': json({ devDependencies: { '@types/mdast': '1', '@types/babel__core': '1' } }),
      'a.ts': '',
    });
    expect(['mdast', '@babel/core', '@babel/core/sub', 'hast', '@types/mdast'].map((s) => r.resolve('a.ts', s))).toEqual([EXTERNAL, EXTERNAL, EXTERNAL, UNKNOWN, EXTERNAL]);
  });

  it('resolves through baseUrl before packages', () => {
    const r = repo({ 'tsconfig.json': json({ compilerOptions: { baseUrl: 'src' } }), 'src/utils/x.ts': '', 'a.ts': '' });
    expect([r.resolve('a.ts', 'utils/x'), r.resolve('a.ts', 'utils/y')]).toEqual([to('src/utils/x.ts'), EXTERNAL]);
  });
});

describe('tsconfig extends', () => {
  it('merges a relative chain and arrays, later configs and the file itself winning', () => {
    const r = repo({
      'configs/base.json': json({ compilerOptions: { baseUrl: '../src', paths: { '#a': ['./a.ts'] } } }),
      'configs/more.json': '{ "compilerOptions": { "paths": { "@x": ["./x.ts"] } }, }',
      'tsconfig.json': json({ extends: ['./configs/base', './configs/more.json'] }),
      'src/a.ts': '',
      'src/x.ts': '',
    });
    // `paths` from more.json replace base.json's and resolve against base.json's baseUrl.
    expect([r.resolve('src/a.ts', '@x'), r.resolve('src/a.ts', 'x')]).toEqual([to('src/x.ts'), to('src/x.ts')]);
  });

  it('follows a workspace package but not one outside the repo, which leaves bare imports unproven', () => {
    const r = repo({
      'package.json': json({ workspaces: ['tools/*'], devDependencies: { vitest: '1' } }),
      'tools/tsconfig/package.json': json({ name: '@my/tsconfig' }),
      'tools/tsconfig/tsconfig.json': json({ compilerOptions: { paths: { '@lib': ['../../lib.ts'] } } }),
      'a/tsconfig.json': json({ extends: '@my/tsconfig' }),
      'b/tsconfig.json': json({ extends: '@tsconfig/node22/tsconfig.json' }),
      'lib.ts': '',
      'a/a.ts': '',
      'b/b.ts': '',
    });
    expect(r.resolve('a/a.ts', '@lib')).toEqual(to('lib.ts'));
    expect([r.resolve('b/b.ts', 'vitest'), r.resolve('b/b.ts', 'fs'), r.resolve('b/b.ts', 'left-pad')]).toEqual([EXTERNAL, EXTERNAL, UNKNOWN]);
  });

  it('leaves the options unproven when baseUrl points outside the repo, overriding an inherited one', () => {
    const r = repo({
      'base.json': json({ compilerOptions: { baseUrl: './src', paths: { '@/*': ['*'] } } }),
      'tsconfig.json': json({ extends: './base.json', compilerOptions: { baseUrl: '../shared' } }),
      'src/x.ts': '',
      'a.ts': '',
    });
    expect([r.resolve('a.ts', 'left-pad'), r.resolve('a.ts', 'x'), r.resolve('a.ts', '@/x')]).toEqual([UNKNOWN, UNKNOWN, UNKNOWN]);
  });

  it('resolves inherited paths against the config that set them, or against the child baseUrl', () => {
    const r = repo({
      'cfgs/base.json': json({ compilerOptions: { paths: { '@c/*': ['./t/*'] } } }),
      'cfgs/t/z.ts': '',
      'sub/tsconfig.json': json({ extends: '../cfgs/base.json' }),
      'sub/s.ts': '',
      'other/tsconfig.json': json({ extends: '../cfgs/base.json', compilerOptions: { baseUrl: '.' } }),
      'other/t/z.ts': '',
      'other/o.ts': '',
    });
    expect([r.resolve('sub/s.ts', '@c/z'), r.resolve('other/o.ts', '@c/z')]).toEqual([to('cfgs/t/z.ts'), to('other/t/z.ts')]);
  });

  it('extends a package by its exports, else its tsconfig field, else its tsconfig.json', () => {
    const cfg = (pkg: object) =>
      repo({
        'package.json': json({ workspaces: ['packages/*'] }),
        'packages/cfg/package.json': json({ name: '@o/cfg', ...pkg }),
        'packages/cfg/base.json': json({ compilerOptions: { paths: { '@/*': ['../app/src/*'] } } }),
        'packages/cfg/tsconfig.json': json({ compilerOptions: { paths: { '@/*': ['./wrong/*'] } } }),
        'packages/cfg/wrong/x.ts': '',
        'packages/app/tsconfig.json': json({ extends: '@o/cfg' }),
        'packages/app/src/x.ts': '',
        'packages/app/src/main.ts': '',
      }).resolve('packages/app/src/main.ts', '@/x');
    expect(cfg({ tsconfig: './base.json' })).toEqual(to('packages/app/src/x.ts'));
    expect(cfg({ exports: { '.': './base.json' }, tsconfig: './tsconfig.json' })).toEqual(to('packages/app/src/x.ts'));
    expect(cfg({})).toEqual(to('packages/cfg/wrong/x.ts'));
    expect(cfg({ exports: { './other': './base.json' } })).toEqual(UNKNOWN);
  });

  it('stops at a cycle', () => {
    const r = repo({ 'tsconfig.json': json({ extends: './b.json' }), 'b.json': json({ extends: './tsconfig.json' }), 'a.ts': '' });
    expect(r.resolve('a.ts', 'left-pad')).toEqual(UNKNOWN);
  });
});

describe('workspace packages', () => {
  const lib = (pkg: object, files: string[]) => Object.fromEntries([['libs/lib/package.json', json({ name: 'lib', ...pkg })], ...files.map((f) => [`libs/lib/${f}`, ''])]);
  const base = { 'package.json': json({ workspaces: ['libs/*'] }), 'app.ts': '' };

  it('maps build output to the one matching source file; a deep path without exports is taken as written', () => {
    const r = repo({ ...base, ...lib({ main: './dist/esm/index.js' }, ['src/index.ts', 'src/util/x.ts']) });
    expect(['lib', 'lib/src/util/x', 'lib/util/x'].map((s) => r.resolve('app.ts', s))).toEqual([to('libs/lib/src/index.ts'), to('libs/lib/src/util/x.ts'), UNKNOWN]);
  });

  it('marks build output unknown when two source files could be it, without falling back to index', () => {
    const r = repo({ ...base, ...lib({ exports: './dist/index.js' }, ['src/index.ts', 'index.js']) });
    expect(r.resolve('app.ts', 'lib')).toEqual(UNKNOWN);
    const viaMain = repo({ ...base, ...lib({ main: './dist/index.js' }, ['src/index.ts', 'index.ts']) });
    expect(viaMain.resolve('app.ts', 'lib')).toEqual(UNKNOWN);
  });

  it('does not fall back to main when exports names a missing file', () => {
    const r = repo({ ...base, ...lib({ exports: { '.': './missing.js' }, main: './src/index.ts' }, ['src/index.ts']) });
    expect(r.resolve('app.ts', 'lib')).toEqual(UNKNOWN);
  });

  it('prefers the require condition for require() and import for the rest, source first', () => {
    const r = repo({ ...base, ...lib({ exports: { require: './src/cjs.ts', import: './src/esm.ts' } }, ['src/cjs.ts', 'src/esm.ts']) });
    expect([r.resolve('app.ts', 'lib', 'require'), r.resolve('app.ts', 'lib', 'import'), r.resolve('app.ts', 'lib', 'dynamic'), r.resolve('app.ts', 'lib')]).toEqual([
      to('libs/lib/src/cjs.ts'),
      to('libs/lib/src/esm.ts'),
      to('libs/lib/src/esm.ts'),
      to('libs/lib/src/esm.ts'),
    ]);
    const withSource = repo({ ...base, ...lib({ exports: { require: './src/cjs.ts', source: './src/esm.ts' } }, ['src/cjs.ts', 'src/esm.ts']) });
    expect(withSource.resolve('app.ts', 'lib', 'require')).toEqual(to('libs/lib/src/esm.ts'));
  });

  it('looks in baseUrl before workspace packages, as TypeScript does', () => {
    const r = repo({ ...base, ...lib({ main: './src/index.ts' }, ['src/index.ts']), 'tsconfig.json': json({ compilerOptions: { baseUrl: '.' } }), 'lib/index.ts': '' });
    expect(r.resolve('app.ts', 'lib')).toEqual(to('lib/index.ts'));
  });

  it('uses the exports target that exists and keeps hidden subpaths unknown', () => {
    const r = repo({ ...base, ...lib({ exports: { '.': { source: './src/missing.ts', import: './dist/index.mjs' }, './p/*': null } }, ['src/index.mts', 'src/p/x.ts']) });
    expect([r.resolve('app.ts', 'lib'), r.resolve('app.ts', 'lib/p/x'), r.resolve('app.ts', 'lib/other')]).toEqual([to('libs/lib/src/index.mts'), UNKNOWN, UNKNOWN]);
  });

  it('reads pnpm-workspace.yaml, honours negated globs and leaves a name two packages claim unknown', () => {
    const r = repo({
      'pnpm-workspace.yaml': "packages:\n  - 'pkgs/**'\n  - '!pkgs/skip/**'\n",
      'pkgs/a/package.json': json({ name: 'a' }),
      'pkgs/a/index.ts': '',
      'pkgs/skip/b/package.json': json({ name: 'b' }),
      'pkgs/skip/b/index.ts': '',
      'pkgs/c1/package.json': json({ name: 'c' }),
      'pkgs/c1/index.ts': '',
      'pkgs/c2/package.json': json({ name: 'c' }),
      'pkgs/c2/index.ts': '',
      'x.ts': '',
    });
    expect(['a', 'b', 'c'].map((s) => r.resolve('x.ts', s))).toEqual([to('pkgs/a/index.ts'), EXTERNAL, UNKNOWN]);
  });

  it('resolves package imports (#) to package files or classifies their bare targets', () => {
    const r = repo({ 'package.json': json({ imports: { '#db': { node: './src/db.ts' }, '#dep': 'zod', '#internal/*': './src/internal/*.ts' } }), 'src/db.ts': '', 'src/internal/k.ts': '', 'src/a.ts': '' });
    expect(['#db', '#dep', '#internal/k', '#nope'].map((s) => r.resolve('src/a.ts', s))).toEqual([to('src/db.ts'), EXTERNAL, to('src/internal/k.ts'), UNKNOWN]);
  });
});

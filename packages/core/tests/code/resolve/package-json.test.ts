import { describe, expect, it } from 'vitest';
import { mapTargets, toPackageJson } from '../../../src/code/resolve/package-json.js';

describe('mapTargets', () => {
  it('reads a string, an array or bare conditions as the "." entry', () => {
    expect(mapTargets('./a.js', '.')).toEqual(['./a.js']);
    expect(mapTargets(['./a.js', './b.js'], '.')).toEqual(['./a.js', './b.js']);
    expect(mapTargets({ import: './a.mjs' }, '.')).toEqual(['./a.mjs']);
    expect(mapTargets('./a.js', './sub')).toEqual([]);
  });

  it('orders conditions source-first and types last, nested ones too, skipping unknown ones', () => {
    const map = { '.': { types: './d.ts', browser: './b.js', require: './c.cjs', import: { development: './dev.js', default: './i.js' }, source: './src.ts' } };
    expect(mapTargets(map, '.')).toEqual(['./src.ts', './dev.js', './i.js', './c.cjs', './d.ts']);
  });

  it('matches * patterns by longest prefix and fills every *', () => {
    const map = { './*': './dist/*.js', './utils/*': { import: './dist/utils/*/*.js' }, './utils/*.css': './css/*.css' };
    expect(mapTargets(map, './utils/a')).toEqual(['./dist/utils/a/a.js']);
    expect(mapTargets(map, './x')).toEqual(['./dist/x.js']);
    expect(mapTargets(map, './utils/a.css')).toEqual(['./css/a.css']);
  });

  it('prefers an exact key, and gives nothing for null or no match', () => {
    const map = { './a': './exact.js', './*': './star/*.js', './private/*': null, './x': { import: null, default: './x.js' } };
    expect(mapTargets(map, './a')).toEqual(['./exact.js']);
    expect(mapTargets(map, './private/key')).toEqual([]);
    expect(mapTargets(map, './x')).toEqual(['./x.js']);
    expect(mapTargets({ '#a': './a.js' }, '#b')).toEqual([]);
  });
});

describe('toPackageJson', () => {
  it('reads entries, dependency names and workspaces as an array or object', () => {
    const pkg = toPackageJson({ name: 'p', main: 'lib/i.js', module: 'esm/i.js', dependencies: { a: '1' }, peerDependencies: { b: '1' }, workspaces: { packages: ['x/*'] } });
    expect(pkg).toMatchObject({ name: 'p', entries: ['esm/i.js', 'lib/i.js'], workspaces: ['x/*'] });
    expect([...pkg!.deps]).toEqual(['a', 'b']);
    expect(toPackageJson({ workspaces: ['y/*', 3] })!.workspaces).toEqual(['y/*']);
    expect(toPackageJson([1])).toBeUndefined();
  });
});

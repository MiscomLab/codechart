import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../../src/code/parse.js';
import { linkImports } from '../../../src/code/resolve/link.js';
import { createResolver } from '../../../src/code/resolve/resolver.js';

/** Parses and links an in-memory repo, then gives `local → definedIn` for each name `file` imports. */
async function definitions(tree: Record<string, string>, file = 'app.ts'): Promise<Record<string, string | undefined>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([p, t]) => parseCode(p, t)))).filter((f): f is ParsedFile => !!f);
  const linked = linkImports(parsed, createResolver(Object.keys(tree), (p) => tree[p]));
  const names = linked.find((f) => f.file.path === file)!.imports.flatMap((i) => i.names ?? []);
  return Object.fromEntries(names.map((n) => [n.local, n.definedIn]));
}

describe('linkImports', () => {
  it('follows named, renamed, default and star re-exports to the defining file', async () => {
    const found = await definitions({
      'app.ts': "import { a, b2, def, c, ns, viaImport } from './barrel';",
      'barrel.ts': "export { a } from './a';\nexport { b as b2, default as def } from './b';\nexport * from './c';\nexport * as ns from './a';\nimport { d } from './d';\nexport { d as viaImport };",
      'a.ts': 'export const a = 1;',
      'b.ts': 'export const b = 1;\nexport default function () {}',
      'c.ts': "export * from './deeper';",
      'deeper.ts': 'export class c {}',
      'd.ts': 'export const d = 1;',
    });
    expect(found).toEqual({ a: 'a.ts', b2: 'b.ts', def: 'b.ts', c: 'deeper.ts', ns: 'a.ts', viaImport: 'd.ts' });
  });

  it('proves nothing for a name two stars provide, an unresolved star could provide, or default through a star', async () => {
    const found = await definitions({
      'app.ts': "import { x } from './two';\nimport { y, z } from './open';\nimport def from './star';",
      'two.ts': "export * from './p';\nexport * from './q';",
      'p.ts': 'export const x = 1;',
      'q.ts': 'export const x = 2;',
      'open.ts': "export * from './p2';\nexport * from 'some-pkg';\nexport const z = 1;",
      'p2.ts': 'export const y = 1;',
      'star.ts': "export * from './withDefault';",
      'withDefault.ts': 'export default 1;',
    });
    expect(found).toEqual({ x: undefined, y: undefined, z: 'open.ts', def: undefined });
  });

  it('treats one definition reached twice as one, and survives star cycles', async () => {
    const found = await definitions({
      'app.ts': "import { x, none } from './a';",
      'a.ts': "export * from './b';\nexport * from './c';",
      'b.ts': "export * from './a';\nexport * from './x';",
      'c.ts': "export * from './x';",
      'x.ts': 'export const x = 1;',
    });
    expect(found).toEqual({ x: 'x.ts', none: undefined });
  });

  it('proves nothing past CommonJS, export =, or a file without exports info', async () => {
    const found = await definitions({
      'app.ts': "import { a } from './cjs-star';\nimport { b } from './eq';\nimport { m } from './mixed';\nimport { c } from './data.json';\nimport * as all from './data.json';",
      'cjs-star.ts': "export * from './cjs';",
      'cjs.js': 'module.exports.a = 1;',
      // cjs.js may export m as well, so has-m.ts can't be proven the one.
      'mixed.ts': "export * from './cjs';\nexport * from './has-m';",
      'has-m.ts': 'export const m = 1;',
      'eq.ts': 'export = { b: 1 };',
      'data.json': '{}',
    });
    expect(found).toEqual({ a: undefined, b: undefined, m: undefined, c: undefined, all: 'data.json' });
  });

  it('drops a stale resolution when linked again', async () => {
    const [file] = (await Promise.all([parseCode('app.ts', "import { a } from './a';")])) as ParsedFile[];
    const stale = { ...file!, imports: file!.imports.map((i) => ({ ...i, status: 'resolved' as const, resolved: 'a.ts', names: [{ imported: 'a', local: 'a', definedIn: 'a.ts' }] })) };
    const [relinked] = linkImports([stale], createResolver(['app.ts'], () => ''));
    expect(relinked!.imports[0]).toMatchObject({ status: 'unknown', names: [{ imported: 'a', local: 'a' }] });
    expect(relinked!.imports[0]!.resolved).toBeUndefined();
    expect(relinked!.imports[0]!.names![0]!.definedIn).toBeUndefined();
  });
});

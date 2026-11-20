import { describe, expect, it } from 'vitest';
import { parseCode } from '../../src/code/parse.js';

const parse = async (text: string, path = 'a.ts') => (await parseCode(path, text))!;
const brief = (i: { spec: string; kind: string; typeOnly?: boolean; names?: unknown }) => [i.spec, i.kind, i.typeOnly ?? false, i.names];

describe('import extraction', () => {
  it('reads every import form with its names', async () => {
    const { imports } = await parse(
      [
        "import a, { b as c, type d, 'e-f' as e } from './x.js';",
        "import * as ns from 'y';",
        "import type { T } from './t';",
        "import 'side';",
        "import fs = require('fs');",
        "export { g as h, i } from './z';",
        "export * from './w';",
        "export * as nn from './v';",
        "export type { Q } from './q';",
        "const r = require('./r');",
        'const p = import(`./p`);',
        "type X = typeof import('./ty');",
      ].join('\n'),
    );
    expect(imports.map(brief)).toEqual([
      ['./x.js', 'import', false, [{ imported: 'default', local: 'a' }, { imported: 'b', local: 'c' }, { imported: 'd', local: 'd', typeOnly: true }, { imported: 'e-f', local: 'e' }]],
      ['y', 'import', false, [{ imported: '*', local: 'ns' }]],
      ['./t', 'import', true, [{ imported: 'T', local: 'T', typeOnly: true }]],
      ['side', 'import', false, []],
      ['fs', 'require', false, undefined],
      ['./z', 'export', false, [{ imported: 'g', local: 'h' }, { imported: 'i', local: 'i' }]],
      ['./w', 'export', false, [{ imported: '*', local: '*' }]],
      ['./v', 'export', false, [{ imported: '*', local: 'nn' }]],
      ['./q', 'export', true, [{ imported: 'Q', local: 'Q', typeOnly: true }]],
      ['./r', 'require', false, undefined],
      ['./p', 'dynamic', false, undefined],
      ['./ty', 'dynamic', true, undefined],
    ]);
    expect(imports.map((i) => [i.file, i.status, i.range.start.line])).toEqual(imports.map((_, n) => ['a.ts', 'unknown', n + 1]));
  });

  it('skips specifiers decided at run time, other calls and statements inside blocks or syntax errors', async () => {
    const { imports } = await parse("import ok from './ok';\nimport(name);\nrequire(`./${x}`);\nrequire.resolve('./q');\nfoo('./f');\ndeclare module 'm' { import { a } from './in-module'; }\nimport { a b } from './broken';");
    expect(imports.map((i) => i.spec)).toEqual(['./ok']);
  });

  it('reads the JavaScript grammar too', async () => {
    const { imports } = await parse("import a from './a.js';\nconst b = require('./b.cjs');\nexport { c } from './c.mjs';", 'x.mjs');
    expect(imports.map((i) => [i.spec, i.kind])).toEqual([['./a.js', 'import'], ['./b.cjs', 'require'], ['./c.mjs', 'export']]);
  });

  it('lists the own exports, complete only for plain ES modules', async () => {
    const own = await parse('export const a = 1, { b, c: d, ...e } = o;\nexport function f() {}\nexport class G {}\nexport declare const h: number;\nconst i = 1;\nexport { i as j, i };\nexport default i;\nnamespace N { export const inner = 1; }');
    expect(own.exports).toEqual({
      names: [{ name: 'a' }, { name: 'b' }, { name: 'd' }, { name: 'e' }, { name: 'f' }, { name: 'G' }, { name: 'h' }, { name: 'j', local: 'i' }, { name: 'i', local: 'i' }, { name: 'default', local: 'i' }],
      complete: true,
    });
    expect((await parse('export default class {}')).exports.names).toEqual([{ name: 'default' }]);
    const defaults = await parse('export const [x = fallback, { y = other, k: z = more }] = values;');
    expect(defaults.exports.names).toEqual([{ name: 'x' }, { name: 'y' }, { name: 'z' }]);
    const incomplete = await Promise.all([parse('export = x;'), parse('module.exports = {};', 'c.js'), parse('exports.a = 1;', 'c.js'), parse('export const a = ;')]);
    expect(incomplete.map((f) => f.exports.complete)).toEqual([false, false, false, false]);
  });

  it('gives files without a grammar no imports and unknown exports', async () => {
    expect(await parse('{}', 'a.json')).toMatchObject({ imports: [], exports: { names: [], complete: false } });
  });
});

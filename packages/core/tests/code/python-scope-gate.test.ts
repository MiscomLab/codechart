import { describe, expect, it } from 'vitest';
import type { CallRef } from '../../src/code/model.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * COD-59 QA gate: PEP 695 lines no other test pins (surviving mutants). Expectations from CPython 3.14.7, run with
 * `python3 -I`: `symtable` for where `f` is bound, and the runtime for what a module exports.
 */

type Tree = Record<string, string>;

async function link(tree: Tree): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const fCalls = (files: Map<string, ParsedFile>, path: string): CallRef[] => files.get(path)!.calls.filter((c) => c.name === 'f');

describe('gate: a type alias’s own type parameters live only in the alias', () => {
  it('a call after a generic alias in the same function reaches the module function', async () => {
    // symtable: TYPE_ALIAS A binds f (free, the type parameter); FUNCTION run sees f as global. Runtime: run() == "A.F".
    const files = await link({ 'a.py': 'def f(): return "A.F"\ndef run():\n    type A[f] = f()\n    return f()\n' });
    const [inAlias, after] = fCalls(files, 'a.py');
    expect(inAlias).toMatchObject({ evidence: 'name-only' });
    expect(inAlias).not.toHaveProperty('to');
    expect(after).toMatchObject({ to: 'a.py::f::function', evidence: 'resolved' });
  });

  it('another alias in the same function does not see the first alias’s type parameters', async () => {
    // symtable: TYPE_ALIAS B sees f as global.
    const files = await link({ 'a.py': 'def f(): pass\ndef run():\n    type A[f] = int\n    type B = f()\n' });
    expect(fCalls(files, 'a.py')).toEqual([expect.objectContaining({ to: 'a.py::f::function', evidence: 'resolved' })]);
  });

  it.each([
    ['a from-import', 'from a import f\ndef run():\n    f()\n'],
    ['a module attribute', 'import a\ndef run():\n    a.f()\n'],
  ])('a module-level generic alias does not hide the module function from %s', async (_form, b) => {
    // Runtime: with `type A[f] = list[f]` after `def f`, `import a; a.f()` returns "A.F" and `'f' in vars(a)` is True.
    const files = await link({ 'a.py': 'def f(): return "A.F"\ntype A[f] = list[f]\n', 'b.py': b });
    expect(fCalls(files, 'b.py')).toEqual([expect.objectContaining({ to: 'a.py::f::function', evidence: 'resolved' })]);
  });

  it('a re-export after a generic alias of the same name is traced through the import', async () => {
    // Runtime: a.py `type A[f] = list[f]` then `from c import f`; `from a import f; f()` returns c's "C.F".
    const files = await link({
      'a.py': 'type A[f] = list[f]\nfrom c import f\n',
      'c.py': 'def f(): return "C.F"\n',
      'b.py': 'from a import f\ndef run():\n    f()\n',
    });
    expect(fCalls(files, 'b.py')).toEqual([expect.objectContaining({ to: 'c.py::f::function', evidence: 'resolved' })]);
  });
});

describe('gate: only a parameter’s default value is outside its function’s type parameters', () => {
  it('the annotation of a parameter that has a default sees the type parameter', async () => {
    // symtable: ANNOTATION __annotate__ has f free (the type parameter).
    const files = await link({ 'a.py': 'def f(): pass\ndef run[f](x: f() = 1):\n    pass\n' });
    const [call] = fCalls(files, 'a.py');
    expect(call).toMatchObject({ evidence: 'name-only' });
    expect(call).not.toHaveProperty('to');
  });
});

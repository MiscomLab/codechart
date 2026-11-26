import { describe, expect, it } from 'vitest';
import type { CallRef } from '../../src/code/model.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * COD-59 QA gate: calls in a Python definition's header that still resolve to a function the name does not reach.
 * Expectations from CPython 3.14.7 (`python3 -I`): `symtable` for where `f` is bound, and running the code.
 */

type Tree = Record<string, string>;

async function link(tree: Tree): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const fCall = async (text: string): Promise<CallRef> => {
  const calls = (await link({ 'a.py': text })).get('a.py')!.calls.filter((c) => c.name === 'f');
  expect(calls.length).toBe(1);
  return calls[0]!;
};

describe('gate: a lambda that is itself a parameter default binds its own parameters', () => {
  it.each([
    // symtable: FUNCTION lambda has f as a parameter. Runtime: `run()` calls the argument passed to the lambda.
    ['a function default', 'def f(): pass\ndef run(x=lambda f: f()):\n    pass\n'],
    ['a method default', 'def f(): pass\nclass K:\n    def m(self, x=lambda f: f()):\n        pass\n'],
    ['a keyword-only default', 'def f(): pass\ndef run(*, x=lambda f: f()):\n    pass\n'],
  ])('the lambda parameter shadows the module function in %s', async (_form, text) => {
    const call = await fCall(text);
    expect(call.evidence).toBe('name-only');
    expect(call).not.toHaveProperty('to');
  });
});

describe('gate: class bases and keywords run in the enclosing scope, not the class body', () => {
  it.each([
    // Runtime: `def f(): return object` then `class K(f()):\n    class f: pass` gives K.__bases__ == (object,).
    ['a base', 'def f(): return object\nclass K(f()):\n    class f: pass\n'],
    // symtable: MODULE top has f global for the keyword; the class body's `f` is not in scope there.
    ['a keyword', 'def f(): return type\nclass K(metaclass=f()):\n    class f: pass\n'],
  ])('a call in %s reaches the module function, not a class the body defines', async (_form, text) => {
    expect(await fCall(text)).toMatchObject({ to: 'a.py::f::function', evidence: 'resolved' });
  });
});

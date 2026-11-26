import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * COD-59 Python scenarios. Expected values follow Python's own scoping as the compiler's symbol table implements it:
 * a name a scope binds (parameter, assignment, loop/with/except target, comprehension or lambda parameter, walrus,
 * match capture, del, import, def) is what a call to that name means, never a same-named module function. PEP 695
 * type parameters and `type X = …` bind their names in the scope that owns the definition.
 */

const MODULE = 'def f():\n    pass\n\n\n';

async function link(tree: Record<string, string>): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

/** Parses a module with `def f` and the body under test. */
const at = (body: string) => link({ 'a.py': MODULE + body });

function nameOnly(files: Map<string, ParsedFile>, path: string, name: string): void {
  const calls = files.get(path)!.calls.filter((c) => c.name === name);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name, evidence: 'name-only' });
  expect(calls[0]).not.toHaveProperty('to');
}

function resolved(files: Map<string, ParsedFile>, path: string, name: string, to: string): void {
  const calls = files.get(path)!.calls.filter((c) => c.name === name);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name, to, evidence: 'resolved' });
}

describe('a name a Python scope binds never resolves to the module function', () => {
  it.each([
    ['a parameter', 'def run(f):\n    f()\n'],
    ['a local assignment', 'def run(g):\n    f = g\n    f()\n'],
    ['a for target', 'def run(items):\n    for f in items:\n        f()\n'],
    ['an except … as target', 'def run():\n    try:\n        pass\n    except Exception as f:\n        f()\n'],
    ['an except* … as target', 'def run():\n    try:\n        pass\n    except* Exception as f:\n        f()\n'],
    ['a with … as target', 'def run(cm):\n    with cm as f:\n        f()\n'],
    ['a comprehension target', 'def run(items):\n    return [f() for f in items]\n'],
    ['a lambda parameter', 'def run():\n    g = lambda f: f()\n'],
    ['a walrus target', 'def run(g):\n    if (f := g):\n        f()\n'],
    ['a match capture', 'def run(x):\n    match x:\n        case f:\n            f()\n'],
    ['a del target', 'def run():\n    del f\n    f()\n'],
    ['a tuple unpack target', 'def run(pair):\n    f, g = pair\n    f()\n'],
    ['a starred target', 'def run(args):\n    *f, g = args\n    f()\n'],
    ['a **kwargs parameter', 'def run(kw):\n    def g(**f):\n        f()\n'],
    ['a method parameter', 'class K:\n    def m(self, f):\n        f()\n'],
  ])('%s shadows the module function', async (_form, body) => {
    nameOnly(await at(body), 'a.py', 'f');
  });

  it('a parameter shadows an imported name', async () => {
    const files = await link({ 'b.py': MODULE, 'a.py': 'from b import f\n\n\ndef run(f):\n    f()\n' });
    nameOnly(files, 'a.py', 'f');
  });

  it('a nested def resolves to itself', async () => {
    const files = await at('def run():\n    def f():\n        pass\n    f()\n');
    resolved(files, 'a.py', 'f', 'a.py::run.f::function');
  });

  it('a from-import inside the calling function resolves through it', async () => {
    const files = await link({ 'b.py': 'def g():\n    pass\n', 'a.py': 'def run():\n    from b import g as f\n    f()\n' });
    resolved(files, 'a.py', 'f', 'b.py::g::function');
  });

  it('global f resolves the module function', async () => {
    const files = await at('def run():\n    global f\n    f()\n');
    resolved(files, 'a.py', 'f', 'a.py::f::function');
  });

  it('nonlocal f whose outer scope binds f as a value stays name-only', async () => {
    const files = await at('def run():\n    def outer():\n        f = 1\n        def inner():\n            nonlocal f\n            f()\n');
    nameOnly(files, 'a.py', 'f');
  });

  it('a def in a class body does not bind the name in its methods, so the module f resolves', async () => {
    const files = await at('class K:\n    def f():\n        pass\n\n    def m(self):\n        f()\n');
    resolved(files, 'a.py', 'f', 'a.py::f::function');
  });
});

describe('PEP 695 type parameters and type aliases bind names', () => {
  it('a def type parameter shadows the module function', async () => {
    nameOnly(await at('def run[f]():\n    f()\n'), 'a.py', 'f');
  });

  it('a class type parameter shadows the module function in its methods', async () => {
    nameOnly(await at('class K[f]:\n    def m(self):\n        f()\n'), 'a.py', 'f');
  });

  it('a class type parameter shadows the module function in the class body', async () => {
    nameOnly(await at('class K[f]:\n    x = f()\n'), 'a.py', 'f');
  });

  it('a type alias in a function shadows the module function', async () => {
    nameOnly(await at('def run():\n    type f = int\n    f()\n'), 'a.py', 'f');
  });

  it('a module type alias next to the module def makes the name bound twice', async () => {
    const files = await link({ 'a.py': 'def f():\n    pass\n\n\ntype f = int\n\n\ndef run():\n    f()\n' });
    nameOnly(files, 'a.py', 'f');
  });

  it('a class nested in a generic class sees its type parameters', async () => {
    // symtable: `f` in `Inner.m` is free, bound by `K`'s type parameter scope (PEP 695 annotation scope).
    nameOnly(await at('class K[f]:\n    class Inner:\n        def m(self):\n            f()\n'), 'a.py', 'f');
  });

  it('a class type parameter does not leak to module functions', async () => {
    const files = await at('class K[f]:\n    pass\n\n\ndef run():\n    f()\n');
    resolved(files, 'a.py', 'f', 'a.py::f::function');
  });

  it('a default value is evaluated outside the type parameter scope', async () => {
    // `def run[f](a=f())`: defaults are evaluated in the enclosing scope, before the type parameters exist.
    const files = await at('def run[f](a=f()):\n    pass\n');
    resolved(files, 'a.py', 'f', 'a.py::f::function');
  });

  it('a type parameter of another name leaves the module function', async () => {
    const files = await at('def run[T]():\n    f()\n');
    resolved(files, 'a.py', 'f', 'a.py::f::function');
  });
});

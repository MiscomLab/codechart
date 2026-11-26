import { describe, expect, it } from 'vitest';
import { type LinkedFiles as Files, linkFiles as link } from './scope-helpers.js';

/**
 * COD-59 Python scenarios. Expected values follow Python's own scoping as the compiler's symbol table implements it:
 * a name a scope binds (parameter, assignment, loop/with/except target, comprehension or lambda parameter, walrus,
 * match capture, del, import, def) is what a call to that name means, never a same-named module function. PEP 695
 * type parameters and `type X = …` bind their names in the scope that owns the definition.
 */

const MODULE = 'def f():\n    pass\n\n\n';

/** Parses a module with `def f` and the body under test. */
const at = (body: string) => link({ 'a.py': MODULE + body });

function nameOnly(files: Files, path: string, name: string): void {
  const calls = files.get(path)!.calls.filter((c) => c.name === name);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name, evidence: 'name-only' });
  expect(calls[0]).not.toHaveProperty('to');
}

function resolved(files: Files, path: string, name: string, to: string): void {
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

/**
 * Section-B constructs with no explicit test above. Expectations confirmed with Python 3.14 symtable (the scratch
 * py-harness): name-only where Python binds the name in the same or an enclosing scope to something other than the
 * module `f`; resolved where it is the module `f`, the nested def, or an import of it.
 */
describe('section B: parameters, patterns, imports and the remaining scopes', () => {
  it.each([
    ['a default', 'def run(f=1):\n    f()\n'],
    ['a typed', 'def run(f: int):\n    f()\n'],
    ['a typed default', 'def run(f: int = 1):\n    f()\n'],
    ['a *args', 'def run(*f):\n    f()\n'],
    ['a positional-only', 'def run(f, /):\n    f()\n'],
    ['a keyword-only', 'def run(*, f):\n    f()\n'],
  ])('%s parameter shadows the module function', async (_form, body) => {
    nameOnly(await at(body), 'a.py', 'f');
  });

  it('a lambda default parameter shadows the module function', async () => {
    nameOnly(await at('g = lambda f=1: f()\n'), 'a.py', 'f');
  });

  it.each([
    ['a parenthesized tuple pattern', '(f, g) = pair'],
    ['a list pattern', '[f, g] = pair'],
  ])('an assignment with %s shadows the module function', async (_form, target) => {
    nameOnly(await at(`def run(pair):\n    ${target}\n    f()\n`), 'a.py', 'f');
  });

  it('an augmented assignment shadows the module function', async () => {
    nameOnly(await at('def run():\n    f += 1\n    f()\n'), 'a.py', 'f');
  });

  // CPython 3.12+ inlines list/set/dict comprehensions (PEP 709), so Python 3.14's symtable no longer exposes their
  // target; the language reference still scopes the target to the comprehension. Core treats the target as a write in
  // the enclosing function, so the call inside stays name-only. Generator expressions keep their own symtable scope.
  it.each([
    ['a set comprehension', 'return {f() for f in items}'],
    ['a dict comprehension', 'return {f: f() for f in items}'],
    ['a generator expression', 'return (f() for f in items)'],
  ])('%s target shadows the module function inside it', async (_form, expr) => {
    nameOnly(await at(`def run(items):\n    ${expr}\n`), 'a.py', 'f');
  });

  it('a with ... as tuple target shadows the module function', async () => {
    nameOnly(await at('def run(cm):\n    with cm as (f, g):\n        f()\n'), 'a.py', 'f');
  });

  it.each([
    ['an as pattern', 'case 1 as f:\n            f()'],
    ['a sequence pattern', 'case [f, *r]:\n            f()'],
    ['a mapping pattern', "case {'k': f}:\n            f()"],
    ['a mapping rest pattern', 'case {**f}:\n            f()'],
    ['a class keyword pattern', 'case C(x=f):\n            f()'],
    ['a class positional pattern', 'case C(f):\n            f()'],
  ])('a match %s shadows the module function', async (_form, clause) => {
    nameOnly(await at(`def run(x):\n    match x:\n        ${clause}\n`), 'a.py', 'f');
  });

  it('nonlocal f bound to an outer def resolves to that def', async () => {
    const files = await at('def run():\n    def f():\n        pass\n    def inner():\n        nonlocal f\n        f()\n');
    resolved(files, 'a.py', 'f', 'a.py::run.f::function');
  });

  it('a decorated nested def resolves to itself', async () => {
    const files = await at('def run():\n    @deco\n    def f():\n        pass\n    f()\n');
    resolved(files, 'a.py', 'f', 'a.py::run.f::function');
  });

  it('a class body call reaches the class-body def, so the call stays name-only', async () => {
    // symtable binds f in K's class scope; core's truth rule has no class-body target for a bare call.
    nameOnly(await at('class K:\n    def f():\n        pass\n\n    x = f()\n'), 'a.py', 'f');
  });

  it('an import binds a module, not that module’s function', async () => {
    const files = await link({ 'f.py': 'VALUE = 1\n', 'a.py': MODULE + 'def run():\n    import f\n    f()\n' });
    nameOnly(files, 'a.py', 'f');
  });

  it('an aliased dotted import binds a module, not a function', async () => {
    const files = await link({ 'a/__init__.py': 'VALUE = 1\n', 'a/b.py': 'VALUE = 1\n', 'main.py': MODULE + 'def run():\n    import a.b as f\n    f()\n' });
    nameOnly(files, 'main.py', 'f');
  });

  it('a plain from-import resolves through the imported function', async () => {
    const files = await link({ 'b.py': 'def f():\n    pass\n', 'a.py': MODULE + 'def run():\n    from b import f\n    f()\n' });
    resolved(files, 'a.py', 'f', 'b.py::f::function');
  });

  it('a relative from-import resolves through the package attribute', async () => {
    const files = await link({ 'pkg/__init__.py': 'def f():\n    pass\n', 'pkg/mod.py': MODULE + 'def run():\n    from . import f\n    f()\n' });
    resolved(files, 'pkg/mod.py', 'f', 'pkg/__init__.py::f::function');
  });

  it('a wildcard import can rebind the name, so the call stays name-only', async () => {
    // symtable does not model star imports; b exports f, so the wildcard may rebind it and only name-only is sound.
    const files = await link({ 'b.py': 'def f():\n    pass\n', 'a.py': MODULE + 'from b import *\n\n\ndef run():\n    f()\n' });
    nameOnly(files, 'a.py', 'f');
  });
});

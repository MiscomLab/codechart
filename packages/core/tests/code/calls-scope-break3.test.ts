import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';
import { type LinkedFiles as Files, type Tree, linkFiles as link, results } from './scope-helpers.js';

/**
 * COD-59 second-reader pass, round 3: the expressions the latest commit now walks in the enclosing scope (parameter
 * defaults, decorators, class bases/keywords), and the shared state of that change.
 *
 * Python expectations come from CPython 3.14: `python3 -I` with `symtable` and by executing each snippet with an
 * instrumented module `f`/`g`/`deco` (the trigger is named in the comment). A call that reaches a type parameter
 * raises TypeError: 'typing.TypeVar' object is not callable; a call that reaches a module function is logged.
 */

const MODULE = 'def f():\n    return object\n\n\ndef g():\n    return object\n\n\ndef deco(fn):\n    return fn\n\n\n';

const at = (body: string): Promise<Files> => link({ 'a.py': MODULE + body });

describe('round 3: the walk of defaults, decorators and class bases does not over-reach', () => {
  it('a generic def’s defaults still do not see its type parameters, in every parameter position', async () => {
    // Runtime: both defaults call the module f (defaults run in the enclosing scope); run.__defaults__ is (object, object).
    expect(results(await at('def run[f](x=f(), *, y=f()):\n    pass\n'), 'f')).toEqual(['a.py::f::function', 'a.py::f::function']);
  });

  it('a generic body still sees the type parameter while its default reaches the module f', async () => {
    // Runtime: the default calls the module f; the body call raises TypeError TypeVar not callable.
    expect(results(await at('def run[f](x=f()):\n    f()\n'), 'f')).toEqual(['a.py::f::function', undefined]);
  });

  it('a walrus in a generic default binds the enclosing scope, not the type parameter', async () => {
    // Runtime: the default does `f := g` then `f()`, which calls the module g; the type parameter is not in scope.
    expect(results(await at('def run[f](x=((f := g), f())[1]):\n    pass\n'), 'f')).toEqual([undefined]);
  });

  it('a walrus inside a lambda in a default is recorded conservatively, not as the module function', async () => {
    // Runtime: the walrus binds a lambda local, so other() reaches the module f; core records the write in the
    // enclosing scope and answers name-only. Safe under the truth rule, at the cost of that true edge (lambda scopes
    // are not modelled; the same over-approximation exists for lambdas in bodies).
    expect(results(await at('def run(x=(lambda: (f := 1))):\n    pass\n\n\ndef other():\n    f()\n'), 'f')).toEqual([undefined]);
  });

  it('a walrus inside a called lambda in a default stays name-only', async () => {
    // Runtime: run.__defaults__[0]() raises TypeError 'int' object is not callable: the callee is the lambda local.
    expect(results(await at('def run(x=(lambda: ((f := 1), f())[1])):\n    pass\n'), 'f')).toEqual([undefined]);
  });

  it('a walrus in a comprehension in a decorator binds the containing scope', async () => {
    // Runtime: PEP 572 makes the walrus bind the module f to deco, so other() calls deco; the module def f is no
    // longer the value, and name-only is the safe answer.
    expect(results(await at('@([(f := deco) for _ in range(1)][0])\ndef run():\n    pass\n\n\ndef other():\n    f(run)\n'), 'f')).toEqual([undefined]);
  });

  it('a nested def’s default writes the enclosing function’s local', async () => {
    // Runtime: outer() returns g: the walrus in inner’s default binds outer’s local f.
    expect(results(await at('def outer():\n    def inner(x=(f := g)):\n        pass\n    f()\n'), 'f')).toEqual([undefined]);
  });

  it('a call after the walrus in a nested def’s default sees that write', async () => {
    // Runtime: outer() returns g: the default does `f := g` then `f()` in outer’s scope.
    expect(results(await at('def outer():\n    def inner(x=((f := g), f())[1]):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a metaclass keyword walrus reaches the enclosing scope', async () => {
    // Runtime: after `class K(metaclass=(f := M))`, module f is M; other() creates a class through M.
    expect(results(await at('class M(type):\n    pass\n\n\nclass K(metaclass=(f := M)):\n    pass\n\n\ndef other():\n    f("X", (), {})\n'), 'f')).toEqual([undefined]);
  });

  it('a call after the walrus inside a metaclass keyword sees that write', async () => {
    // Runtime: the keyword evaluates `f := M` then calls f, i.e. M; the class is created through M.
    expect(results(await at('class M(type):\n    pass\n\n\nclass K(metaclass=((f := M), f("X", (), {}))[1]):\n    pass\n'), 'f')).toEqual([undefined]);
  });

  it('a method default’s walrus writes the class body scope, not the module', async () => {
    // Runtime: the default binds K.f; a module call f() is still the module f.
    expect(results(await at('class K:\n    def m(self, x=(f := g)):\n        pass\n\n\ndef other():\n    f()\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('a method default’s walrus is invisible to a method body, so it still resolves the module f', async () => {
    // Runtime: methods do not see class attributes; K().m2() calls the module f.
    expect(results(await at('class K:\n    def m1(self, x=(f := g)):\n        pass\n    def m2(self):\n        f()\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('a method default still sees the class type parameter, apart from its own type parameters', async () => {
    // Runtime: class creation raises TypeError TypeVar not callable (the class body evaluates the default).
    expect(results(await at('class K[f]:\n    def m(self, x=f()):\n        pass\n'), 'f')).toEqual([undefined]);
  });
});

describe('round 3: calls in a method’s defaults and annotations run in the class body', () => {
  it('a call after the walrus in the same method default sees the class-body write', async () => {
    // Runtime: the default evaluates `f := g` in the class body, then `f()` calls g (K.m.__defaults__ == (g,)).
    // Core resolves the module f: the caller is K.m and scopeChain skips the class scope, so the class-body write the
    // new walk records is invisible to the call that shares its expression.
    expect(results(await at('class K:\n    def m(self, x=((f := g), f())[1]):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a later method’s default sees the class-body write of an earlier method’s default', async () => {
    // Runtime: m1’s default binds K.f = g; m2’s default then calls g (K.m2.__defaults__ == (g,)).
    expect(results(await at('class K:\n    def m1(self, x=(f := g)):\n        pass\n    def m2(self, x=f()):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a class-body function shadows the module function in a method default', async () => {
    // Runtime: `class K: def g(): return "class-g"; def m(self, x=g())` -> K.m.__defaults__ == ('class-g',)
    // and the module g is never called: the callee is the class-body function, not the module one.
    expect(results(await at('class K:\n    def g():\n        pass\n    def m(self, x=g()):\n        pass\n'), 'g')).toEqual([undefined]);
  });

  it('a class-body binding is visible in a method annotation', async () => {
    // Runtime: K.m.__annotations__ evaluates f() with the class namespace, so it calls the class-body g.
    expect(results(await at('class K:\n    f = g\n    def m(self, x: f()):\n        pass\n'), 'f')).toEqual([undefined]);
  });
});

describe('round 3: shared state of the newly walked expressions', () => {
  const WRITES = 'class K:\n    def m(self, x=((f := g), f())[1]):\n        pass\n\n\n@(h := deco)\ndef run(a=(h := g)):\n    pass\n\n\nclass L((h := object),):\n    pass\n';

  it('a Python file parsed after one whose defaults, decorators and bases write names resolves as when parsed alone', async () => {
    const body = 'def run(x: f()):\n    pass\n';
    const alone = results(await link({ 'a.py': MODULE + body }), 'f');
    await link({ 'w.py': MODULE + WRITES });
    expect(results(await link({ 'a.py': MODULE + body }), 'f')).toEqual(alone);
  });

  it('parsing another file does not mutate the bindings an earlier parse stored', async () => {
    const first = (await parseCode('a.py', MODULE + WRITES))!;
    const snapshot = JSON.stringify(first.bindings);
    await parseCode('b.py', MODULE + 'def other(x=(h := g)):\n    pass\n');
    await parseCode('c.py', 'class M(type):\n    pass\n\n\nclass K(metaclass=(h := M)):\n    pass\n');
    expect(JSON.stringify(first.bindings)).toBe(snapshot);
  });

  it('linking the same Python parsed files twice yields the same calls', async () => {
    const tree: Tree = { 'a.py': MODULE + WRITES, 'b.py': 'def run(x: f()):\n    pass\n' };
    const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
    const resolver = () => createResolver(Object.keys(tree), (path) => tree[path]);
    expect(linkCode(parsed, resolver()).map((f) => f.calls)).toEqual(linkCode(parsed, resolver()).map((f) => f.calls));
  });

  it('the same file parsed twice keeps the same bindings', async () => {
    const text = MODULE + WRITES;
    const once = (await parseCode('a.py', text))!;
    const twice = (await parseCode('a.py', text))!;
    expect(JSON.stringify(twice.bindings)).toBe(JSON.stringify(once.bindings));
    expect(twice.calls.map((c) => c.to)).toEqual(once.calls.map((c) => c.to));
  });
});

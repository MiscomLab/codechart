import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';
import { type LinkedFiles as Files, type Tree, linkFiles as link, results } from './scope-helpers.js';

/**
 * COD-59 second-reader pass, round 4: the header chain (`ParsedFile.defs`, `<id>#typeparams`) and the nested scopes
 * inside a class body or a method header.
 *
 * Python expectations come from CPython 3.14.7: `python3 -I` with `symtable` and by executing each snippet with an
 * instrumented module `f`/`g`/`deco` (the trigger is named in the comment). The key rule these tests pin: a class body
 * is not an enclosing scope for a lambda body, a comprehension element/condition or a generator expression — those see
 * the class's enclosing function/module; but a lambda's parameter default, a comprehension's iterable and a plain
 * default expression are evaluated in the class body and do see its names.
 */

const MODULE = 'def f():\n    return object\n\n\ndef g():\n    return object\n\n\ndef deco(fn):\n    return fn\n\n\n';

const at = (body: string): Promise<Files> => link({ 'a.py': MODULE + body });

describe('round 4: eager parts of a header or class body see the class body', () => {
  it('a lambda’s parameter default in a method default sees the class body', async () => {
    // Runtime: K.m.__defaults__[0]() is the class-body f instance (the default argument was evaluated in the class body).
    expect(results(await at('class K:\n    class f:\n        pass\n    def m(self, x=(lambda a=f(): a)):\n        pass\n'), 'f')).toEqual(['a.py::K.f::class']);
  });

  it('a comprehension’s iterable in a method default sees the class body', async () => {
    // Runtime: K.m.__defaults__ == ([1],): the iterable was evaluated in the class body and used the class-body f.
    expect(results(await at('class K:\n    class f:\n        def __iter__(self):\n            return iter([1])\n    def m(self, xs=[x for x in f()]):\n        pass\n'), 'f')).toEqual(['a.py::K.f::class']);
  });

  it('a generator expression’s iterable in a method default sees the class body', async () => {
    // Runtime: K.m.__defaults__ == ([1],): the outermost iterable is evaluated in the class body.
    expect(results(await at('class K:\n    class f:\n        def __iter__(self):\n            return iter([1])\n    def m(self, xs=list(x for x in f())):\n        pass\n'), 'f')).toEqual(['a.py::K.f::class']);
  });

  it('a lambda’s parameter default in a class body sees the class body', async () => {
    // Runtime: K.direct is the class-body f instance.
    expect(results(await at('class K:\n    class f:\n        pass\n    direct = (lambda a=f(): a)()\n'), 'f')).toEqual(['a.py::K.f::class']);
  });

  it('a comprehension’s iterable in a class body sees the class body', async () => {
    // Runtime: K.xs == [1]: the iterable is evaluated in the class body.
    expect(results(await at('class K:\n    class f:\n        def __iter__(self):\n            return iter([1])\n    xs = [x for x in f()]\n'), 'f')).toEqual(['a.py::K.f::class']);
  });

  it('a method body lambda and comprehension do not see the class body', async () => {
    // Runtime: K().m() == ('module-f', ['module-f']): class bodies are not enclosing scopes inside a method.
    const files = await at('class K:\n    class f:\n        pass\n    def m(self):\n        return (lambda: f())(), [f() for _ in range(1)]\n');
    expect(results(files, 'f')).toEqual(['a.py::f::function', 'a.py::f::function']);
  });

  it('an earlier nested class is visible in a method default', async () => {
    // Runtime: K.n.__defaults__ == (K.F(),): the class body bound F before the def.
    expect(results(await at('class K:\n    class F:\n        pass\n    def n(self, x=F()):\n        pass\n'), 'F')).toEqual(['a.py::K.F::class']);
  });
});

describe('round 4: a class body is not an enclosing scope inside a lambda or comprehension', () => {
  it('a lambda body in a method default does not see the class body', async () => {
    // Runtime: K.m.__defaults__[0]() == 'module-f': the lambda's f is global, not K.f.
    // Core resolves the class-body K.f; name-only is the safe answer. New with the header chain (before it, a method
    // header skipped the class scope).
    expect(results(await at('class K:\n    class f:\n        pass\n    def m(self, x=(lambda: f())):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a comprehension element in a method default does not see the class body', async () => {
    // Runtime: K.m.__defaults__ == (['module-f'],): the element is evaluated in the comprehension scope, f is global.
    expect(results(await at('class K:\n    class f:\n        pass\n    def m(self, xs=[f() for _ in range(1)]):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a comprehension condition in a method default does not see the class body', async () => {
    // Runtime: the condition is evaluated in the comprehension scope, so f is global.
    expect(results(await at('class K:\n    class f:\n        pass\n    def m(self, xs=[x for x in range(1) if f()]):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a generator expression element in a method default does not see the class body', async () => {
    // Runtime: K.m.__defaults__ == (['module-f'],): the element runs in the generator’s own scope, f is global.
    expect(results(await at('class K:\n    class f:\n        pass\n    def m(self, xs=list(f() for _ in range(1))):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a lambda body in a class body does not see the class body', async () => {
    // Runtime: K.direct == 'module-f'.
    expect(results(await at('class K:\n    class f:\n        pass\n    direct = (lambda: f())()\n'), 'f')).toEqual([undefined]);
  });

  it('a comprehension element in a class body does not see the class body', async () => {
    // Runtime: K.xs == ['module-f'].
    expect(results(await at('class K:\n    class f:\n        pass\n    xs = [f() for _ in range(1)]\n'), 'f')).toEqual([undefined]);
  });

  it('a generator expression element in a class body does not see the class body', async () => {
    // Runtime: K.xs == ['module-f'].
    expect(results(await at('class K:\n    class f:\n        pass\n    xs = list(f() for _ in range(1))\n'), 'f')).toEqual([undefined]);
  });
});

describe('round 4: a class-body binding is not visible before it is bound', () => {
  it('a later nested class is not visible in an earlier method default', async () => {
    // Runtime: K1.n.__defaults__ == (Base,): the default ran before `class F` bound K.F; the module F was called.
    // Before 282d009 a method header skipped the class scope and resolved the module F (the right answer here).
    expect(results(await at('class Base:\n    pass\n\n\ndef F():\n    return Base\n\n\nclass K:\n    def n(self, x=F()):\n        pass\n    class F:\n        pass\n'), 'F')).toEqual([undefined]);
  });

  it('a later class-body import is not visible in an earlier method default', async () => {
    // Runtime: K2.n.__defaults__ == ('module-f',): the class body had not run the import yet.
    const files = await link({
      'a.py': MODULE + 'class K:\n    def n(self, x=f()):\n        pass\n    from c import f\n',
      'c.py': 'def f():\n    return object\n',
    });
    expect(results(files, 'f')).toEqual([undefined]);
  });
});

describe('round 4: methods in nested classes and generic methods', () => {
  it('a nested class’s own binding is visible in its decorator, its defaults and its annotations', async () => {
    // Runtime: the decorator, default and annotation all use Inner.f (the decorator logged 'inner-f'); Outer.f is not
    // visible in Inner’s body at all.
    const files = await at(
      'class Outer:\n    class f:\n        pass\n    class Inner:\n        class f:\n            def __call__(self, fn):\n                return fn\n        @f()\n        def deco_m(self):\n            pass\n        def m(self, x=f()):\n            pass\n        def a(self, x: f()):\n            pass\n',
    );
    expect(results(files, 'f')).toEqual(['a.py::Outer.Inner.f::class', 'a.py::Outer.Inner.f::class', 'a.py::Outer.Inner.f::class']);
  });

  it('an outer class’s binding is not visible in a nested class’s defaults or annotations', async () => {
    // Runtime: Inner.m.__defaults__ == ('module-f',) and Inner.a.__annotations__ == {'x': 'module-f'}.
    const files = await at('class Outer:\n    class f:\n        pass\n    class Inner:\n        def m(self, x=f()):\n            pass\n        def a(self, x: f()):\n            pass\n');
    expect(results(files, 'f')).toEqual(['a.py::f::function', 'a.py::f::function']);
  });

  it('an outer generic class’s type parameter is visible in a method default of a nested class', async () => {
    // Runtime: class creation raises TypeError TypeVar not callable (the default runs inside Outer’s body).
    expect(results(await at('class Outer[f]:\n    class Inner:\n        def m(self, x=f()):\n            pass\n'), 'f')).toEqual([undefined]);
  });

  it('a generic method’s header: class body names resolve, its own type parameter is hidden in defaults and live in annotations', async () => {
    // Runtime: K.m.__defaults__ == (K.h(), object?) — z=h() is K.h; w=g() is the module g. Annotations evaluate f and g
    // as the type parameters (TypeError TypeVar not callable).
    const files = await at('class K[f]:\n    class h:\n        pass\n    def m[g](self, z=h(), w=g(), x: f() = 1, y: g() = 2):\n        pass\n');
    expect(results(files, 'h')).toEqual(['a.py::K.h::class']);
    // Source order: the default w=g() reaches the module g, the annotation y: g() is the type parameter (name-only).
    expect(results(files, 'g')).toEqual(['a.py::g::function', undefined]);
  });
});

describe('round 4: defs nested in methods, global/nonlocal, module headers, async defs', () => {
  it('a def nested in a method sees the method’s local def and not the class body', async () => {
    // Runtime: inner’s default is the method-local f (defined before inner); the class-body f is not in scope.
    const local = await at('class K:\n    f = g\n    def m(self):\n        def f():\n            pass\n        def inner(x=f()):\n            pass\n');
    expect(results(local, 'f')).toEqual(['a.py::K.m.f::function']);
    const invisible = await at('class K:\n    f = g\n    def m(self):\n        def inner(x=f()):\n            pass\n');
    expect(results(invisible, 'f')).toEqual(['a.py::f::function']);
  });

  it('a global declaration in a body does not change a module def’s header call', async () => {
    // Runtime: the default f() calls the module f before the body runs.
    expect(results(await at('def run(x=f()):\n    global f\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('a nonlocal declaration in a body does not change a nested def’s header call', async () => {
    // Runtime: inner’s default is outer’s local def f.
    expect(results(await at('def outer():\n    def f():\n        pass\n    def inner(x=f()):\n        nonlocal f\n'), 'f')).toEqual(['a.py::outer.f::function']);
  });

  it('a global declaration in a method body does not change its header’s class-body call', async () => {
    // Runtime: the default is the class-body f instance; the body’s `global f` only affects body writes.
    expect(results(await at('class K:\n    class f:\n        pass\n    def m(self, x=f()):\n        global f\n'), 'f')).toEqual(['a.py::K.f::class']);
  });

  it('a module-level def header reaches the module f, and its own type parameter stays name-only', async () => {
    // Runtime: run.__defaults__ == (object,); run2.__annotations__ raises TypeError TypeVar not callable.
    expect(results(await at('def run(x=f()):\n    pass\n'), 'f')).toEqual(['a.py::f::function']);
    expect(results(await at('def run2[f](x: f()):\n    pass\n'), 'f')).toEqual([undefined]);
  });

  it('async defs use the same header chain', async () => {
    // Runtime: run.__defaults__ == (object,); run2’s annotation is the TypeVar; K.m’s default is the class-body f;
    // inner’s default is outer’s local f.
    expect(results(await at('async def run(x=f()):\n    pass\n'), 'f')).toEqual(['a.py::f::function']);
    expect(results(await at('async def run2[f](x: f()):\n    pass\n'), 'f')).toEqual([undefined]);
    expect(results(await at('class K:\n    class f:\n        pass\n    async def m(self, x=f()):\n        pass\n'), 'f')).toEqual(['a.py::K.f::class']);
    expect(results(await at('def outer():\n    def f():\n        pass\n    async def inner(x=f()):\n        pass\n'), 'f')).toEqual(['a.py::outer.f::function']);
  });
});

describe('round 4: shared state of the header chain', () => {
  const DEFS = 'def f():\n    pass\n\n\ndef run(x=f()):\n    pass\n\n\nclass K:\n    class h:\n        pass\n    def m[g](self, z=h(), x: g() = 1):\n        pass\n';

  it('a Python file parsed after one with defs and headers resolves as when parsed alone', async () => {
    const body = 'class J:\n    class f:\n        pass\n    def n(self, x=f()):\n        pass\n';
    const alone = results(await link({ 'a.py': MODULE + body }), 'f');
    await link({ 'w.py': MODULE + DEFS });
    expect(results(await link({ 'a.py': MODULE + body }), 'f')).toEqual(alone);
  });

  it('parsing another file does not mutate the bindings or defs an earlier parse stored', async () => {
    const first = (await parseCode('a.py', MODULE + DEFS))!;
    const bindings = JSON.stringify(first.bindings);
    const defs = JSON.stringify(first.defs);
    await parseCode('b.py', MODULE + DEFS);
    await parseCode('c.py', 'class K:\n    def m(self, x: f()):\n        pass\n');
    expect(JSON.stringify(first.bindings)).toBe(bindings);
    expect(JSON.stringify(first.defs)).toBe(defs);
  });

  it('linking the same Python parsed files twice yields the same calls', async () => {
    const tree: Tree = { 'a.py': MODULE + DEFS, 'b.py': 'class K:\n    def m(self, x: f()):\n        pass\n' };
    const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
    const resolver = () => createResolver(Object.keys(tree), (path) => tree[path]);
    expect(linkCode(parsed, resolver()).map((f) => f.calls)).toEqual(linkCode(parsed, resolver()).map((f) => f.calls));
  });

  it('the same file parsed twice keeps the same bindings, defs and calls', async () => {
    const text = MODULE + DEFS;
    const once = (await parseCode('a.py', text))!;
    const twice = (await parseCode('a.py', text))!;
    expect(JSON.stringify(twice.bindings)).toBe(JSON.stringify(once.bindings));
    expect(JSON.stringify(twice.defs)).toBe(JSON.stringify(once.defs));
    expect(twice.calls.map((c) => c.to)).toEqual(once.calls.map((c) => c.to));
  });
});

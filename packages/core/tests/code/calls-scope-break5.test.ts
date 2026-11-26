import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * COD-59 second-reader pass, round 5: the deferred/eager split, class headers, class-body order and the headers of
 * defs that sit inside a conditional or try block in a class body.
 *
 * Python expectations come from CPython 3.14.7: `python3 -I` with `symtable` and by executing each snippet with
 * instrumented module functions `f`/`g` whose calls are logged (the log is quoted at each case). The rules these tests
 * pin:
 *  - a nested class statement is executed by the enclosing class body, so its bases/keywords see the enclosing class
 *    body (but not its own);
 *  - a def inside if/try in a class body is still a method of that class at run time;
 *  - a lambda body / comprehension element, condition or later iterable skips a class body in between (name-only is
 *    acceptable when that class body may bind the same name), while the eager positions (lambda parameter defaults,
 *    first comprehension iterables, plain defaults/annotations) see it.
 */

type Tree = Record<string, string>;
type Files = Map<string, ParsedFile>;

const MODULE = 'class Base:\n    pass\n\n\ndef f():\n    return Base\n\n\ndef g():\n    return Base\n\n\ndef deco(fn):\n    return fn\n\n\n';

async function link(tree: Tree): Promise<Files> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const fileOf = (files: Files, path = 'a.py'): ParsedFile => files.get(path)!;

/** Every call `name` in the file's source order, as its resolved target or undefined for name-only. */
const results = (files: Files, name: string, path = 'a.py'): (string | undefined)[] =>
  fileOf(files, path)
    .calls.filter((c) => c.name === name)
    .map((c) => c.to);

const at = (body: string): Promise<Files> => link({ 'a.py': MODULE + body });

describe('round 5: a class header nested in a class body sees the enclosing class body', () => {
  it('a nested class base sees the enclosing class body', async () => {
    // Runtime: `class Outer: f = g; class Inner(f()): pass` calls g (calls log ['class-f']) and Inner inherits g’s Base.
    // Core resolves the module f; the class body’s f is another function, so name-only is the safe answer.
    expect(results(await at('class Outer:\n    f = g\n    class Inner(f()):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a nested class keyword sees the enclosing class body', async () => {
    // Runtime: the metaclass keyword evaluates in Outer’s class body and calls g (class creation then fails because g
    // returns a plain class); the callee is g, not the module f.
    expect(results(await at('class Outer:\n    f = g\n    class Inner(metaclass=f()):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a comprehension’s first iterable in a nested class base sees the enclosing class body', async () => {
    // Runtime: the first iterable is evaluated in Outer’s class body and calls g (calls log ['class-f']).
    expect(results(await at('class Outer:\n    f = g\n    class Inner(*[x for x in f()]):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a lambda’s parameter default in a nested class base sees the enclosing class body', async () => {
    // Runtime: the lambda’s default is evaluated in Outer’s class body and calls g (calls log ['class-f']).
    expect(results(await at('class Outer:\n    f = g\n    class Inner((lambda a=f(): a)()):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a nested class in an if block still sees the enclosing class body', async () => {
    // Runtime: the class statement inside the if is executed by Outer’s class body and calls g.
    expect(results(await at('class Outer:\n    f = g\n    if True:\n        class Inner(f()):\n            pass\n'), 'f')).toEqual([undefined]);
  });
});

describe('round 5: a def inside if/try in a class body is still a method for its header', () => {
  it('the default of a def inside an if block sees the class body', async () => {
    // Runtime: `class K: f = g; if True: def m(self, x=f()): pass` calls g (calls log ['class-g2'], default 'g2').
    // Core classifies the def as a function (symbols.pythonMethod only takes direct class-body defs), so its header
    // chain skips the class body and resolves the module f.
    expect(results(await at('class K:\n    f = g\n    if True:\n        def m(self, x=f()):\n            pass\n'), 'f')).toEqual([undefined]);
  });

  it('the default of a def inside a try block sees the class body', async () => {
    // Runtime: same — the default runs in the class body and calls g.
    expect(results(await at('class K:\n    f = g\n    try:\n        def m(self, x=f()):\n            pass\n    except Exception:\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a lambda’s parameter default in an if-def’s default sees the class body', async () => {
    // Runtime: the lambda default is evaluated in the class body and calls g (calls log ['class-g2']).
    expect(results(await at('class K:\n    f = g\n    if True:\n        def m(self, x=(lambda a=f(): a)):\n            pass\n'), 'f')).toEqual([undefined]);
  });
});

describe('round 5: nested class headers where the class body is the wrong scope', () => {
  it('a nested class header in a method does not see the class body', async () => {
    // Runtime: the base is evaluated in the method body; f is the module f.
    expect(results(await at('class K:\n    f = g\n    def m(self):\n        class Inner(f()):\n            pass\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('a nested class header in a function sees the function’s local', async () => {
    // Runtime: the base is evaluated in the class body whose enclosing scope is outer; outer’s f is called.
    expect(results(await at('def outer():\n    def f():\n        return Base\n    class K:\n        class Inner(f()):\n            pass\n'), 'f')).toEqual(['a.py::outer.f::function']);
  });
});

describe('round 5: deferred vs eager nesting combinations', () => {
  it('a lambda in a class body closes over the enclosing function, not the class body', async () => {
    // Runtime: `K.g()` calls outer’s f (calls log ['outer-f']).
    expect(results(await at('def outer():\n    def f():\n        return Base\n    class K:\n        g = (lambda: f())\n'), 'f')).toEqual(['a.py::outer.f::function']);
  });

  it('a comprehension element in a class body closes over the enclosing function, not the class body', async () => {
    // Runtime: the element calls outer’s f (calls log ['outer-f']).
    expect(results(await at('def outer():\n    def f():\n        return Base\n    class K:\n        xs = [f() for _ in range(1)]\n'), 'f')).toEqual(['a.py::outer.f::function']);
  });

  it('a lambda inside a comprehension iterable uses the lambda body’s scope', async () => {
    // Runtime: the lambda body calls the module f in a class body (class scope skipped); in a def it calls the module f too.
    expect(results(await at('class K:\n    f = g\n    xs = [y for y in (lambda: f())()]\n'), 'f')).toEqual([undefined]);
    expect(results(await at('def run(x=[y for y in (lambda: f())()]):\n    pass\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('a lambda’s parameter default inside a comprehension iterable sees the class body when the value is a class', async () => {
    // Runtime: the lambda default is evaluated in the class body and uses the class-body f (a class; calls log empty
    // because constructing the class does not call the module functions).
    expect(results(await at('class K:\n    class f:\n        def __call__(self):\n            return [1]\n    xs = [y for y in (lambda a=f(): [a])()]\n'), 'f')).toEqual(['a.py::K.f::class']);
  });

  it('a comprehension inside a lambda default uses the lambda body’s scope', async () => {
    // Runtime: calling the lambda runs the element with f from the module (class scope skipped); the def case reaches
    // the module f when called.
    expect(results(await at('class K:\n    f = g\n    xs = (lambda: [f() for _ in range(1)])\n'), 'f')).toEqual([undefined]);
    expect(results(await at('def run(x=(lambda: [f() for _ in range(1)])):\n    pass\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('a nested comprehension’s second iterable is deferred', async () => {
    // Runtime: the second iterable runs in the comprehension scope, so a class body is skipped (module f); a method body
    // reaches the module f.
    expect(results(await at('class K:\n    f = g\n    xs = [y for x in [1] for y in f()]\n'), 'f')).toEqual([undefined]);
    expect(results(await at('class K:\n    f = g\n    def m(self):\n        return [y for x in [1] for y in f()]\n'), 'f')).toEqual(['a.py::f::function']);
  });
});

describe('round 5: decorators and class headers containing lambdas or comprehensions', () => {
  it('a decorator comprehension’s first iterable sees the class body', async () => {
    // Runtime: the first iterable is evaluated in the class body and uses K.f (calls log ['K.f iter']).
    expect(results(await at('class K:\n    class f:\n        def __iter__(self):\n            return iter([deco])\n    @([x for x in f()][0])\n    def m(self):\n        pass\n'), 'f')).toEqual(['a.py::K.f::class']);
  });

  it('a decorator comprehension’s element skips the class body', async () => {
    // Runtime: the element calls the module f (calls log ['f']); name-only is the safe answer.
    expect(results(await at('class K:\n    class f:\n        def __call__(self, fn):\n            return fn\n    @([f() for _ in range(1)][0])\n    def m(self):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a decorator lambda’s parameter default sees the class body', async () => {
    // Runtime: the default is evaluated in the class body and uses K.f (the class constructor; no module call).
    expect(results(await at('class K:\n    class f:\n        def __call__(self, fn):\n            return fn\n    @(lambda a=f(): a)\n    def m(self):\n        pass\n'), 'f')).toEqual(['a.py::K.f::class']);
  });

  it('a class header lambda body, parameter default and comprehension element', async () => {
    // Runtime: the lambda body and the comprehension element call the module f (class body skipped / not created);
    // the lambda’s parameter default is evaluated in the enclosing scope and calls the module f.
    expect(results(await at('class K((lambda: f())()):\n    pass\n'), 'f')).toEqual([undefined]);
    expect(results(await at('class K((lambda a=f(): a)()):\n    pass\n'), 'f')).toEqual(['a.py::f::function']);
    expect(results(await at('class K(*[f() for _ in range(1)]):\n    pass\n'), 'f')).toEqual([undefined]);
  });
});

describe('round 5: the class body binds in order; del and rebinding demote', () => {
  it('a class-body rebinding before or after a method default stays name-only', async () => {
    // Runtime: before -> g is called; after -> the module f is called. Core cannot prove the class-body value either
    // way, so both are name-only.
    expect(results(await at('class K:\n    f = g\n    def m(self, x=f()):\n        pass\n'), 'f')).toEqual([undefined]);
    expect(results(await at('class K:\n    def m(self, x=f()):\n        pass\n    f = g\n'), 'f')).toEqual([undefined]);
  });

  it('a nested class bound before a method default resolves; one bound after stays name-only', async () => {
    // Runtime: before -> K.f (the class constructor), after -> the module f.
    expect(results(await at('class K:\n    class f:\n        pass\n    def m(self, x=f()):\n        pass\n'), 'f')).toEqual(['a.py::K.f::class']);
    expect(results(await at('class K:\n    def m(self, x=f()):\n        pass\n    class f:\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a class-body del before or after a method default stays name-only', async () => {
    // Runtime: after a del (or with only a del) the class body falls back to the module f; before the del it is K.f.
    // Core’s ordered class bindings leave every one of these name-only.
    expect(results(await at('class K:\n    class f:\n        pass\n    del f\n    def m(self, x=f()):\n        pass\n'), 'f')).toEqual([undefined]);
    expect(results(await at('class K:\n    del f\n    def m(self, x=f()):\n        pass\n'), 'f')).toEqual([undefined]);
    expect(results(await at('class K:\n    def m(self, x=f()):\n        pass\n    del f\n'), 'f')).toEqual([undefined]);
  });

  it('a walrus in a class body is not visible before it runs', async () => {
    // Runtime: before the walrus -> module f; after -> the walrus value g (a function). Both are name-only in core:
    // before because the class binding is later, after because a walrus is not a provable function.
    expect(results(await at('class K:\n    def m(self, y=f()):\n        pass\n    x = (f := g)\n'), 'f')).toEqual([undefined]);
    expect(results(await at('class K:\n    x = (f := g)\n    def m(self, y=f()):\n        pass\n'), 'f')).toEqual([undefined]);
  });
});

describe('round 5: shared state of the header/deferred data', () => {
  const HEADERS = 'class Outer:\n    f = g\n    class Inner(f()):\n        pass\n\n\nclass K:\n    f = g\n    xs = [y for y in (lambda: f())()]\n\n\ndef run(x=(lambda: f())):\n    pass\n';

  it('a file with headers and deferred ranges parsed after another resolves as when parsed alone', async () => {
    const body = 'class J:\n    class f:\n        pass\n    def n(self, x=f()):\n        pass\n';
    const alone = results(await link({ 'a.py': MODULE + body }), 'f');
    await link({ 'w.py': MODULE + HEADERS });
    expect(results(await link({ 'a.py': MODULE + body }), 'f')).toEqual(alone);
  });

  it('parsing another file does not mutate an earlier parse’s bindings, defs or deferred ranges', async () => {
    const first = (await parseCode('a.py', MODULE + HEADERS))!;
    const bindings = JSON.stringify(first.bindings);
    const defs = JSON.stringify(first.defs);
    const deferred = JSON.stringify(first.deferred);
    await parseCode('b.py', MODULE + HEADERS);
    await parseCode('c.py', 'class K:\n    class f:\n        pass\n    def m(self, x=f()):\n        pass\n');
    expect(JSON.stringify(first.bindings)).toBe(bindings);
    expect(JSON.stringify(first.defs)).toBe(defs);
    expect(JSON.stringify(first.deferred)).toBe(deferred);
  });

  it('linking the same parsed files twice yields the same calls', async () => {
    const tree: Tree = { 'a.py': MODULE + HEADERS, 'b.py': 'class K:\n    def m(self, x: f()):\n        pass\n' };
    const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
    const resolver = () => createResolver(Object.keys(tree), (path) => tree[path]);
    expect(linkCode(parsed, resolver()).map((f) => f.calls)).toEqual(linkCode(parsed, resolver()).map((f) => f.calls));
  });

  it('the same file parsed twice keeps the same bindings, defs, deferred ranges and calls', async () => {
    const text = MODULE + HEADERS;
    const once = (await parseCode('a.py', text))!;
    const twice = (await parseCode('a.py', text))!;
    expect(JSON.stringify(twice.bindings)).toBe(JSON.stringify(once.bindings));
    expect(JSON.stringify(twice.defs)).toBe(JSON.stringify(once.defs));
    expect(JSON.stringify(twice.deferred)).toBe(JSON.stringify(once.deferred));
    expect(twice.calls.map((c) => c.to)).toEqual(once.calls.map((c) => c.to));
  });
});

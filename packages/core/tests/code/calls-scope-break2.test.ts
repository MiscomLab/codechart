import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * COD-59 second-reader pass, round 2: the PEP 695 fix (commit 3129911) and the shared state of the whole branch.
 * The first-round cases live in `calls-scope-break.test.ts`; this file breaks the new visibility windows.
 *
 * Python expectations come from CPython 3.14's own scoping, quoted per case. Every case was run with `python3 -I`
 * (3.14.7) via `symtable` and by executing the snippet (module `f`/`g` appended, then the trigger named in the
 * comment); a call that reaches a type parameter raises TypeError: 'typing.TypeVar' object is not callable, a call
 * that reaches the module function appends to the call log. The oracle harness is in the scratch dir, not the repo.
 */

type Tree = Record<string, string>;
type Files = Map<string, ParsedFile>;

const MODULE = 'def f():\n    return object\n\n\ndef g():\n    return object\n\n\n';

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

/** Parses one Python module with the `f`/`g` prelude and links it alone. */
const at = (body: string): Promise<Files> => link({ 'a.py': MODULE + body });

describe('round 2: decorators on generic definitions', () => {
  it('a decorator on a generic def or class is outside its definition: core claims nothing', async () => {
    // Runtime: the decorator expression is evaluated in the enclosing scope before the def; `f()` is the module f.
    // Core makes no call at all (the decorator sits outside the definition symbol), which is name-only and safe.
    for (const body of ['@f()\ndef run[f]():\n    pass\n', '@f()\nclass K[f]:\n    pass\n']) {
      const files = await at(body);
      expect(results(files, 'f')).toEqual([]);
    }
  });

  it('a decorator on a def nested in a generic function sees the enclosing type parameter', async () => {
    // Runtime: outer() raises TypeError TypeVar not callable before inner is bound.
    expect(results(await at('def outer[f]():\n    @f()\n    def inner():\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a decorator on a method inside a generic class sees the class type parameter', async () => {
    // Runtime: class creation raises TypeError TypeVar not callable.
    expect(results(await at('class K[f]:\n    @f()\n    def m(self):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a decorator on a generic method in a plain class is the module f', async () => {
    // Runtime: the class body evaluates the decorator; the method's own type parameter is not in scope there.
    expect(results(await at('class K:\n    @f()\n    def m[f](self):\n        pass\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('a decorator on a generic class nested in a generic function sees the outer type parameter', async () => {
    // Runtime: outer() raises TypeError TypeVar not callable.
    expect(results(await at('def outer[f]():\n    @f()\n    class Inner[g]:\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a decorator on a generic method inside a generic class sees the class type parameter', async () => {
    // Runtime: class creation raises TypeError TypeVar not callable.
    expect(results(await at('class K[f]:\n    @f()\n    def m[g](self):\n        pass\n'), 'f')).toEqual([undefined]);
  });
});

describe('round 2: nested generic definitions', () => {
  it('a generic method’s annotation sees the class type parameter', async () => {
    // Runtime: K.m.__annotations__ raises TypeError TypeVar not callable.
    expect(results(await at('class K[f]:\n    def m[g](self, x: f()):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a generic method’s default does not see its own type parameter, but does reach the module g', async () => {
    // Runtime: class creation calls the module g (the default is evaluated in the class body).
    expect(results(await at('class K[f]:\n    def m[g](self, x=g()):\n        pass\n'), 'g')).toEqual(['a.py::g::function']);
  });

  it('a nested generic class’s method annotation sees the outer class type parameter', async () => {
    // Runtime: K.Inner.m.__annotations__ raises TypeError TypeVar not callable.
    expect(results(await at('class K[f]:\n    class Inner[g]:\n        def m(self, x: f()):\n            pass\n'), 'f')).toEqual([undefined]);
  });

  it('a class nested in a generic function sees the function type parameter in its methods', async () => {
    // Runtime: outer().m.__annotations__ raises TypeError TypeVar not callable.
    expect(results(await at('def outer[f]():\n    class Inner:\n        def m(self, x: f()):\n            pass\n'), 'f')).toEqual([undefined]);
  });

  it('a method default sees the enclosing class type parameter', async () => {
    // Runtime: class creation raises TypeError TypeVar not callable (the default runs in the class body).
    expect(results(await at('class K[f]:\n    def m[g](self, x=f()):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a nested class base and keyword see the enclosing function type parameter', async () => {
    // Runtime: outer() raises TypeError TypeVar not callable for both the base and the metaclass keyword.
    for (const inner of ['class Inner(f()):\n        pass', 'class Inner(metaclass=f()):\n        pass']) {
      expect(results(await at(`def outer[f]():\n    ${inner}\n`), 'f')).toEqual([undefined]);
    }
  });

  it('a nested generic def with the same type-parameter name still binds in its default to the outer one', async () => {
    // Runtime: outer() raises TypeError TypeVar not callable: the default runs in outer’s body.
    expect(results(await at('def outer[f]():\n    def inner[f](x=f()):\n        pass\n'), 'f')).toEqual([undefined]);
  });

  it('a nested generic def with another name reaches the module g in its default', async () => {
    // Runtime: outer() calls the module g.
    expect(results(await at('def outer[f]():\n    def inner[g](x=g()):\n        pass\n'), 'g')).toEqual(['a.py::g::function']);
  });
});

describe('round 2: lambda and expression defaults', () => {
  it('a lambda in a default captures the enclosing scope, not the type parameter', async () => {
    // Runtime: run.__defaults__[0]() calls the module f.
    expect(results(await at('def run[f](x=lambda: f()):\n    pass\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('a lambda in a generic body captures the type parameter', async () => {
    // Runtime: run()() raises TypeError TypeVar not callable.
    expect(results(await at('def run[f]():\n    return lambda: f()\n'), 'f')).toEqual([undefined]);
  });

  it('a lambda in a generic class body captures the class type parameter', async () => {
    // Runtime: K.g() raises TypeError TypeVar not callable.
    expect(results(await at('class K[f]:\n    g = lambda: f()\n'), 'f')).toEqual([undefined]);
  });

  it.each([
    ['a comprehension', 'def run[f](x=[f() for _ in range(1)]):\n    pass\n'],
    ['a generator expression', 'def run[f](x=(f() for _ in range(1))):\n    pass\n'],
    ['an immediately called lambda', 'def run[f](x=(lambda: f())()):\n    pass\n'],
    ['a conditional', 'def run[f](x=f() if g else g()):\n    pass\n'],
  ])('%s in a default reaches the module f', async (_form, body) => {
    // Runtime: the default executes at def time in the enclosing scope and calls the module f.
    expect(results(await at(body), 'f')).toEqual(['a.py::f::function']);
  });

  it('an annotation after a default still sees the type parameter', async () => {
    // Runtime: the default calls the module g, then run.__annotations__ raises TypeError TypeVar not callable.
    const files = await at('def run[f](x=g(), y: f() = 1):\n    pass\n');
    expect(results(files, 'g')).toEqual(['a.py::g::function']);
    expect(results(files, 'f')).toEqual([undefined]);
  });

  it('an annotation on a defaulted parameter sees the type parameter while the default reaches the module g', async () => {
    // Runtime: the default calls the module g; run.__annotations__ raises TypeError TypeVar not callable.
    const files = await at('def run[f](x: f() = g()):\n    pass\n');
    expect(results(files, 'f')).toEqual([undefined]);
    expect(results(files, 'g')).toEqual(['a.py::g::function']);
  });

  it('a type-parameter bound calling another name reaches the module g', async () => {
    // Runtime: run.__type_params__[0].__bound__ calls the module g.
    expect(results(await at('def run[T: g()]():\n    pass\n'), 'g')).toEqual(['a.py::g::function']);
  });

  it('a call in a class body annotation sees the class type parameter', async () => {
    // Runtime: K.__annotations__ raises TypeError TypeVar not callable.
    expect(results(await at('class K[f]:\n    x: f()\n'), 'f')).toEqual([undefined]);
  });

  it('a call in a plain class body annotation reaches the module f', async () => {
    // Runtime: K.__annotations__ calls the module f.
    expect(results(await at('class K:\n    x: f()\n'), 'f')).toEqual(['a.py::f::function']);
  });
});

describe('round 2: keyword-only, positional-only and starred parameters', () => {
  it('a keyword-only default reaches the module f', async () => {
    // Runtime: the default runs at def time in the enclosing scope.
    expect(results(await at('def run[f](*, x=f()):\n    pass\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('a keyword-only annotation sees the type parameter', async () => {
    // Runtime: run.__annotations__ raises TypeError TypeVar not callable.
    expect(results(await at('def run[f](*, x: f()):\n    pass\n'), 'f')).toEqual([undefined]);
  });

  it('a positional-only default reaches the module f', async () => {
    // Runtime: the default runs at def time in the enclosing scope.
    expect(results(await at('def run[f](x=f(), /):\n    pass\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('a keyword-only annotation sees the type parameter while its default reaches the module f', async () => {
    // Runtime: the default calls the module f; run.__annotations__ raises TypeError TypeVar not callable.
    expect(results(await at('def run[f](*, x: f() = f()):\n    pass\n'), 'f')).toEqual([undefined, 'a.py::f::function']);
  });

  it.each([
    ['a *args annotation', 'def run[f](*args: f()):\n    pass\n'],
    ['a **kwargs annotation', 'def run[f](**kw: f()):\n    pass\n'],
  ])('%s sees the type parameter', async (_form, body) => {
    // Runtime: run.__annotations__ raises TypeError TypeVar not callable.
    expect(results(await at(body), 'f')).toEqual([undefined]);
  });

  it('mixed starred annotations both see the type parameter', async () => {
    // Runtime: run.__annotations__ raises TypeError TypeVar not callable.
    expect(results(await at('def run[f](a, *args: f(), **kw: f()):\n    pass\n'), 'f')).toEqual([undefined, undefined]);
  });
});

describe('round 2: PEP 696 type-parameter defaults in this grammar', () => {
  it.each([
    ['a self-referencing type-parameter default', 'def run[f = f()]():\n    pass\n'],
    ['a type-parameter default referencing a later parameter', 'def run[T = g(), f = int](x: f()):\n    pass\n'],
    ['a type-alias type-parameter default', 'type A[f = f()] = int\n'],
  ])('%s parses with error nodes and no call is resolved', async (_form, body) => {
    // CPython 3.14 accepts these (PEP 696): evaluating run.__type_params__[0].__default__ or A.__type_params__[0].
    // __default__ raises TypeError TypeVar not callable. tree-sitter-python 0.23.2 reports ERROR nodes, so core reads
    // no call there; the assertion is that no call to f is resolved (name-only is the safe answer).
    const parsed = (await parseCode('a.py', MODULE + body))!;
    expect(parsed.calls.filter((c) => c.to)).toEqual([]);
  });
});

describe('round 2: type aliases nested in functions and classes', () => {
  it.each([
    ['a function', 'def run():\n    type A[f] = f()\n'],
    ['a class body', 'class K:\n    type A[f] = f()\n'],
    ['a nested class in a function', 'def run():\n    class K:\n        type A[f] = f()\n'],
    ['a lambda in the alias value', 'def run():\n    type A[f] = (lambda: f())\n'],
  ])('a call in the value of an alias in %s stays name-only', async (_form, body) => {
    // Runtime: evaluating the alias value (A.__value__ or the lambda it holds) raises TypeError TypeVar not callable.
    expect(results(await at(body), 'f')).toEqual([undefined]);
  });

  it('an alias type parameter does not leak to a call after the alias', async () => {
    // Runtime: run() calls the module f; the alias value is lazy and its type parameter is local to it.
    expect(results(await at('def run():\n    type A[f] = f()\n    f()\n'), 'f')).toEqual([undefined, 'a.py::f::function']);
  });

  it('an alias type parameter does not leak to the class body after the alias', async () => {
    // Runtime: the class body call is the module f.
    expect(results(await at('class K:\n    type A[f] = f()\n    x = f()\n'), 'f')).toEqual([undefined, 'a.py::f::function']);
  });

  it('a call after the alias on the same line is outside its type-parameter window', async () => {
    // Runtime: run() calls the module f; the alias value is lazy.
    expect(results(await at('def run():\n    type A[f] = f(); f()\n'), 'f')).toEqual([undefined, 'a.py::f::function']);
  });

  it('an alias inside an if block keeps its type parameter local to the alias', async () => {
    // Runtime: run(False) calls the module f.
    expect(results(await at('def run(c):\n    if c:\n        type A[f] = f()\n    f()\n'), 'f')).toEqual([undefined, 'a.py::f::function']);
  });

  it('a call in an alias type-parameter bound sees the alias type parameters', async () => {
    // Runtime: A.__type_params__[0].__bound__ raises TypeError TypeVar not callable.
    expect(results(await at('def run():\n    type A[f: f()] = int\n'), 'f')).toEqual([undefined]);
  });

  it('a call in a later alias parameter’s bound sees an earlier alias type parameter', async () => {
    // Runtime: A.__type_params__[1].__bound__ raises TypeError TypeVar not callable.
    expect(results(await at('def run():\n    type A[f, T: f()] = int\n'), 'f')).toEqual([undefined]);
  });

  it('an alias value with another type-parameter name still reaches the module f', async () => {
    // Runtime: A.__value__ calls the module f.
    expect(results(await at('def run():\n    type A[T] = f()\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('an alias in a class body does not leak its type parameter into a method', async () => {
    // Runtime: K().m() calls the module f (class scopes are skipped).
    expect(results(await at('class K:\n    type A[f] = int\n    def m(self):\n        f()\n'), 'f')).toEqual(['a.py::f::function']);
  });

  it('an alias in a generic body shadows the enclosing type parameter only inside the alias', async () => {
    // Runtime: inside the alias the callee is the alias type parameter; after it, it is the function’s type parameter
    // (run() raises TypeError TypeVar not callable). Both are not the module f, so both stay name-only.
    expect(results(await at('def run[f]():\n    type A[f] = f()\n    f()\n'), 'f')).toEqual([undefined, undefined]);
  });
});

describe('round 2: alias names and alias type parameters do not leak', () => {
  it('two aliases with the same type-parameter name filter independently', async () => {
    // Runtime: both alias values raise TypeError TypeVar not callable when evaluated; the call after them is the
    // module f (run() calls it).
    expect(results(await at('def run():\n    type A[f] = f()\n    type B[f] = f()\n    f()\n'), 'f')).toEqual([
      undefined,
      undefined,
      'a.py::f::function',
    ]);
  });

  it('a type alias name shadows the module function', async () => {
    // Runtime: run() returns the TypeAliasType and calling it raises TypeError TypeAliasType not callable.
    expect(results(await at('def run():\n    type f = int\n    f()\n'), 'f')).toEqual([undefined]);
  });

  it('an alias type parameter shadows an alias name of the same name inside the alias', async () => {
    // Runtime: A.__value__ calls the type parameter, TypeError TypeVar not callable.
    expect(results(await at('def run():\n    type f = int\n    type A[f] = f()\n'), 'f')).toEqual([undefined]);
  });

  it('an alias name and a later def of the same name stay unprovable', async () => {
    // Runtime: the local def wins at call time; core cannot prove which declaration the call reaches (two bindings).
    expect(results(await at('def run():\n    type f = int\n    def f():\n        pass\n    f()\n'), 'f')).toEqual([undefined]);
  });

  it('a global alias type parameter stays local to the alias', async () => {
    // Runtime: inside the alias the type parameter wins; after it, the call is the module f (run() calls it).
    expect(results(await at('def run():\n    global f\n    type A[f] = f()\n    f()\n'), 'f')).toEqual([undefined, 'a.py::f::function']);
  });

  it('a nonlocal alias type parameter is conservative everywhere', async () => {
    // Runtime: inside the alias the type parameter wins; after it, the nonlocal f is the outer int (calling it raises
    // TypeError 'int' object is not callable). Neither is the module f.
    expect(results(await at('def outer():\n    f = 1\n    def run():\n        nonlocal f\n        type A[f] = f()\n        f()\n'), 'f')).toEqual([undefined, undefined]);
  });
});

describe('round 2: star imports, exports and tracing skip alias type parameters', () => {
  it('a star import keeps a call in an alias value name-only', async () => {
    // Runtime: a star import can rebind any module name, so the module f is not provable; the alias type parameter is
    // the local binding inside the alias (TypeError TypeVar not callable when evaluated).
    const files = await link({ 'a.py': 'from c import *\n\n\ndef run():\n    type A[f] = f()\n', 'c.py': 'def f():\n    return object\n' });
    expect(results(files, 'f')).toEqual([undefined]);
    expect(fileOf(files).exports.complete).toBe(false);
  });

  it('an alias type parameter is not a module export: a module function of the same name is', async () => {
    // Runtime: `from a import f` gets a function; `a.py` defines f and a module-level type A[f].
    const files = await link({
      'a.py': 'def f():\n    return object\n\n\ntype A[f] = int\n',
      'b.py': 'from a import f\n\n\ndef run():\n    f()\n',
    });
    expect(results(files, 'f', 'b.py')).toEqual(['a.py::f::function']);
  });

  it('an alias type parameter alone exports nothing: the import resolves no function', async () => {
    // Runtime: `from a import f` raises ImportError (a2 in the scratch run).
    const files = await link({ 'a.py': 'type A[f] = int\n', 'b.py': 'from a import f\n\n\ndef run():\n    f()\n' });
    expect(results(files, 'f', 'b.py')).toEqual([undefined]);
  });

  it.each([
    ['before', 'type A[f] = int\n\n\nfrom c import f\n'],
    ['after', 'from c import f\n\n\ntype A[f] = int\n'],
  ])('an import of the same name %s the alias is the module binding', async (_form, a) => {
    // Runtime: a3/a5 in the scratch run: `from a import f` gets c1.f.
    const files = await link({ 'a.py': a, 'b.py': 'from a import f\n\n\ndef run():\n    f()\n', 'c.py': 'def f():\n    return object\n' });
    expect(results(files, 'f', 'b.py')).toEqual(['c.py::f::function']);
  });

  it('an alias type parameter does not hide a class of the same name', async () => {
    // Runtime: a4: `from a import f` gets the class.
    const files = await link({
      'a.py': 'type A[f] = int\n\n\nclass f:\n    pass\n',
      'b.py': 'from a import f\n\n\ndef run():\n    f()\n',
    });
    expect(results(files, 'f', 'b.py')).toEqual(['a.py::f::class']);
  });

  it('the tracer skips an alias type parameter when following an import of the same name', async () => {
    // Runtime: a5: module a’s f is c1.f, so `a.f()` calls c1.f.
    const files = await link({
      'a.py': 'type A[f] = int\n\n\nfrom c import f\n',
      'b.py': 'import a\n\n\ndef run():\n    a.f()\n',
      'c.py': 'def f():\n    return object\n',
    });
    expect(results(files, 'f', 'b.py')).toEqual(['c.py::f::function']);
  });

  it('an alias type parameter does not hide a submodule boundary', async () => {
    // Runtime: `from pkg import f` imports pkg/f.py; the call has no function target, so name-only.
    const files = await link({
      'pkg/__init__.py': 'type A[f] = int\n',
      'pkg/f.py': 'def f():\n    return object\n',
      'b.py': 'from pkg import f\n\n\ndef run():\n    f()\n',
    });
    expect(results(files, 'f', 'b.py')).toEqual([undefined]);
  });

  it('a module-level alias named f with a type parameter f exports the alias name only', async () => {
    // Runtime: `from a import f` gets the TypeAliasType; calling it raises TypeError, so name-only is right.
    const files = await link({ 'a.py': 'type f[f] = int\n', 'b.py': 'from a import f\n\n\ndef run():\n    f()\n' });
    expect(results(files, 'f', 'b.py')).toEqual([undefined]);
  });
});

describe('round 2: writes in expressions evaluated in the enclosing scope', () => {
  it('a walrus in a parameter default rebinds the name the call later reaches', async () => {
    // Runtime (`python3 -I`): `def run(x=(f := g))` sets module f to g; other() -> 'g'. symtable: module f assigned.
    // Core reads no write in the default and resolves the module f declaration, a different function.
    const files = await at('def run(x=(f := g)):\n    pass\n\n\ndef other():\n    f()\n');
    expect(results(files, 'f')).toEqual([undefined]);
  });

  it('a walrus in a decorator rebinds the name the call later reaches', async () => {
    // Runtime: `@(f := deco)` sets module f to deco; other() calls deco(run) and returns run.
    const files = await link({
      'a.py': 'def f():\n    return object\n\n\ndef deco(fn):\n    return fn\n\n\n@(f := deco)\ndef run():\n    pass\n\n\ndef other():\n    f(run)\n',
    });
    expect(results(files, 'f')).toEqual([undefined]);
  });

  it('a walrus in a class base rebinds the name the call later reaches', async () => {
    // Runtime: `class K((f := Base))` sets module f to Base; other() calls Base() and gets a Base instance.
    const files = await link({
      'a.py': 'class Base:\n    pass\n\n\ndef f():\n    return object\n\n\nclass K((f := Base)):\n    pass\n\n\ndef other():\n    f()\n',
    });
    expect(results(files, 'f')).toEqual([undefined]);
  });
});

describe('round 2: shared state', () => {
  it('a Python file with generic annotations and an alias resolves as when parsed alone', async () => {
    const body = 'def run(x: f()):\n    pass\n';
    const alone = results(await link({ 'a.py': MODULE + body }), 'f');
    await link({ 'w.py': MODULE + 'def r[f]():\n    type A[f] = f()\n' });
    expect(results(await link({ 'a.py': MODULE + body }), 'f')).toEqual(alone);
  });

  it('parsing another file does not mutate the bindings an earlier parse stored', async () => {
    const first = (await parseCode('a.py', MODULE + 'def run[f]():\n    type A[f] = f()\n    f()\n'))!;
    const snapshot = JSON.stringify(first.bindings);
    await parseCode('b.py', MODULE + 'def other[f](x: f() = f()):\n    pass\n');
    await parseCode('c.py', 'type A[f] = int\n\n\ndef g():\n    type B[f] = f()\n');
    expect(JSON.stringify(first.bindings)).toBe(snapshot);
  });

  it('linking the same Python parsed files twice yields the same calls', async () => {
    const tree: Tree = { 'a.py': 'from c import f\n\n\ndef run():\n    f()\n', 'c.py': 'def f():\n    return object\n' };
    const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
    const resolver = () => createResolver(Object.keys(tree), (path) => tree[path]);
    expect(linkCode(parsed, resolver()).map((f) => f.calls)).toEqual(linkCode(parsed, resolver()).map((f) => f.calls));
  });

  it('an alias with its own type parameter parsed after another alias resolves as when parsed alone', async () => {
    const body = 'def run():\n    type A[f] = f()\n    f()\n';
    const alone = results(await link({ 'a.py': MODULE + body }), 'f');
    await link({ 'w.py': MODULE + 'def r():\n    type B[f] = f()\n' });
    expect(results(await link({ 'a.py': MODULE + body }), 'f')).toEqual(alone);
  });
});

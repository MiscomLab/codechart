import { describe, expect, it } from 'vitest';
import { linkFiles, resolvedOne } from './scope-helpers.js';

/**
 * COD-59 round 2: the causes the first round's gates did not cover, checked against the runtime that executes each
 * program. Every expectation is name-only (`to` undefined) unless the runtime reaches a symbol core should name.
 * Oracle: CPython 3.14.7 (`python3 -I`) for Python and node 25 / tsc 6.0.3 for JavaScript and TypeScript; the observed
 * result is in the comment above each program.
 */

/** Every call named `name` in `path`, as its resolved target or undefined for name-only. */
const targets = async (tree: Record<string, string>, path: string, name = 'f'): Promise<(string | undefined)[]> => {
  const files = await linkFiles(tree);
  return (files.get(path)?.calls ?? []).filter((call) => call.name === name).map((call) => call.to);
};

const PY_K = 'class K:\n    def f(self): return "K.f"\n    def m(self): return self.f()\n';

describe('round 2: Python dispatch refuses a target the runtime does not reach', () => {
  it('P1 a base earlier in the MRO defines f', async () => {
    // CPython 3.14: L().m() -> "X.f"; K's own f is never reached on an L.
    expect(
      await targets({
        'k.py': PY_K,
        'l.py': 'from k import K\nclass X:\n    def f(self): return "X.f"\nclass L(X, K):\n    pass\nL().m()\n',
      }, 'k.py'),
    ).toEqual([undefined]);
  });

  it.each([
    // CPython 3.14: L().m() -> "L.f" (the override on L wins for every non-name base form).
    ['a subscript base', 'bs = [K]\nclass L(bs[0]):\n    def f(self): return "L.f"\n'],
    ['a call base', 'def b(): return K\nclass L(b()):\n    def f(self): return "L.f"\n'],
    ['a starred base', 'bases = (K,)\nclass L(*bases):\n    def f(self): return "L.f"\n'],
    ['a type() base', 'L = type("L", (K,), {"f": lambda self: "L.f"})\n'],
  ])('P2 %s', async (_form, lBody) => {
    expect(await targets({ 'k.py': PY_K, 'l.py': `from k import K\n${lBody}L().m()\n` }, 'k.py')).toEqual([undefined]);
  });

  it.each([
    // CPython 3.14: `import a; a.run()` -> 2; b.py rebinds the module's f after a.py defined it.
    ['a direct module name', 'import a\na.f = lambda: 2\n'],
    // CPython 3.14: `import a; a.run()` -> 2.
    ['an aliased module name', 'import a as z\nz.f = lambda: 2\n'],
  ])('P3 another module rebinds the module function through %s', async (_form, bText) => {
    expect(
      await targets({
        'a.py': 'def f(): return 1\ndef run(): return f()\nimport b\n',
        'b.py': bText,
      }, 'a.py'),
    ).toEqual([undefined]);
  });

  it.each([
    // CPython 3.14: run() -> 2; the module attribute is the written lambda, not b.f.
    ['a direct write', 'b.f = lambda: 2\n', 2],
    // CPython 3.14: run() -> 2.
    ['setattr', 'setattr(b, "f", lambda: 2)\n', 2],
    // CPython 3.14: run() raises AttributeError: module 'b' has no attribute 'f'.
    ['a delete', 'del b.f\n', 'AttributeError'],
  ])('P4 a call on an imported module attribute ignores %s', async (_form, write, result) => {
    expect(result).toBeDefined();
    expect(
      await targets({ 'a.py': `import b\n${write}\ndef run():\n    return b.f()\n`, 'b.py': 'def f(): return 1\n' }, 'a.py'),
    ).toEqual([undefined]);
  });

  it('P5 __getattribute__ written from outside the class intercepts f', async () => {
    // CPython 3.14: K().m() -> "K.getattribute"; the written __getattribute__ returns the callable for f.
    expect(
      await targets({
        'a.py': 'class K:\n    def f(self): return "K.f"\n    def m(self): return self.f()\ndef g(self, name):\n    if name == "f": return lambda: "K.getattribute"\n    return object.__getattribute__(self, name)\nK.__getattribute__ = g\nK().m()\n',
      }, 'a.py'),
    ).toEqual([undefined]);
  });

  it('P5 __new__ written from outside the class returns another type', async () => {
    // CPython 3.14: K().m() -> "Other.f"; the written __new__ returns an Other instance.
    expect(
      await targets({
        'a.py': 'class K:\n    def f(self): return "K.f"\n    def m(self): return self.f()\nOther = type("Other", (K,), {"f": lambda self: "Other.f", "__new__": object.__new__})\nK.__new__ = lambda cls: Other()\nK().m()\n',
      }, 'a.py'),
    ).toEqual([undefined]);
  });

  it('P6 delattr exposes a base method', async () => {
    // CPython 3.14: K().m() -> "Base.f"; delattr(K, "f") removes the class's own method.
    expect(
      await targets({
        'a.py': 'class Base:\n    def f(self): return "Base.f"\nclass K(Base):\n    def f(self): return "K.f"\n    def m(self): return self.f()\ndelattr(K, "f")\nK().m()\n',
      }, 'a.py'),
    ).toEqual([undefined]);
  });

  it('P6 del globals() removes the module function', async () => {
    // CPython 3.14: run() raises NameError: name 'f' is not defined.
    expect(
      await targets({ 'a.py': 'def f(): return 1\ndef run(): return f()\ndel globals()["f"]\n' }, 'a.py'),
    ).toEqual([undefined]);
  });

  it('P6 del sys.modules[__name__].f removes the module function', async () => {
    // CPython 3.14: run() raises NameError: name 'f' is not defined.
    expect(
      await targets({ 'a.py': 'import sys\ndef f(): return 1\ndef run(): return f()\ndel sys.modules[__name__].f\n' }, 'a.py'),
    ).toEqual([undefined]);
  });

  it.each([
    // CPython 3.14: L().m() -> "L.f"; m is K.m but its self is an L.
    ['L.m = K.m', 'class L:\n    def f(self): return "L.f"\nL.m = K.m\nL().m()\n'],
    // CPython 3.14: L().m() -> "L.f".
    ['m = K.m in L body', 'class L:\n    def f(self): return "L.f"\n    m = K.m\nL().m()\n'],
  ])('P7 a method object escapes through %s', async (_form, lBody) => {
    expect(await targets({ 'a.py': `${PY_K}${lBody}` }, 'a.py')).toEqual([undefined]);
  });

  it('P8 import pkg.f in __init__.py replaces the exported function with the submodule', async () => {
    // CPython 3.14: `from pkg import f` binds the pkg.f module; f() raises TypeError: 'module' object is not callable.
    // main (139609c) resolves the same wrong arrow: pkg/__init__.py::f::function.
    expect(
      await targets({
        'pkg/__init__.py': 'def f(): return 1\nimport pkg.f\n',
        'pkg/f.py': 'def f(): return 2\n',
        'a.py': 'from pkg import f\ndef run():\n    return f()\n',
      }, 'a.py'),
    ).toEqual([undefined]);
  });
});

const TS_K = 'export class K {\n  f() { return "K.f"; }\n  m() { return this.f(); }\n}\n';

/** tsc's one declaration of `f`: the class method on line 2 of `file`. */
const methodAt = (file: string, line = 2) => ({ kind: 'MethodDeclaration', parentKind: 'ClassDeclaration', file, line });

describe('round 2: JS/TS dispatch refuses a target the runtime does not reach', () => {
  it.each([
    // node 25: new L().m() -> "L.f".
    ['a call', "import { K } from './k';\nfunction b() { return K; }\nexport class L extends b() {\n  f() { return 'L.f'; }\n}\n"],
    // node 25: new L().m() -> "L.f".
    ['a subscript', "import { K } from './k';\nconst bs = [K];\nexport class L extends bs[0] {\n  f() { return 'L.f'; }\n}\n"],
  ])('J1 a class extends %s resolves to K.f (tsc; an unresolved base is a blind spot)', async (_form, lText) => {
    // Compiler line: tsc gives this.f() exactly one declaration, K.f; the unresolved base writes nothing core can see.
    await resolvedOne({ 'k.ts': TS_K, 'l.ts': lText }, 'k.ts', 'k.ts::K.f::method', methodAt('k.ts'));
  });

  it.each([
    // node 25: new K().m() -> "defined".
    ['Object.defineProperty', "import { K } from './k';\nObject.defineProperty(K.prototype, 'f', { value() { return 'defined'; } });\n"],
    // node 25: new K().m() -> "assigned".
    ['Object.assign', "import { K } from './k';\nObject.assign(K.prototype, { f() { return 'assigned'; } });\n"],
    // node 25: delete K.prototype.f; new K().m() throws TypeError: this.f is not a function.
    ['delete', "import { K } from './k';\ndelete (K.prototype as any).f;\n"],
  ])('J2 a prototype write through %s replaces the method', async (_form, wText) => {
    expect(await targets({ 'k.ts': TS_K, 'w.ts': wText }, 'k.ts')).toEqual([undefined]);
  });

  it('J3 a sloppy-mode direct eval in a .js script resolves to f (tsc; direct eval is a blind spot)', async () => {
    // node 25 (.js, sloppy): m() -> 2; the direct eval's assignment replaces the function declaration.
    // Compiler line: tsc gives f() exactly one declaration, the function f.
    await resolvedOne(
      { 'a.js': "function f() { return 1; }\nfunction m() { eval('f = function () { return 2; };'); return f(); }\nm();\n" },
      'a.js',
      'a.js::f::function',
      { kind: 'FunctionDeclaration', parentKind: 'SourceFile', file: 'a.js', line: 1 },
    );
  });

  it.each([
    // node 25: (K.prototype.m).call(new L()) -> "L.f".
    ['a lost method object', 'class K {\n  f() { return "K.f"; }\n  m() { return this.f(); }\n}\nclass L {\n  f() { return "L.f"; }\n}\nconst m = K.prototype.m;\n(m as any).call(new L());\n'],
    // node 25: K.prototype.m.call(new L()) -> "L.f".
    ['Function.prototype.call', 'class K {\n  f() { return "K.f"; }\n  m() { return this.f(); }\n}\nclass L {\n  f() { return "L.f"; }\n}\n(K.prototype.m as any).call(new L());\n'],
    // node 25: setPrototypeOf(o, K.prototype) keeps o's own f, so o.m() -> "own.f".
    ['Object.setPrototypeOf', 'class K {\n  f() { return "K.f"; }\n  m() { return this.f(); }\n}\nconst o: any = { f: () => "own.f" };\nObject.setPrototypeOf(o, K.prototype);\no.m();\n'],
  ])('J4 a method receiver escapes through %s: this.f() resolves to K.f (tsc; an escaped receiver is a blind spot)', async (_form, aText) => {
    // Compiler line: tsc gives this.f() exactly one declaration, K.f; K.prototype.m is read, never written.
    await resolvedOne({ 'a.ts': aText }, 'a.ts', 'a.ts::K.f::method', methodAt('a.ts'));
  });

  it('J5 an enum member is visible in a later initializer', async () => {
    // tsc 6.0.3: TS2349 This expression is not callable; Type 'Number' has no call signatures (f is enum member E.f).
    // The emitted call is E.f(), so node 25 raises TypeError: f is not a function; a.ts::f is never reached.
    expect(await targets({ 'a.ts': 'function f() { return 1; }\nenum E { f = 1, A = f() }\n' }, 'a.ts')).toEqual([undefined]);
  });

  it.each([
    // node 25: new L().m() -> "L.f".
    ['a re-exported alias', {
      'k.ts': TS_K,
      'm.ts': "export { K as Base } from './k';\n",
      'l.ts': "import { Base } from './m';\nexport class L extends Base {\n  f() { return 'L.f'; }\n}\n",
    }],
    // node 25: new L().m() -> "L.f".
    ['a cast alias', {
      'k.ts': TS_K,
      'l.ts': "import { K } from './k';\nconst Base = K as any;\nexport class L extends Base {\n  f() { return 'L.f'; }\n}\n",
    }],
  ])('J6 a class extends %s resolves to K.f (tsc; an alias base is a blind spot)', async (_form, tree) => {
    // Compiler line: tsc gives this.f() exactly one declaration, K.f; the alias is no write.
    await resolvedOne(tree as Record<string, string>, 'k.ts', 'k.ts::K.f::method', methodAt('k.ts'));
  });
});

describe('round 2: precision', () => {
  it('a computed write on an object or array literal cannot rebind a class method', async () => {
    // Precision: sound refinement, COD-59 round 2
    // node 25: new K().m() -> "K.f"; o[key] and arr[i] write properties of local literals, not K.prototype.
    expect(
      await targets({
        'a.ts': 'class K {\n  f() { return "K.f"; }\n  m() { return this.f(); }\n}\nconst key = "x";\nconst i = 0;\nconst o: Record<string, number> = {};\no[key] = 1;\nconst arr: number[] = [];\narr[i] = 1;\n',
      }, 'a.ts'),
    ).toEqual(['a.ts::K.f::method']);
  });
});

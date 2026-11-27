import { describe, expect, it } from 'vitest';
import { linkFiles } from './scope-helpers.js';

/**
 * COD-59 round 4 (gate on 1160703): a module rebound through any spelling of `sys.modules`, a repeated `importlib`,
 * the importer's own `globals()`, a function's `__globals__` or the module's `__class__`; and option B on a class field
 * when the method declares its own `this` type. Every expectation is name-only (`to` undefined) unless the runtime
 * reaches the symbol core names. Oracle: CPython 3.14.7 (`python3 -I`, cwd on sys.path; `import <m>; print(<m>.run())`),
 * node 25.3 (type stripping) and tsc 6.0.3 (`--strict --target es2022 --moduleDetection force`); the observed result
 * is in the comment above each.
 */

/** Every call named `name` in `path`, as its resolved target or undefined for name-only. */
const targets = async (tree: Record<string, string>, path: string, name = 'f'): Promise<(string | undefined)[]> => {
  const files = await linkFiles(tree);
  return (files.get(path)?.calls ?? []).filter((call) => call.name === name).map((call) => call.to);
};

const PY_A = 'def f(): return 1\ndef run(): return f()\nimport b\n';
const PY_F = 'def f(): return 1\ndef run(): return f()\n';

describe('round 4: sys.modules and importlib under any spelling or binding', () => {
  it.each([
    // Each form: CPython 3.14 `import a; print(a.run())` -> 2.
    ['sys.modules bound to a name', "import a, sys\nmods = sys.modules\nmods['a'].f = lambda: 2\n"],
    ['sys.modules.get', "import a, sys\nsys.modules.get('a').f = lambda: 2\n"],
    ['sys imported under another name', "import a\nimport sys as s\ns.modules['a'].f = lambda: 2\n"],
    ['from sys import modules', "import a\nfrom sys import modules\nmodules['a'].f = lambda: 2\n"],
    ['sys imported twice', "import a\nimport sys\nimport sys\nsys.modules['a'].f = lambda: 2\n"],
    ['sys bound in try and except', "import a\ntry:\n    import sys\nexcept ImportError:\n    sys = None\nsys.modules['a'].f = lambda: 2\n"],
    ['sys.modules values iterated', "import a, sys\nfor m in list(sys.modules.values()):\n    if getattr(m, '__name__', '') == 'a':\n        m.f = lambda: 2\n"],
    ['importlib imported twice', "import importlib\nimport importlib\nimportlib.import_module('a').f = lambda: 2\n"],
    ['importlib.__import__', 'import importlib\nimportlib.__import__("a").f = lambda: 2\n'],
  ])('PY-S %s', async (_form, b) => {
    expect(await targets({ 'a.py': PY_A, 'b.py': b }, 'a.py')).toEqual([undefined]);
  });
});

describe("round 4: a module's namespace reached through globals(), __globals__ or __class__", () => {
  it.each([
    // Each form: CPython 3.14 `import a; print(a.run())` -> 2.
    ['the module read from globals()', "import a\nglobals()['a'].f = lambda: 2\n"],
    ['__globals__ of a module attribute', "import a\na.run.__globals__['f'] = lambda: 2\n"],
    ['__globals__ of an imported function', "from a import run\nrun.__globals__['f'] = lambda: 2\n"],
    ['globals() bound to a name', 'import a\ng = globals()\ng["a"].f = lambda: 2\n'],
    ['setattr on globals()[name]', 'import a\nsetattr(globals()["a"], "f", lambda: 2)\n'],
    ['exec in an importer', 'import a\nexec("a.f = lambda: 2")\n'],
    ['exec that imports the module itself', 'exec("import a; a.f = lambda: 2")\n'],
  ])('PY-G %s', async (_form, b) => {
    expect(await targets({ 'a.py': PY_A, 'b.py': b }, 'a.py')).toEqual([undefined]);
  });

  it("PY-G the module's __class__ assigned", async () => {
    // CPython 3.14: `import c; print(c.run())` -> 2; the new type's data descriptor wins over the module's own f.
    const tree = {
      'a.py': 'def f(): return 1\n',
      'b.py': 'import a, types\nclass M(types.ModuleType):\n    f = property(lambda self: lambda: 2)\na.__class__ = M\n',
      'c.py': 'import b\nimport a\ndef run(): return a.f()\n',
    };
    expect(await targets(tree, 'c.py')).toEqual([undefined]);
  });

  it.each([
    // Precision: sound refinement, COD-59 round 4
    // Each form: CPython 3.14 `import z; print(z.run())` -> 1; b reaches only a's namespace.
    ['globals() escapes only the modules the file binds', "import a\nglobals()['a'].f = lambda: 2\n"],
    ['__globals__ escapes only the function module', "import a\na.run.__globals__['f'] = lambda: 2\n"],
  ])('PY-G precision: %s', async (_form, b) => {
    expect(await targets({ 'a.py': PY_A, 'b.py': b, 'z.py': PY_F }, 'z.py')).toEqual(['z.py::f::function']);
  });
});

describe('round 4: a package escaping as a value reaches its submodules', () => {
  const tree = {
    'pkg/__init__.py': '',
    'pkg/a.py': PY_F,
    'b.py': 'import pkg.a\ndef patch(m):\n    m.a.f = lambda: 2\npatch(pkg)\n',
    'c.py': 'import b\nimport pkg.a\ndef run(): return pkg.a.run()\n',
    'z.py': PY_F,
  };

  it('PY-P a submodule written through its escaped package', async () => {
    // CPython 3.14: `import c; print(c.run())` -> 2.
    expect(await targets(tree, 'pkg/a.py')).toEqual([undefined]);
  });

  it('PY-P precision: a package escape spares modules outside it', async () => {
    // Precision: sound refinement, COD-59 round 4
    // CPython 3.14: `import c, z; print(z.run())` -> 1.
    expect(await targets(tree, 'z.py')).toEqual(['z.py::f::function']);
  });
});

const TS_K = 'class K {\n  f() { return "K.f"; }\n  m() { return this.f(); }\n}\n';

describe('round 4: option B on a field gives nothing when the method declares its own this', () => {
  it.each([
    // Each form: tsc --strict accepts the program (this.cache is a K, or any); node 25 prints "g".
    ['this typed as an object holding a K', 'put(this: { cache: K }, k: "f", v: any) { this.cache[k] = v; }'],
    ['this typed any', 'put(this: any, k: string, v: any) { this.cache[k] = v; }'],
  ])('TS-B not exempt: %s', async (_form, method) => {
    const src = `${TS_K}class C {\n  cache: Record<string, number> = {};\n  ${method}\n}\nconst k = new K();\nC.prototype.put.call({ cache: k }, "f", () => "g");\nconsole.log(k.m());\n`;
    expect(await targets({ 'a.ts': src }, 'a.ts')).toEqual([undefined]);
  });

  it.each([
    // Each form: tsc --strict accepts the program (the local alias makes the field a K); node 25 prints "g".
    ['Map', 'type Map<A, B> = K;', 'Map<string, number>'],
    ['Set', 'type Set<T> = K;', 'Set<string>'],
    ['Record', 'type Record<A, B> = K;', 'Record<string, number>'],
  ])('TS-B not exempt: a field typed through a local alias named %s', async (_name, alias, type) => {
    const src = `${TS_K}${alias}\nclass C {\n  x: ${type};\n  constructor(x: ${type}) { this.x = x; }\n  put(k: keyof K, v: any) { this.x[k] = v; }\n}\nconst k = new K();\nnew C(k).put("f", () => "g");\nconsole.log(k.m());\n`;
    expect(await targets({ 'a.ts': src }, 'a.ts')).toEqual([undefined]);
  });

  it('TS-B not exempt: a parameter typed through a local alias named Map', async () => {
    // tsc --strict accepts the program; node 25 prints "g".
    const src = `${TS_K}type Map<A, B> = K;\nfunction put(x: Map<string, number>, k: keyof K, v: any) { x[k] = v; }\nconst k = new K();\nput(k, "f", () => "g");\nconsole.log(k.m());\n`;
    expect(await targets({ 'a.ts': src }, 'a.ts')).toEqual([undefined]);
  });
});

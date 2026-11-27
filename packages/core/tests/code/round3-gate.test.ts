import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeIndex, type CodeIndex } from '../../src/code/code-index.js';
import { linkFiles } from './scope-helpers.js';

/**
 * COD-59 round 3: a module object that escapes as a value, a submodule import from another file, and the owner's
 * option B for computed writes (`x[k] = v`): the write cannot rebind a class method when the receiver's declared TS
 * type cannot hold a class instance. Every expectation is name-only (`to` undefined) unless the runtime reaches the
 * symbol core names. Oracle: CPython 3.14.7 (`python3 -I`, cwd on sys.path), node 25.3 (type stripping) and
 * tsc 6.0.3 (`--strict --target es2022 --moduleDetection force`); the observed result is in the comment above each.
 */

/** Every call named `name` in `path`, as its resolved target or undefined for name-only. */
const targets = async (tree: Record<string, string>, path: string, name = 'f'): Promise<(string | undefined)[]> => {
  const files = await linkFiles(tree);
  return (files.get(path)?.calls ?? []).filter((call) => call.name === name).map((call) => call.to);
};

const PY_A = 'def f(): return 1\ndef run(): return f()\nimport b\n';
const PY_PATCH = 'def patch(m):\n    m.f = lambda: 2\n';

describe('round 3: a module object that escapes as a value can be rebound anywhere', () => {
  it.each([
    // CPython 3.14: `import a; a.run()` -> 2; h.patch writes the module's f through its parameter.
    ['passed to a function that writes it', { 'h.py': PY_PATCH, 'b.py': 'import a\nimport h\nh.patch(a)\n' }],
    // CPython 3.14: `import a; a.run()` -> 2.
    ['bound to another name', { 'b.py': 'import a\nm = a\nm.f = lambda: 2\n' }],
    // CPython 3.14: `import a; a.run()` -> 2.
    ['stored in a container', { 'b.py': 'import a\nmods = [a]\nmods[0].f = lambda: 2\n' }],
    // CPython 3.14: `import a; a.run()` -> 2; import_module returns the module object itself.
    ['returned by importlib.import_module', { 'h.py': PY_PATCH, 'b.py': 'import importlib, h\nh.patch(importlib.import_module("a"))\n' }],
  ])('PY-E %s', async (_form, rest) => {
    expect(await targets({ 'a.py': PY_A, ...rest }, 'a.py')).toEqual([undefined]);
  });

  const PY_F = 'def f(): return 1\ndef run(): return f()\n';
  it.each([
    // Gate findings on ba2c271. CPython 3.14: `import b, <module>; <module>.run()` -> 2 for every row.
    ['a dotted module passed as a value', 'pkg/a.py', { 'pkg/__init__.py': '', 'h.py': PY_PATCH, 'b.py': 'import pkg.a, h\nh.patch(pkg.a)\n' }],
    ['a dotted module bound to another name', 'pkg/a.py', { 'pkg/__init__.py': '', 'b.py': 'import pkg.a\nm = pkg.a\nm.f = lambda: 2\n' }],
    ['setattr on a dotted module', 'pkg/a.py', { 'pkg/__init__.py': '', 'b.py': 'import pkg.a\nsetattr(pkg.a, "f", lambda: 2)\n' }],
    ['import_module through an aliased importlib', 'a.py', { 'h.py': PY_PATCH, 'b.py': 'import importlib as il, h\nh.patch(il.import_module("a"))\n' }],
    ['import_module imported by name', 'a.py', { 'h.py': PY_PATCH, 'b.py': 'from importlib import import_module\nimport h\nh.patch(import_module("a"))\n' }],
    ['a write on an import_module result', 'a.py', { 'b.py': 'import importlib\nimportlib.import_module("a").f = lambda: 2\n' }],
    ['a write through sys.modules', 'a.py', { 'b.py': 'import a, sys\nsys.modules["a"].f = lambda: 2\n' }],
    ['an import core cannot resolve (sys.path) passed as a value', 'src/a.py', { 'h.py': PY_PATCH, 'b.py': 'import sys\nsys.path.insert(0, "src")\nimport a, h\nh.patch(a)\n' }],
    ['the module __setattr__', 'a.py', { 'b.py': 'import a\na.__setattr__("f", lambda: 2)\n' }],
    ['the module __dict__.update', 'a.py', { 'b.py': 'import a\na.__dict__.update(f=lambda: 2)\n' }],
    ['the module __dict__ bound to another name', 'a.py', { 'b.py': 'import a\nd = a.__dict__\nd["f"] = lambda: 2\n' }],
    ['a module name that is rebound later', 'a.py', { 'h.py': PY_PATCH, 'b.py': 'import a\nimport h\nm = a\nh.patch(m)\na = 0\n' }],
    ['a module imported twice', 'a.py', { 'h.py': PY_PATCH, 'b.py': 'import a\nimport a\nimport h\nh.patch(a)\n' }],
    ['a module imported in try with an except fallback', 'a.py', { 'h.py': PY_PATCH, 'b.py': 'import h\ntry:\n    import a\nexcept ImportError:\n    a = None\nh.patch(a)\n' }],
    ['a module in a for iterable', 'a.py', { 'h.py': PY_PATCH, 'b.py': 'import a\nimport h\nfor m in [a]:\n    h.patch(m)\n' }],
  ])('PY-E %s', async (_form, path, rest) => {
    expect(await targets({ [path]: PY_F, ...rest }, path)).toEqual([undefined]);
  });

  it('PY-E precision: an unresolved import used as a value only reaches modules of that name', async () => {
    // Precision: sound refinement, COD-59 round 3
    // CPython 3.14: `import b, z; z.run()` -> 1; the escaping module is src/a.py, never z.
    const tree = { 'src/a.py': PY_F, 'z.py': PY_F, 'h.py': PY_PATCH, 'b.py': 'import sys\nsys.path.insert(0, "src")\nimport a, h\nh.patch(a)\n' };
    expect(await targets(tree, 'z.py')).toEqual(['z.py::f::function']);
  });

  it('PY-E precision: reading an attribute of the module does not let it escape', async () => {
    // Precision: sound refinement, COD-59 round 3
    // CPython 3.14: `import a; a.run()` -> 1; b.py only reads a.run.__name__.
    expect(await targets({ 'a.py': PY_A, 'b.py': 'import a\nprint(a.run.__name__)\n' }, 'a.py')).toEqual(['a.py::f::function']);
  });
});

const PY_PKG = 'def f(): return 1\ndef run(): return f()\n';
const PY_USE = 'from pkg import f\ndef run():\n    return f()\n';

describe('round 3: importing the submodule pkg.f from any file rebinds the package attribute f', () => {
  it.each([
    // CPython 3.14: `import b, a, pkg`: pkg.f is the module; a.run() and pkg.run() raise TypeError: 'module' object is not callable.
    ['import pkg.f', { 'b.py': 'import pkg.f\n' }],
    // CPython 3.14: same TypeError for both calls.
    ['from pkg.f import x', { 'b.py': 'from pkg.f import x\n' }],
    // CPython 3.14: same TypeError for both calls.
    ['import pkg.f as g', { 'b.py': 'import pkg.f as g\n' }],
    // CPython 3.14: `import pkg.g, a, pkg`: same TypeError for both calls.
    ['from .f import x inside the package', { 'pkg/g.py': 'from .f import x\n' }],
  ])('PY-S %s', async (_form, rest) => {
    const tree = { 'pkg/__init__.py': PY_PKG, 'pkg/f.py': 'x = 1\n', 'a.py': PY_USE, ...rest };
    expect(await targets(tree, 'a.py')).toEqual([undefined]);
    expect(await targets(tree, 'pkg/__init__.py')).toEqual([undefined]);
  });

  it.each([
    // Precision: sound refinement, COD-59 round 3
    // CPython 3.14: `import b, a, pkg`: pkg.f is the function (the attribute exists, so the submodule is not imported); both calls -> 1.
    ['from pkg import f', { 'b.py': 'from pkg import f\n' }],
    // CPython 3.14: `import pkg.g, a, pkg`: pkg.f is the function; both calls -> 1.
    ['from . import f inside the package', { 'pkg/g.py': 'from . import f\n' }],
  ])('PY-S precision: %s takes the existing attribute', async (_form, rest) => {
    const tree = { 'pkg/__init__.py': PY_PKG, 'pkg/f.py': 'x = 1\n', 'a.py': PY_USE, ...rest };
    expect(await targets(tree, 'a.py')).toEqual(['pkg/__init__.py::f::function']);
    expect(await targets(tree, 'pkg/__init__.py')).toEqual(['pkg/__init__.py::f::function']);
  });
});

describe('round 3: a live index re-resolves when another file starts rebinding the module attribute', () => {
  let repo: string;
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const open = async (tree: Record<string, string>): Promise<CodeIndex> => {
    repo = mkdtempSync(join(tmpdir(), 'codechart-round3-'));
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    execFileSync('git', ['init', '-q'], { cwd: repo });
    return openCodeIndex(repo);
  };
  const callTo = (index: CodeIndex, path: string): string | undefined => index.file(path)?.calls.find((c) => c.name === 'f')?.to;

  it('b.py starts writing the module through another name', async () => {
    // CPython 3.14: with b.py = `import a`, a.run() -> 1; after the edit, a.run() -> 2.
    const index = await open({ 'a.py': PY_A, 'b.py': 'import a\n' });
    expect(callTo(index, 'a.py')).toBe('a.py::f::function');
    writeFileSync(join(repo, 'b.py'), 'import a\nm = a\nm.f = lambda: 2\n');
    await index.update(['b.py']);
    expect(callTo(index, 'a.py')).toBeUndefined();
  });

  it('b.py starts importing the submodule pkg.f', async () => {
    // CPython 3.14: with b.py = `x = 1`, a.run() and pkg.run() -> 1; after the edit, both raise TypeError.
    const index = await open({ 'pkg/__init__.py': PY_PKG, 'pkg/f.py': 'x = 1\n', 'a.py': PY_USE, 'b.py': 'x = 1\n' });
    expect(callTo(index, 'a.py')).toBe('pkg/__init__.py::f::function');
    expect(callTo(index, 'pkg/__init__.py')).toBe('pkg/__init__.py::f::function');
    writeFileSync(join(repo, 'b.py'), 'import pkg.f\n');
    await index.update(['b.py']);
    expect(callTo(index, 'a.py')).toBeUndefined();
    expect(callTo(index, 'pkg/__init__.py')).toBeUndefined();
  });

  it('b.py starts importing a module below the submodule pkg.sub', async () => {
    // CPython 3.14: with b.py = `x = 1`, pkg.run() -> 1; after `import pkg.sub.mod`, pkg.run() raises TypeError.
    const index = await open({
      'pkg/__init__.py': 'def sub(): return 1\ndef run(): return sub()\n',
      'pkg/sub/__init__.py': 'x = 1\n',
      'pkg/sub/mod.py': 'y = 1\n',
      'b.py': 'x = 1\n',
    });
    const subTo = (): string | undefined => index.file('pkg/__init__.py')?.calls.find((c) => c.name === 'sub')?.to;
    expect(subTo()).toBe('pkg/__init__.py::sub::function');
    writeFileSync(join(repo, 'b.py'), 'import pkg.sub.mod\n');
    await index.update(['b.py']);
    expect(subTo()).toBeUndefined();
  });
});

const TS_K = 'class K {\n  f() { return "K.f"; }\n  m() { return this.f(); }\n}\n';
const TS_K_MAP = 'class K extends Map<string, number> {\n  f() { return "K.f"; }\n  m() { return this.f(); }\n}\n';

/** A computed write through a parameter whose declared type tsc proves cannot hold a K; the driver passes a non-K. */
const exempt = (sig: string, write: string, arg: string): string =>
  `${TS_K}function put(${sig}) { ${write}; }\nput(${arg});\nconsole.log(new K().m());\n`;

/** A computed write through a parameter whose declared type can hold a K; the driver passes one and rebinds its f. */
const open = (sig: string, write: string, cls = TS_K, pre = ''): string =>
  `${cls}${pre}function put(${sig}) { ${write}; }\nconst k = new K();\nput(k, "f", () => "g");\nconsole.log(k.m());\n`;

describe('round 3: option B, a computed write on a receiver typed as no class instance', () => {
  it.each([
    // Precision: sound refinement, COD-59 round 3 (option B)
    // Each form: node 25 prints "K.f"; tsc --strict accepts the program and rejects `const x: <type> = new K()` (TS2322/TS2740/TS2741).
    ['Record<string, number>', exempt('x: Record<string, number>, k: string, v: number', 'x[k] = v', '{}, "f", 1')],
    ['an index signature', exempt('x: { [key: string]: number }, k: string, v: number', 'x[k] = v', '{}, "f", 1')],
    ['Map', exempt('x: Map<string, number>, k: string, v: number', '(x as any)[k] = v', 'new Map(), "f", 1')],
    ['Set', exempt('x: Set<string>, k: string, v: number', '(x as any)[k] = v', 'new Set(), "f", 1')],
    ['an array', exempt('x: number[], k: number, v: number', 'x[k] = v', '[], 0, 1')],
    ['Array<T>', exempt('x: Array<number>, k: number, v: number', 'x[k] = v', '[], 0, 1')],
    ['a tuple', exempt('x: [number, number], k: 0 | 1, v: number', 'x[k] = v', '[0, 0], 1, 1')],
    // node 25 (with load returning {}) prints "K.f"; tsc --strict accepts it with `declare function load`.
    ['a let bound to a call', `${TS_K}declare function load(): Record<string, number>;\nlet r: Record<string, number> = load();\nexport function put(k: string) { r[k] = 1; }\nconsole.log(new K().m());\n`],
  ])('TS-B exempt: %s', async (_form, src) => {
    expect(await targets({ 'a.ts': src }, 'a.ts')).toEqual(['a.ts::K.f::method']);
  });

  it.each([
    // Each form: tsc --strict accepts the program; node 25 prints "g" (put rebinds k's own f).
    ['any', open('x: any, k: string, v: any', 'x[k] = v')],
    ['unknown', open('x: unknown, k: string, v: unknown', '(x as any)[k] = v')],
    ['a class type', open('x: K, k: keyof K, v: any', 'x[k] = v')],
    ['a union that includes a class', open('x: K | number[], k: string, v: unknown', '(x as any)[k] = v')],
    // tsc --strict accepts `const x: Record<string, any> = new K()`: an `any` index signature takes any object.
    ['Record<string, any>', open('x: Record<string, any>, k: string, v: unknown', 'x[k] = v')],
    ['an index signature of any', open('x: { [key: string]: any }, k: string, v: unknown', 'x[k] = v')],
    // tsc --strict accepts `const x: { f(): string } = new K()`: an object type with named members is structural.
    ['an object type K satisfies', open('x: { f(): string }, k: "f", v: () => string', 'x[k] = v')],
    // K extends Map, so a Map-typed receiver can be a K.
    ['Map when the class extends Map', open('x: Map<string, number>, k: string, v: unknown', '(x as any)[k] = v', TS_K_MAP)],
    ['an alias of a class type', open('x: T, k: keyof T, v: any', 'x[k] = v', TS_K, 'type T = K;\n')],
    // A class that declares an index signature is assignable to a Record of that value type.
    ['Record when a class declares an index signature', open('x: Record<string, unknown>, k: string, v: unknown', 'x[k] = v', TS_K.replace('class K {\n', 'class K {\n  [key: string]: unknown;\n'))],
  ])('TS-B not exempt: %s', async (_form, src) => {
    expect(await targets({ 'a.ts': src }, 'a.ts')).toEqual([undefined]);
  });

  it('TS-B untyped JS stays strict even with a JSDoc type', async () => {
    // node 25: prints "g"; JSDoc is not checked, so put may receive a K.
    const src = 'class K {\n  f() { return "K.f"; }\n  m() { return this.f(); }\n}\n/** @param {Record<string, number>} x */\nfunction put(x, k, v) { x[k] = v; }\nconst k = new K();\nput(k, "f", () => "g");\nconsole.log(k.m());\n';
    expect(await targets({ 'a.js': src }, 'a.js')).toEqual([undefined]);
  });
});

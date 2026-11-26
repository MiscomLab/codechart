import { describe, expect, it } from 'vitest';
import { linkFiles } from './scope-helpers.js';

/**
 * COD-59 QA gate: `this.f()` / `self.f()` dispatch. Expectations from running each program (node 25 for JS, CPython
 * 3.14.7 `python3 -I` for Python). Soundness: a resolved call must be the method the runtime reaches; name-only is sound.
 */

const fTargets = async (tree: Record<string, string>, path: string): Promise<(string | undefined)[]> =>
  (await linkFiles(tree)).get(path)!.calls.filter((c) => c.name === 'f').map((c) => c.to);

const TS_K = 'export class K {\n  f() { return "K"; }\n  m() { return this.f(); }\n}\n';
const PY_K = 'class K:\n    def f(self): return "K"\n    def m(self): return self.f()\n';

describe('gate: lines of the dispatch index no test reached (pins)', () => {
  it.each([
    // node: `class L extends K { f() }` in a .js file; new L().m() === "L".
    ['a JavaScript subclass', { 'k.js': 'export class K {\n  f() { return "K"; }\n  m() { return this.f(); }\n}\nexport class L extends K {\n  f() { return "L"; }\n}\n' }, 'k.js'],
    // node: a computed member named f overrides; new L().m() === "L".
    ['a computed member in a subclass', { 'k.ts': `${TS_K}const n = "f";\nexport class L extends K {\n  [n]() { return "L"; }\n}\n` }, 'k.ts'],
    // node: `this.f += "!"` replaces the method on the instance with a string, so m() throws TypeError.
    ['an augmented this write', { 'k.ts': 'export class K {\n  f(): any { return "K"; }\n  constructor() { this.f += "!"; }\n  m() { return this.f(); }\n}\n' }, 'k.ts'],
    // node: `const L = class extends K {}` then `class M extends L { f() }`; new M().m() === "M".
    ['a subclass of a class expression', { 'k.ts': `${TS_K}export const L = class extends K {};\nexport class M extends L {\n  f() { return "M"; }\n}\n` }, 'k.ts'],
    // CPython: a base whose __init__ sets self.f shadows K.f; K().m() reaches the lambda.
    ['a Python base that writes self.f', { 'k.py': 'class B:\n    def __init__(self): self.f = lambda: "B"\nclass K(B):\n    def f(self): return "K"\n    def m(self): return self.f()\n' }, 'k.py'],
    // CPython: the write sits two bases up.
    ['a Python grandparent that writes self.f', { 'k.py': 'class A:\n    def __init__(self): self.f = lambda: "A"\nclass B(A): pass\nclass K(B):\n    def f(self): return "K"\n    def m(self): return self.f()\n' }, 'k.py'],
    // An unknown base may set anything.
    ['a Python base core cannot see', { 'k.py': 'from somewhere import Unknown\nclass K(Unknown):\n    def f(self): return "K"\n    def m(self): return self.f()\n' }, 'k.py'],
  ])('%s', async (_form, tree, path) => {
    expect((await fTargets(tree, path)).filter((to) => to?.includes('K.f'))).toEqual([]);
  });

  it('a Python class extending object still resolves (precision pin)', async () => {
    // CPython: K().m() == "K".
    expect(await fTargets({ 'k.py': 'class K(object):\n    def f(self): return "K"\n    def m(self): return self.f()\n' }, 'k.py')).toEqual(['k.py::K.f::method']);
  });
});

describe('gate: a subclass reached through an alias overrides the method', () => {
  it.each([
    // node: new L().m() === "L".
    ['TS import alias', { 'k.ts': TS_K, 'l.ts': "import { K as Base } from './k';\nexport class L extends Base {\n  f() { return 'L'; }\n}\n" }, 'k.ts'],
    ['TS local alias', { 'k.ts': `${TS_K}const Base = K;\nexport class L extends Base {\n  f() { return "L"; }\n}\n` }, 'k.ts'],
    // CPython: L().m() == "L".
    ['Python import alias', { 'k.py': PY_K, 'l.py': 'from k import K as Base\nclass L(Base):\n    def f(self): return "L"\n' }, 'k.py'],
    ['Python local alias', { 'k.py': `${PY_K}Base = K\nclass L(Base):\n    def f(self): return "L"\n` }, 'k.py'],
  ])('%s', async (_form, tree, path) => {
    expect(await fTargets(tree, path)).toEqual([undefined]);
  });
});

describe('gate: a write to the method from outside the class replaces it', () => {
  it.each([
    // node: k.f = () => "X"; k.m() === "X".
    ['TS instance write in the same file', { 'k.ts': `${TS_K}export function run() { const k = new K(); k.f = () => "X"; return k.m(); }\n` }, 'k.ts'],
    ['TS instance write in another file', { 'k.ts': TS_K, 'w.ts': "import { K } from './k';\nexport function run() { const k = new K(); k.f = () => 'X'; return k.m(); }\n" }, 'k.ts'],
    // node: new K().m() === "P".
    ['TS prototype write', { 'k.ts': `${TS_K}K.prototype.f = function () { return "P"; };\n` }, 'k.ts'],
    // node: new K({ f: () => "D" }).m() === "D".
    ['TS destructuring this write', { 'k.ts': 'export class K {\n  f() { return "K"; }\n  constructor(o: any) { ({ f: this.f } = o); }\n  m() { return this.f(); }\n}\n' }, 'k.ts'],
    // node: `(this as any).f = …` is the same write as `this.f = …`; new K().m() === "C".
    ['TS this write through a cast', { 'k.ts': 'export class K {\n  f() { return "K"; }\n  constructor() { (this as any).f = () => "C"; }\n  m() { return this.f(); }\n}\n' }, 'k.ts'],
    // CPython: after patch(k), k.m() == "X".
    ['Python instance write in another file', { 'k.py': PY_K, 'w.py': 'from k import K\ndef patch(k):\n    k.f = lambda: "X"\n' }, 'k.py'],
    // CPython: after `import w`, K().m() == "X".
    ['Python class write in another file', { 'k.py': PY_K, 'w.py': 'import k\nk.K.f = lambda self: "X"\n' }, 'k.py'],
  ])('%s', async (_form, tree, path) => {
    expect(await fTargets(tree, path)).toEqual([undefined]);
  });
});

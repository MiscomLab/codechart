import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeIndex } from '../../src/code/code-index.js';
import type { CallRef } from '../../src/code/model.js';
import { type Repo, type Tree, callOf, fileOf, link } from './scope-helpers.js';
import { tsDeclarationsAt, type TsDeclaration } from './ts-oracle.js';

/**
 * COD-59 compiler line (plan: .openchamber/cod-59-plan-compiler-line.md, gate rounds 1-5). For TypeScript and
 * JavaScript an arrow is right when the TypeScript checker resolves the callee to exactly ONE declaration and that is
 * the target. A rebind the write itself names (a prototype expression or alias, the class's own `this`/`self` writes,
 * a static-side write for a static call, a reassigned binding, a duplicate member, an unknown computed key) keeps the
 * call name-only, even though the checker still reports one declaration there: the rebind, not tsc, is the reason.
 *
 * Oracle: `ts-oracle.ts` (`tsDeclarationsAt` lists EVERY declaration of the callee's symbol). Every case asserts the
 * checker's declaration count and position in the test itself, then core's outcome.
 */

interface Spec {
  /** The file holding the call (default `a.ts`). */
  file?: string;
  /** The symbol the call is made from, without the file (default `K.m`). */
  caller?: string;
  name?: string;
  /** The symbol id core must name, or that the checker's declaration sits in (`a.ts::K.f::method`). */
  target?: string;
  /** Instead of `target`, the 1-based line of the checker's declaration. */
  declLine?: number;
  /** How many declarations the checker lists for the callee (default 1). */
  declarations?: number;
  /** Instead of `declarations`: exactly these declaration lines in `file`, in tsc's order. */
  declLines?: number[];
}

type Row = [label: string, tree: (ext: string) => Tree, exts?: readonly string[], spec?: (ext: string) => Spec];

const ALL = ['ts', 'js', 'mjs'] as const;
const TS = ['ts'] as const;
const MODULES = ['ts', 'js'] as const;

const one = (src: string) => (ext: string) => ({ [`a.${ext}`]: src });
const G = 'const g = () => 1;\n';
const K = 'class K {\n  f() {}\n  m() { this.f(); }\n}\n';
const KX = 'export class K {\n  f() {}\n  m() { this.f(); }\n}\n';
const KS = 'class K {\n  static f() {}\n  static s() { this.f(); }\n}\n';
const KSX = 'export class K {\n  static f() {}\n  static s() { this.f(); }\n}\n';
const IMPORT_K = "import { K } from './a';\n";

/** TS: one declaration (K.f). JS: tsc JS inference counts the write at `line` as a declaration, so it lists K.f (line 3) and the write. */
const jsWrite =
  (line: number, extra: Spec = {}) =>
  (ext: string): Spec =>
    ext === 'ts' ? extra : { ...extra, declLines: [3, line] };

const targetOf = (ext: string, spec: Spec): string | undefined => spec.target ?? (spec.declLine === undefined ? `a.${ext}::K.f::method` : undefined);

/** The checker's declarations for the call, asserted against the spec: count, file and the target's range. */
function checkTsc(repo: Repo, call: CallRef, file: string, spec: Spec, target: string | undefined): TsDeclaration[] {
  const found = tsDeclarationsAt({ ...repo.tree }, file, call.range.start.line, call.range.start.column, call.name);
  expect(found, `tsc sees a call to ${call.name} at ${call.range.start.line}:${call.range.start.column}`).toBeDefined();
  if (spec.declLines) {
    expect(found!.map((d) => `${d.file}:${d.line}`), 'tsc declarations of the callee').toEqual(spec.declLines.map((line) => `${file}:${line}`));
    return found!;
  }
  expect(found!.map((d) => `${d.file}:${d.line}`), 'tsc declarations of the callee').toHaveLength(spec.declarations ?? 1);
  if (found!.length === 0) return found!;
  if (spec.declLine !== undefined) {
    expect(found![0]).toMatchObject({ file, line: spec.declLine });
    return found!;
  }
  const symbol = fileOf(repo, target!.slice(0, target!.indexOf('::'))).symbols.find((s) => s.id === target);
  expect(symbol, `symbol ${target}`).toBeDefined();
  expect(found![0]!.file).toBe(symbol!.file);
  expect(found![0]!.line).toBeGreaterThanOrEqual(symbol!.range.start.line);
  expect(found![0]!.line).toBeLessThanOrEqual(symbol!.range.end.line);
  return found!;
}

/** tsc resolves the callee to exactly one declaration, that declaration is the target, and core resolves to it. */
async function expectArrow(tree: Tree, ext: string, spec: Spec = {}): Promise<void> {
  const file = spec.file ?? `a.${ext}`;
  const repo = await link(tree);
  const call = callOf(repo, spec.name ?? 'f', spec.caller ?? 'K.m', file);
  const target = targetOf(ext, spec);
  checkTsc(repo, call, file, { ...spec, declarations: spec.declarations ?? 1 }, target);
  expect(call).toMatchObject({ name: spec.name ?? 'f', to: target, evidence: 'resolved' });
}

/** The call stays name-only: tsc's declaration count and position are asserted, then core's `to` is absent. */
async function expectNameOnly(tree: Tree, ext: string, spec: Spec = {}): Promise<void> {
  const file = spec.file ?? `a.${ext}`;
  const repo = await link(tree);
  const call = callOf(repo, spec.name ?? 'f', spec.caller ?? 'K.m', file);
  checkTsc(repo, call, file, spec, targetOf(ext, spec));
  expect(call).toMatchObject({ name: spec.name ?? 'f', evidence: 'name-only' });
  expect(call).not.toHaveProperty('to');
}

const expand = (rows: readonly Row[]): [string, Tree, string, Spec][] =>
  rows.flatMap(([label, tree, exts = ALL, spec]) => exts.map((ext): [string, Tree, string, Spec] => [`${label} (${ext})`, tree(ext), ext, spec?.(ext) ?? {}]));

describe('arrows (tsc, one declaration)', () => {
  const R: Row[] = [
    // R1: a computed write on an unrelated object rebinds no class method.
    ['R1 o[k] = v on a parameter', one(`${K}function put(o, k, v) { o[k] = v; }\n`)],
    ['R1 o[k] = v on a local', one(`${K}const o = {};\nfunction put(k, v) { o[k] = v; }\n`)],
    ['R1 process.env[k] = v', one(`${K}function put(k, v) { process.env[k] = v; }\n`)],
    // R2
    ['R2 K.prototype[k] = g', one(`${K}function put(k, g) { K.prototype[k] = g; }\n`)],
    // R3
    ['R3 Object.assign(K.prototype, src)', one(`${K}function put(src) { Object.assign(K.prototype, src); }\n`)],
    ['R3 Object.assign(x, src)', one(`${K}function put(x, src) { Object.assign(x, src); }\n`)],
    // R4: the r5 lit.js shape, a computed "__proto__" key.
    ['R4 computed "__proto__" key', one(`${K}const k = "__proto__";\nconst k2 = "f";\nconst o = {};\no[k] = new K();\no[k2] = () => 1;\n`)],
    // R5: instance writes rebind nothing on the prototype.
    ['R5 new K().f = g', one(`${G}${K}new K().f = g;\n`)],
    ['R5 k.f = g', one(`${G}${K}const k = new K();\nk.f = g;\n`)],
    ['R5 ref.f = 1', one(`${K}const ref = { f: 0 };\nref.f = 1;\n`)],
    ['R5 (k as any).f = g', one(`${G}${K}const k = new K();\n(k as any).f = g;\n`), TS],
    // R6
    ['R6 method escape and call with another this', one(`${K}const other = {};\nconst h = new K().m;\nh.call(other);\n`)],
    // R7: an override in a subclass is the declaration tsc gives `this.f()` in K.
    ['R7 subclass override', one(`${K}class S extends K {\n  f() {}\n}\n`)],
    [
      'R7 subclass override, cross-file',
      (ext) => ({ [`a.${ext}`]: KX, [`s.${ext}`]: `${IMPORT_K}class S extends K {\n  f() {}\n}\n` }),
      MODULES,
    ],
    // R8
    ['R8 opaque base elsewhere', one(`${K}class Base {}\nfunction mix(B) { return class extends B {}; }\nclass M extends mix(Base) {\n  f() {}\n}\n`)],
    [
      'R8 opaque base, cross-file',
      (ext) => ({ [`a.${ext}`]: KX, [`s.${ext}`]: `${IMPORT_K}class Base {}\nfunction mix(B) { return class extends B {}; }\nclass M extends mix(Base) {\n  f() {}\n}\n` }),
      MODULES,
    ],
    // R10
    ['R10 new Proxy(new K(), h)', one(`${K}const p = new Proxy(new K(), {});\n`)],
    // R11: a computed key proved a symbol records nothing.
    ['R11 [sym]() with const sym = Symbol()', one('const sym = Symbol();\nclass K {\n  f() {}\n  [sym]() {}\n  m() { this.f(); }\n}\n')],
    ['R11 [Symbol.iterator]()', one('class K {\n  f() {}\n  [Symbol.iterator]() {}\n  m() { this.f(); }\n}\n')],
    // R12: an own "__proto__" key anywhere and Object.assign onto a fresh object.
    ['R12 [k]: v with an own computed "__proto__" key', one(`${K}function merge(a, b) { return Object.assign({}, a, b); }\nconst o = merge({ ["__proto__"]: 1 }, { f: 2 });\n`)],
    ['R12 Object.fromEntries with a "__proto__" entry, Object.assign(fresh, …)', one(`${K}const src = Object.fromEntries([["__proto__", {}]]);\nconst o = Object.assign({}, src);\n`)],
    // R13 / R14 (G2): an unresolved base is no write.
    ["R13 extends React.Component (external import)", one("import React from 'react';\nclass K extends React.Component {\n  f() {}\n  m() { this.f(); }\n}\n"), MODULES],
    ['R13 extends Error (not in the repo)', one('class K extends Error {\n  f() {}\n  m() { this.f(); }\n}\n')],
    ['R14 extends mix(Base)', one('class Base {}\nfunction mix(B) { return class extends B {}; }\nclass K extends mix(Base) {\n  f() {}\n  m() { this.f(); }\n}\n')],
    // R16 (G13): a subclass instance write is a blind spot like R5/R7.
    ['R16 subclass constructor writes this.f', one(`${G}${K}class S extends K {\n  constructor() { super(); this.f = g; }\n}\n`)],
  ];

  it.each(expand(R))('%s', async (_label, tree, ext, spec) => {
    await expectArrow(tree, ext, spec);
  });

  // R9: a sloppy direct eval or `new Function` is a blind spot; the call is a plain function call.
  it.each([
    ['a sloppy direct eval(s) in the caller (a.js script)', 'function f() {}\nfunction run(s) {\n  eval(s);\n  f();\n}\n'],
    ['new Function in the caller (a.js script)', "function f() {}\nfunction run() {\n  new Function('f = 1')();\n  f();\n}\n"],
  ])('R9 %s', async (_label, src) => {
    await expectArrow({ 'a.js': src }, 'js', { file: 'a.js', caller: 'run', target: 'a.js::f::function' });
  });

  // R15 (G4): `K.f = g` on a static f does not veto an instance `this.f()` of another class.
  it.each([['ts'], ['js'], ['mjs']])('R15 a static-side write on another class does not veto an instance this.f() (%s)', async (ext) => {
    const src = `${G}class J {\n  f() {}\n  m() { this.f(); }\n}\nclass Q {\n  static f() {}\n}\nQ.f = g;\n`;
    await expectArrow({ [`a.${ext}`]: src }, ext, { caller: 'J.m', target: `a.${ext}::J.f::method` });
  });
});

describe('visible rebinds stay name-only', () => {
  const N: Row[] = [
    // N1
    ['N1 K.prototype.f = g', one(`${G}${K}K.prototype.f = g;\n`), ALL, jsWrite(6)],
    ["N1 K.prototype['f'] = g", one(`${G}${K}K.prototype['f'] = g;\n`), ALL, jsWrite(6)],
    ['N1 delete K.prototype.f', one(`${K}delete K.prototype.f;\n`)],
    ['N1 [K.prototype.f] = [g]', one(`${G}${K}[K.prototype.f] = [g];\n`)],
    // N2
    ["N2 Object.defineProperty(K.prototype, 'f', …)", one(`${G}${K}Object.defineProperty(K.prototype, 'f', { value: g });\n`), ALL, jsWrite(6)],
    ["N2 Object.defineProperties(K.prototype, { f })", one(`${G}${K}Object.defineProperties(K.prototype, { f: { value: g } });\n`)],
    ['N2 Object.assign(K.prototype, { f: g })', one(`${G}${K}Object.assign(K.prototype, { f: g });\n`)],
    ["N2 Reflect.set(K.prototype, 'f', g)", one(`${G}${K}Reflect.set(K.prototype, 'f', g);\n`)],
    // N3
    ['N3 const P = K.prototype; P.f = g', one(`${G}${K}const P = K.prototype;\nP.f = g;\n`)],
    ['N3 Object.getPrototypeOf(k).f = g via a const alias', one(`${G}${K}const k = new K();\nconst P = Object.getPrototypeOf(k);\nP.f = g;\n`)],
    // N4
    ['N4 (K.prototype as any).f = g', one(`${G}${K}(K.prototype as any).f = g;\n`), TS],
    // N5: a static write names the constructor; only the static `this.f()` is vetoed.
    ['N5 K.f = g', one(`${G}${KS}K.f = g;\n`), ALL, jsWrite(6, { caller: 'K.s' })],
    ['N5 import { K as Q }; Q.f = g', (ext) => ({ [`a.${ext}`]: KSX, [`b.${ext}`]: `${G}import { K as Q } from './a';\nQ.f = g;\n` }), MODULES, () => ({ caller: 'K.s' })],
    [
      'N5 default import of export default class K',
      (ext) => ({ [`a.${ext}`]: 'export default class K {\n  static f() {}\n  static s() { this.f(); }\n}\n', [`b.${ext}`]: `${G}import Q from './a';\nQ.f = g;\n` }),
      MODULES,
      () => ({ caller: 'K.s' }),
    ],
    [
      'N5 default import of an anonymous default class',
      (ext) => ({ [`a.${ext}`]: 'export default class {\n  static f() {}\n  static s() { this.f(); }\n}\n', [`b.${ext}`]: `${G}import Q from './a';\nQ.f = g;\n` }),
      MODULES,
      (ext) => ({ caller: '', declLine: 2, file: `a.${ext}` }),
    ],
    ['N5 const A = K; A.f = g', one(`${G}${KS}const A = K;\nA.f = g;\n`), ALL, () => ({ caller: 'K.s' })],
    [
      'N5 ns.K.f = g',
      (ext) => ({ [`a.${ext}`]: KSX, [`b.${ext}`]: `${G}import * as ns from './a';\nns.K.f = g;\n` }),
      MODULES,
      () => ({ caller: 'K.s' }),
    ],
    [
      'N5 const K = class Inner {…}; K.f = g',
      one(`${G}const K = class Inner {\n  static f() {}\n  static s() { this.f(); }\n};\nK.f = g;\n`),
      ALL,
      jsWrite(6, { caller: '', declLine: 3 }),
    ],
    // N6: a `this.f = g` in K's constructor, or in a base's constructor.
    ['N6 K constructor writes this.f', one(`${G}class K {\n  f() {}\n  constructor() { this.f = g; }\n  m() { this.f(); }\n}\n`)],
    ['N6 a base constructor writes this.f', one(`${G}class Base {\n  constructor() { this.f = g; }\n}\nclass K extends Base {\n  f() {}\n  m() { this.f(); }\n}\n`)],
    // N7: a reassigned binding.
    ['N7 reassigned function', one(`${G}function f() {}\nf = g;\nfunction run() { f(); }\n`), ALL, () => ({ caller: 'run', declLine: 2 })],
    ['N7 reassigned let', one(`let f = () => 1;\nf = () => 2;\nfunction run() { f(); }\n`), ALL, () => ({ caller: 'run', declLine: 1 })],
    // N8: tsc's checker resolves no symbol inside a `with` body.
    ['N8 with (o) { f() }', one('function f() {}\nfunction run(o) {\n  with (o) {\n    f();\n  }\n}\n'), ['js'], () => ({ caller: 'run', declarations: 0 })],
    // N9: the same rebinds from another file (repo-wide).
    ['N9 K.prototype.f = g in b', (ext) => ({ [`a.${ext}`]: KX, [`b.${ext}`]: `${G}${IMPORT_K}K.prototype.f = g;\n` }), MODULES],
    ["N9 Object.defineProperty(K.prototype, 'f') in b", (ext) => ({ [`a.${ext}`]: KX, [`b.${ext}`]: `${G}${IMPORT_K}Object.defineProperty(K.prototype, 'f', { value: g });\n` }), MODULES],
    ["N9 K.prototype['f'] = g in b", (ext) => ({ [`a.${ext}`]: KX, [`b.${ext}`]: `${G}${IMPORT_K}K.prototype['f'] = g;\n` }), MODULES],
    [
      'N9 a base constructor in b writes this.f',
      (ext) => ({
        [`a.${ext}`]: `import { Base } from './b';\nexport class K extends Base {\n  f() {}\n  m() { this.f(); }\n}\n`,
        [`b.${ext}`]: `${G}export class Base {\n  constructor() { this.f = g; }\n}\n`,
      }),
      MODULES,
    ],
  ];

  it.each(expand(N))('%s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });
});

describe('G1: the class own this.f = g writes keep this.f() name-only', () => {
  const rows: Row[] = [
    ['a method writes this.f', one(`${G}class K {\n  f() {}\n  set() { this.f = g; }\n  m() { this.f(); }\n}\n`)],
    ['a field initializer writes this.f', one(`${G}class K {\n  f() {}\n  x = (this.f = g);\n  m() { this.f(); }\n}\n`)],
    ['super.f = g', one(`${G}class K {\n  f() {}\n  set() { super.f = g; }\n  m() { this.f(); }\n}\n`)],
    ['a static method writes this.f; a static this.f()', one(`${G}class K {\n  static f() {}\n  static set() { this.f = g; }\n  static s() { this.f(); }\n}\n`), ALL, () => ({ caller: 'K.s' })],
    ['a static block writes this.f; a static this.f()', one(`${G}class K {\n  static f() {}\n  static { this.f = g; }\n  static s() { this.f(); }\n}\n`), ALL, () => ({ caller: 'K.s' })],
    ['a static field initializer writes this.f', one(`${G}class K {\n  static f() {}\n  static x = (this.f = g);\n  static s() { this.f(); }\n}\n`), ALL, () => ({ caller: 'K.s' })],
  ];
  it.each(expand(rows))('%s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });
});

describe('G3: a prototype getter receiver is a prototype write', () => {
  const rows: Row[] = [
    ['Object.getPrototypeOf(k).f = g', one(`${G}${K}const k = new K();\nObject.getPrototypeOf(k).f = g;\n`)],
    ['Reflect.getPrototypeOf(k).f = g', one(`${G}${K}const k = new K();\nReflect.getPrototypeOf(k).f = g;\n`)],
    ['k.__proto__.f = g', one(`${G}${K}const k = new K();\nk.__proto__.f = g;\n`)],
    ["Object.defineProperty(Object.getPrototypeOf(k), 'f', …)", one(`${G}${K}const k = new K();\nObject.defineProperty(Object.getPrototypeOf(k), 'f', { value: g });\n`)],
  ];
  it.each(expand(rows))('%s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });
});

describe('G4: static and instance writes (plain writes veto static calls only)', () => {
  it.each(expand([['a plain write on an unrelated object does not veto an instance this.f()', one(`${G}${K}const o = { f: 0 };\no.f = g;\n`)]]))(
    '%s',
    async (_label, tree, ext, spec) => {
      await expectArrow(tree, ext, spec);
    },
  );
  it.each(expand([['a prototype write does not veto a static this.f()', one(`${G}${KS}function put() { K.prototype.f = g; }\n`), ALL, () => ({ caller: 'K.s' })]]))(
    '%s',
    async (_label, tree, ext, spec) => {
      await expectArrow(tree, ext, spec);
    },
  );
});

describe('G5/G8: prototype aliases, repo-wide by name', () => {
  const C = (body: string, ext: string) => ({ [`c.${ext}`]: `${IMPORT_K}${body}` });
  const rows: Row[] = [
    ['let P = K.prototype; P = other; P.f = g', one(`${G}${K}let P = K.prototype;\nP = {};\nP.f = g;\n`)],
    ['const Q = P chain', one(`${G}${K}const P = K.prototype;\nconst Q = P;\nQ.f = g;\n`)],
    ['const { prototype: P } = K', one(`${G}${K}const { prototype: P } = K;\nP.f = g;\n`)],
    ['const { prototype } = K (shorthand)', one(`${G}${K}const { prototype } = K;\nprototype.f = g;\n`)],
    [
      'export const P = K.prototype, written as P.f = g in another file',
      (ext) => ({ [`a.${ext}`]: KX, ...C('export const P = K.prototype;\n', ext), [`b.${ext}`]: `${G}P.f = g;\n` }),
      MODULES,
    ],
    [
      'export const P = K.prototype, written as import { P as R }; R.f = g',
      (ext) => ({ [`a.${ext}`]: KX, ...C('export const P = K.prototype;\n', ext), [`b.${ext}`]: `${G}import { P as R } from './c';\nR.f = g;\n` }),
      MODULES,
    ],
    [
      'ns.P.f = g through import * as ns',
      (ext) => ({ [`a.${ext}`]: KX, ...C('export const P = K.prototype;\n', ext), [`b.${ext}`]: `${G}import * as ns from './c';\nns.P.f = g;\n` }),
      MODULES,
    ],
    [
      'default import of export default K.prototype',
      (ext) => ({ [`a.${ext}`]: KX, ...C('export default K.prototype;\n', ext), [`b.${ext}`]: `${G}import Q from './c';\nQ.f = g;\n` }),
      MODULES,
    ],
    [
      'export { P as Q } re-exported alias',
      (ext) => ({ [`a.${ext}`]: KX, ...C('const P = K.prototype;\nexport { P as Q };\n', ext), [`b.${ext}`]: `${G}import { Q } from './c';\nQ.f = g;\n` }),
      MODULES,
    ],
    [
      'export { P as default } then import Q; Q.f = g',
      (ext) => ({ [`a.${ext}`]: KX, ...C('const P = K.prototype;\nexport { P as default };\n', ext), [`b.${ext}`]: `${G}import Q from './c';\nQ.f = g;\n` }),
      MODULES,
    ],
    [
      'export { P as default } then ns.default.f = g',
      (ext) => ({ [`a.${ext}`]: KX, ...C('const P = K.prototype;\nexport { P as default };\n', ext), [`b.${ext}`]: `${G}import * as ns from './c';\nns.default.f = g;\n` }),
      MODULES,
    ],
    ['o.p = K.prototype; o.p.f = g', one(`${G}${K}const o = {};\no.p = K.prototype;\no.p.f = g;\n`)],
    ['static P = K.prototype; this.P.f = g', one(`${G}${K}class H {\n  static P = K.prototype;\n  static init() { this.P.f = g; }\n}\n`)],
    ['P ??= K.prototype; P.f = g', one(`${G}${K}let P;\nP ??= K.prototype;\nP.f = g;\n`)],
    ['function h(P = K.prototype) { P.f = g }', one(`${G}${K}function h(P = K.prototype) {\n  P.f = g;\n}\n`)],
    ['K["prototype"] spelled with a string', one(`${G}${K}const P = K['prototype'];\nP.f = g;\n`)],
  ];
  it.each(expand(rows))('%s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });

  // G8 CJS spellings (G12): a script file with require/exports is CommonJS to tsc.
  const cjs = (c: string, b: string): Tree => ({ 'a.js': `${K}module.exports = { K };\n`, 'c.js': `const { K } = require('./a');\n${c}`, 'b.js': `${G}${b}` });
  it.each([
    ['exports.P = K.prototype; require("./c").P.f = g', cjs('exports.P = K.prototype;\n', "require('./c').P.f = g;\n")],
    ['module.exports.P = K.prototype', cjs('module.exports.P = K.prototype;\n', "require('./c').P.f = g;\n")],
    ['module.exports = { P } with P = K.prototype', cjs('const P = K.prototype;\nmodule.exports = { P };\n', "const { P } = require('./c');\nP.f = g;\n")],
    ['module.exports = K.prototype; const Q = require("./c"); Q.f = g', cjs('module.exports = K.prototype;\n', "const Q = require('./c');\nQ.f = g;\n")],
  ])('%s', async (_label, tree) => {
    await expectNameOnly(tree, 'js', { file: 'a.js', target: 'a.js::K.f::method' });
  });
});

describe('G7/G13: reflective and aliased writes on this', () => {
  const inK = (body: string) => one(`${G}class K {\n  f() {}\n  ${body}\n  m() { this.f(); }\n}\n`);
  const rows: Row[] = [
    ['Object.assign(this, { f: g })', inK('set() { Object.assign(this, { f: g }); }')],
    ["Object.defineProperty(this, 'f', …)", inK("set() { Object.defineProperty(this, 'f', { value: g }); }")],
    ["Object.defineProperties(this, { f })", inK('set() { Object.defineProperties(this, { f: { value: g } }); }')],
    ["Reflect.set(this, 'f', g)", inK("set() { Reflect.set(this, 'f', g); }")],
    ["Reflect.defineProperty(this, 'f', …)", inK("set() { Reflect.defineProperty(this, 'f', { value: g }); }")],
    ["Reflect.deleteProperty(this, 'f')", inK("set() { Reflect.deleteProperty(this, 'f'); }")],
    ['Object.assign((this), …) through parentheses', inK('set() { Object.assign((this), { f: g }); }')],
    ['Object.assign(this as any, …) through a cast', inK('set() { Object.assign(this as any, { f: g }); }'), TS],
    ['a write inside an arrow nested in a method', inK('set() { const h = () => { this.f = g; }; h(); }')],
    ['const self = this; self.f = g', inK('set() { const self = this; self.f = g; }')],
    ['self.f = g in a nested function expression', inK('set() { const self = this; const h = function () { self.f = g; }; h(); }')],
    ["Object.defineProperty(self, 'f', …)", inK("set() { const self = this; Object.defineProperty(self, 'f', { value: g }); }")],
    ['let self; self = this; self.f = g', inK('set() { let self; self = this; self.f = g; }')],
    ['a field arrow h = () => { this.f = g }', inK('h = () => { this.f = g; };')],
  ];
  it.each(expand(rows))('%s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });

  // `f() {}` plus a field `f = g`: tsc merges both into one symbol (two declarations), a duplicate like G10.
  it.each([['ts'], ['js']])('a method and a field of the same name (%s): tsc lists two declarations; core stays name-only', async (ext) => {
    await expectNameOnly({ [`a.${ext}`]: `${G}class K {\n  f() {}\n  f = g;\n  m() { this.f(); }\n}\n` }, ext, { declarations: 2 });
  });

  // G13: a base's constructor write is found through the chain (jsBaseWrites is transitive).
  it.each([['ts'], ['js'], ['mjs']])('a grandparent constructor writes this.f (%s)', async (ext) => {
    const src = `${G}class A {\n  constructor() { this.f = g; }\n}\nclass B extends A {}\nclass K extends B {\n  f() {}\n  m() { this.f(); }\n}\n`;
    await expectNameOnly({ [`a.${ext}`]: src }, ext);
  });
});

describe('G9: prototype receivers', () => {
  const rows: Row[] = [
    ['this.prototype.f = g in a static block', one(`${G}class K {\n  f() {}\n  static { this.prototype.f = g; }\n  m() { this.f(); }\n}\n`)],
    ['this.prototype.f = g in a static method', one(`${G}class K {\n  f() {}\n  static setup() { this.prototype.f = g; }\n  m() { this.f(); }\n}\n`)],
    ['this.constructor.prototype.f = g', one(`${G}class K {\n  f() {}\n  setup() { this.constructor.prototype.f = g; }\n  m() { this.f(); }\n}\n`)],
    ["K['prototype'].f = g", one(`${G}${K}K['prototype'].f = g;\n`), ALL, jsWrite(6)],
    ["k['__proto__'].f = g", one(`${G}${K}const k = new K();\nk['__proto__'].f = g;\n`)],
    ['(K.prototype!).f = g', one(`${G}${K}(K.prototype!).f = g;\n`), TS],
    ['(K.prototype satisfies object).f = g', one(`${G}${K}(K.prototype satisfies object).f = g;\n`), TS],
    ['(<any>K.prototype).f = g', one(`${G}${K}(<any>K.prototype).f = g;\n`), TS],
    [
      'this.constructor.f = g makes a static this.f() name-only',
      one(`${G}class K {\n  static f() {}\n  static s() { this.f(); }\n  m() { this.constructor.f = g; }\n}\n`),
      ALL,
      () => ({ caller: 'K.s' }),
    ],
  ];
  it.each(expand(rows))('%s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });
});

describe('G10: computed class members (default flipped: unknown keys record *)', () => {
  const dup = (decl: string, key: string, pre = '') => one(`${pre}${decl}class K {\n  f() {}\n  [${key}]() {}\n  m() { this.f(); }\n}\n`);
  const rows: [string, (ext: string) => Tree, readonly string[], number][] = [
    ["a string literal key ['f']", dup('', "'f'"), ALL, 2],
    ['a same-file const key', dup("const k = 'f';\n", 'k'), ALL, 2],
    ['an imported const key', (ext) => ({ [`c.${ext}`]: "export const k = 'f';\n", [`a.${ext}`]: `import { k } from './c';\nclass K {\n  f() {}\n  [k]() {}\n  m() { this.f(); }\n}\n` }), MODULES, 2],
    ['an enum member key [E.F]', dup("enum E { F = 'f' }\n", 'E.F'), TS, 2],
    ["a static readonly 'f' as const key [Keys.key]", dup("class Keys {\n  static readonly key = 'f' as const;\n}\n", 'Keys.key'), TS, 2],
    ['a generic literal inference key [j]', dup("function mk<T extends string>(s: T): T {\n  return s;\n}\nconst j = mk('f');\n", 'j'), TS, 2],
  ];
  it.each(rows.flatMap(([label, tree, exts, n]) => exts.map((ext): [string, Tree, string, number] => [`${label} (${ext})`, tree(ext), ext, n])))(
    'name-only, tsc lists %#: %s',
    async (_label, tree, ext, declarations) => {
      await expectNameOnly(tree, ext, { declarations });
    },
  );

  // tsc sees ONE declaration (the computed member is another name); the unknown key is the rebind core refuses.
  const inH = (ext: string): Spec => ({ caller: 'h.K.m', target: `a.${ext}::h.K.f::method` });
  const unknownKey: Row[] = [
    ['[k] with a string let', dup("let k: string = 'f';\n", 'k'), TS],
    ['[k] with a string parameter', one("function h(k: string) {\n  class K {\n    f() {}\n    [k]() {}\n    m() { this.f(); }\n  }\n}\n"), TS, inH],
    // Gate 1 round 5: a const key is looked up by scope at the key's position.
    ['a parameter shadowing const sym = Symbol()', one('const sym = Symbol();\nfunction h(sym: any) {\n  class K {\n    f() {}\n    [sym]() {}\n    m() { this.f(); }\n  }\n}\n'), TS, inH],
    ['a local const Symbol shadows the global in [Symbol.iterator]', one('export {};\nconst Symbol: any = {};\nclass K {\n  f() {}\n  [Symbol.iterator]() {}\n  m() { this.f(); }\n}\n'), TS],
    ['[Symbol.foo] is no well-known symbol', one('class K {\n  f() {}\n  [Symbol.foo]() {}\n  m() { this.f(); }\n}\n'), TS],
  ];
  it.each(expand(unknownKey))('name-only, tsc lists one declaration: %s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });

  // The same two Round-5 shapes in plain JavaScript.
  it.each([
    ['a parameter shadowing const sym = Symbol() (js)', 'const sym = Symbol();\nfunction h(sym) {\n  class K {\n    f() {}\n    [sym]() {}\n    m() { this.f(); }\n  }\n}\n'],
    ['[Symbol.foo] is no well-known symbol (js)', 'class K {\n  f() {}\n  [Symbol.foo]() {}\n  m() { this.f(); }\n}\n'],
  ])('name-only, tsc lists one declaration: %s', async (_label, src) => {
    await expectNameOnly({ 'a.js': src }, 'js', src.includes('function h') ? { caller: 'h.K.m', target: 'a.js::h.K.f::method' } : {});
  });
});

describe('G11: prototype getter writes veto the static side too', () => {
  const K2 = 'class K2 {\n  static f() {}\n  static s() { this.f(); }\n}\nclass S2 extends K2 {}\n';
  const rows: Row[] = [
    ['Object.getPrototypeOf(S2).f = g', one(`${G}${K2}Object.getPrototypeOf(S2).f = g;\n`)],
    ['Reflect.getPrototypeOf(S2).f = g', one(`${G}${K2}Reflect.getPrototypeOf(S2).f = g;\n`)],
    ['S2.__proto__.f = g', one(`${G}${K2}S2.__proto__.f = g;\n`), ['js']],
    ['const P = Object.getPrototypeOf(S2); P.f = g', one(`${G}${K2}const P = Object.getPrototypeOf(S2);\nP.f = g;\n`)],
  ];
  it.each(expand(rows.map(([l, t, e]) => [l, t, e, () => ({ caller: 'K2.s', target: undefined, declLine: 3 })] as Row)))('%s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });
});

describe('G12: prototype names inside object literals', () => {
  const rows: Row[] = [
    ['{ p: K.prototype }; protos.p.f = g', one(`${G}${K}const protos = { p: K.prototype };\nprotos.p.f = g;\n`)],
    ['{ P } with P a prototype alias', one(`${G}${K}const P = K.prototype;\nconst protos = { P };\nprotos.P.f = g;\n`)],
    ["{ ['p']: K.prototype }", one(`${G}${K}const protos = { ['p']: K.prototype };\nprotos.p.f = g;\n`)],
  ];
  it.each(expand(rows))('%s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });
});

describe('G6/G8: incremental re-index of one file', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const files = (tree: Tree) => Object.entries(tree).forEach(([path, text]) => write(path, text));

  const open = async (tree: Tree) => {
    root = mkdtempSync(join(tmpdir(), 'codechart-compiler-line-'));
    files(tree);
    execFileSync('git', ['init', '-q'], { cwd: root });
    return openCodeIndex(root);
  };

  /** tsc, in the test: the one declaration of `this.f()` in a.ts, for the tree as it stands. */
  const tscOne = (tree: Tree, call: CallRef, expectedLine: number) => {
    const found = tsDeclarationsAt(tree, 'a.ts', call.range.start.line, call.range.start.column, 'f');
    expect(found?.map((d) => `${d.file}:${d.line}`)).toEqual([`a.ts:${expectedLine}`]);
  };

  const fCall = (index: Awaited<ReturnType<typeof open>>) => index.file('a.ts')!.calls.find((c) => c.name === 'f')!;

  const A = `${KX}`;
  const AS = `${KSX}`;
  const WRITE = `${G}${IMPORT_K}`;

  it.each([
    ['a prototype write in b.ts', A, `${WRITE}K.prototype.f = g;\n`, `${WRITE}// no write\n`, 'K.m', 2],
    ['a static write K.f = g in b.ts (static call)', AS, `${WRITE}K.f = g;\n`, `${WRITE}// no write\n`, 'K.s', 2],
  ])('%s: added then removed, only b.ts re-indexed', async (_label, a, withWrite, without, _caller, line) => {
    const tree: Tree = { 'a.ts': a, 'b.ts': without };
    const index = await open(tree);
    expect(fCall(index)).toMatchObject({ to: 'a.ts::K.f::method', evidence: 'resolved' });
    tscOne(tree, fCall(index), line);
    write('b.ts', withWrite);
    await index.update(['b.ts']);
    expect(fCall(index)).toMatchObject({ evidence: 'name-only' });
    expect(fCall(index)).not.toHaveProperty('to');
    tscOne({ ...tree, 'b.ts': withWrite }, fCall(index), line);
    write('b.ts', without);
    await index.update(['b.ts']);
    expect(fCall(index)).toMatchObject({ to: 'a.ts::K.f::method', evidence: 'resolved' });
  });

  it('a prototype alias exported from c.ts and written in b.ts; removing the export from c.ts brings the arrow back', async () => {
    const c = `${IMPORT_K}export const P = K.prototype;\n`;
    const tree: Tree = { 'a.ts': KX, 'c.ts': 'export const P = {};\n', 'b.ts': `${G}import { P } from './c';\nP.f = g;\n` };
    const index = await open(tree);
    expect(fCall(index)).toMatchObject({ to: 'a.ts::K.f::method', evidence: 'resolved' });
    write('c.ts', c);
    await index.update(['c.ts']);
    expect(fCall(index)).toMatchObject({ evidence: 'name-only' });
    expect(fCall(index)).not.toHaveProperty('to');
    tscOne({ ...tree, 'c.ts': c }, fCall(index), 2);
    write('c.ts', 'export const P = {};\n');
    await index.update(['c.ts']);
    expect(fCall(index)).toMatchObject({ to: 'a.ts::K.f::method', evidence: 'resolved' });
  });

  it('removing the file that holds the write (b.ts deleted) brings the arrow back', async () => {
    const tree: Tree = { 'a.ts': KX, 'b.ts': `${WRITE}K.prototype.f = g;\n` };
    const index = await open(tree);
    expect(fCall(index)).toMatchObject({ evidence: 'name-only' });
    rmSync(join(root, 'b.ts'));
    await index.update(['b.ts']);
    expect(fCall(index)).toMatchObject({ to: 'a.ts::K.f::method', evidence: 'resolved' });
  });
});

describe('gate 2', () => {
  // The lines are tsc's declarations of f, written out per case: a duplicate member is listed once per spelling.
  const dup = (lines: number[]) => () => ({ declLines: lines });

  describe('B1: a quoted member name is the same member (a duplicate stays name-only)', () => {
    const rows: Row[] = [
      ['a "f"() next to f()', one('class K {\n  f() { return 1; }\n  "f"() { return 2; }\n  m() { return this.f(); }\n}\n'), ALL, dup([2, 3])],
      ["a 'f'() next to f()", one("class K {\n  f() { return 1; }\n  'f'() { return 2; }\n  m() { return this.f(); }\n}\n"), ALL, dup([2, 3])],
      ['a field "f" = () => 2 next to f()', one('class K {\n  f() { return 1; }\n  "f" = () => 2;\n  m() { return this.f(); }\n}\n'), ALL, dup([2, 3])],
      ['"f"() declared before f()', one('class K {\n  "f"() { return 2; }\n  f() { return 1; }\n  m() { return this.f(); }\n}\n'), ALL, dup([2, 3])],
      ['get "f"() next to f()', one('class K {\n  f() { return 1; }\n  get "f"() { return 2; }\n  m() { return this.f(); }\n}\n'), ALL, dup([2])],
    ];
    it.each(expand(rows))('name-only: %s', async (_label, tree, ext, spec) => {
      await expectNameOnly(tree, ext, spec);
    });

    // A quoted name alone is an ordinary member: tsc lists one declaration and core resolves to it.
    it.each(expand([['a quoted "f"() alone', one('class K {\n  "f"() { return 1; }\n  m() { return this.f(); }\n}\n'), ALL, () => ({ declLine: 2 })]]))('arrow: %s', async (_label, tree, ext) => {
      await expectArrow(tree, ext, { declLine: 2, target: `a.${ext}::K.f::method` });
    });
    // Numeric keys (`1() {} [1]() {}` called as `this[1]()`) are not expressed: the oracle and CallRef name only
    // identifiers and `a.b` property names, never an element access.
  });

  describe('B2: a this that is not the class this stays name-only', () => {
    const noThis: Row[] = [
      ['a function expression in a method', one('class K {\n  f() {}\n  m() { return [1].map(function () { return this.f(); }); }\n}\n'), ALL, () => ({ caller: '', declarations: 0 })],
      ['a field function expression', one('class K {\n  f() {}\n  x = function () { return this.f(); };\n}\n'), ALL, () => ({ caller: '', declarations: 0 })],
      ['a function passed to setTimeout in the constructor', one('class K {\n  f() {}\n  constructor() { setTimeout(function () { this.f(); }); }\n}\n'), ALL, () => ({ caller: '', declarations: 0 })],
      ['a function in a static block', one('class K {\n  f() {}\n  static { (function () { this.f(); })(); }\n}\n'), ALL, () => ({ caller: '', declarations: 0 })],
      ['.map(function () { … }, this)', one('class K {\n  f() {}\n  m() { return [1].map(function () { return this.f(); }, this); }\n}\n'), ['js', 'mjs'], () => ({ caller: '', declarations: 0 })],
      ['an object-literal getter in a method', one('class K {\n  f() {}\n  m() { return { get v() { return this.f(); } }; }\n}\n'), ALL, () => ({ caller: '', declarations: 0 })],
      ['an object-literal function property in a method', one('class K {\n  f() {}\n  m() { return { run: function () { return this.f(); } }; }\n}\n'), ALL, () => ({ caller: '', declarations: 0 })],
      // tsc: `this` in an object-literal method is the literal in JS (its own `f: 2`, line 3, not K.f) and implicit any in TS (no symbol).
      // A getter next to f() lists one declaration (line 2): tsc keeps the method and drops the accessor.
      ['an object-literal method in a field, the literal has its own f', one('class K {\n  f() { return 1; }\n  g = { f: 2, run() { return this.f(); } };\n}\n'), ALL, (ext) => (ext === 'ts' ? { caller: '', declarations: 0 } : { caller: '', declLines: [3] })],
    ];
    it.each(expand(noThis))('name-only: %s', async (_label, tree, ext, spec) => {
      await expectNameOnly(tree, ext, spec);
    });

    const arrows: Row[] = [
      ['an arrow in a method', one('class K {\n  f() {}\n  m() { const h = () => this.f(); return h(); }\n}\n')],
      ['an arrow inside an arrow in a method', one('class K {\n  f() {}\n  m() { const h = () => () => this.f(); return h; }\n}\n')],
      ['an arrow in a field initializer', one('class K {\n  f() {}\n  x = () => this.f();\n}\n')],
    ];
    it.each(expand(arrows))('arrow: %s', async (_label, tree, ext) => {
      await expectArrow(tree, ext, { caller: '' });
    });
  });

  describe('B3: a write through globalThis names the prototype too', () => {
    const rows: Row[] = [
      ["globalThis.Object.defineProperty(K.prototype, 'f', …)", one(`${G}${K}globalThis.Object.defineProperty(K.prototype, 'f', { value: g });\n`)],
      ["globalThis.Reflect.set(K.prototype, 'f', g)", one(`${G}${K}globalThis.Reflect.set(K.prototype, 'f', g);\n`)],
      ['globalThis.Object.assign(K.prototype, { f: g })', one(`${G}${K}globalThis.Object.assign(K.prototype, { f: g });\n`)],
    ];
    it.each(expand(rows))('name-only: %s', async (_label, tree, ext, spec) => {
      await expectNameOnly(tree, ext, spec);
    });
  });
});

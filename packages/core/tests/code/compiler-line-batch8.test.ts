import { describe, expect, it } from 'vitest';
import { link, nameOnly } from './scope-helpers.js';
import { ALL, TS, expand, expectArrow, expectNameOnly, one, type Row } from './compiler-line-helpers.js';

/** COD-59 batch 8: scopes inside computed names, static vs instance unknown keys, ids inside static blocks. Oracle: tsc. */

describe('scopes inside computed method and field names', () => {
  // Rule: an arrow in a computed key has its own scope; its parameter shadows the top-level function (tsc: the Parameter).
  const key = (decl: string) => (ext: string) => ({ [`a.${ext}`]: `function target() {}\nclass C { ${decl}[((target) => target())(() => "m")]${decl.includes('=') ? ' = 1;' : '() {}'} }\n` });
  const rows: [string, (ext: string) => Record<string, string>][] = [
    ['an instance method key', key('')],
    ['a static method key', key('static ')],
    ['an instance field key', (ext) => ({ [`a.${ext}`]: 'function target() {}\nclass C { [((target) => target())(() => "m")] = 1; }\n' })],
    ['a static field key', (ext) => ({ [`a.${ext}`]: 'function target() {}\nclass C { static [((target) => target())(() => "m")] = 1; }\n' })],
    ['an object-literal computed key', (ext) => ({ [`a.${ext}`]: 'function target() {}\nfunction run() { return { [((target) => target())(() => "m")]() {} }; }\n' })],
  ];
  it.each(rows.flatMap(([label, tree]) => ALL.map((ext): [string, Record<string, string>, string] => [`${label} (${ext})`, tree(ext), ext])))('name-only: %s', async (_label, tree, ext) => {
    const repo = await link(tree);
    nameOnly(repo, 'target', { kind: 'Parameter', parentKind: 'ArrowFunction' }, undefined, `a.${ext}`);
  });
});

describe('static vs instance unknown computed keys', () => {
  const tsKey = 'declare const k: string;\n';
  // A key core cannot prove: TS has `declare const k: string`; JS an opaque call (tsc's JS inference agrees: one declaration).
  const pre = (ext: string) => (ext === 'ts' ? tsKey : 'const k = String(Math.random());\n');
  const cls = (ext: string, body: string) => `${pre(ext)}class K {\n${body}}\n`;
  const lines = (ext: string) => (ext === 'ts' ? 3 : 3);

  // Rule: a static-side unknown key does not veto an instance `this.f()`, and an instance-side one not a static `this.f()`.
  const arrows: Row[] = [
    ['static [k]() next to instance f', (ext) => one(cls(ext, '  static [k]() {}\n  f() {}\n  m() { this.f(); }\n'))(ext), ALL],
    ['instance [k]() next to static f', (ext) => one(cls(ext, '  [k]() {}\n  static f() {}\n  static s() { this.f(); }\n'))(ext), ALL],
    ['static [k] = 1 field next to instance f', (ext) => one(cls(ext, '  static [k] = 1;\n  f() {}\n  m() { this.f(); }\n'))(ext), ALL],
    ['instance [k] = () => 1 field next to static f', (ext) => one(cls(ext, '  [k] = () => 1;\n  static f() {}\n  static s() { this.f(); }\n'))(ext), ALL],
  ];
  const callers = (label: string): string => (label.includes('next to static') ? 'K.s' : 'K.m');
  it.each(expand(arrows))('arrow: %s', async (label, tree, ext) => {
    await expectArrow(tree, ext, { caller: callers(label), declLine: lines(ext) + 1, target: `a.${ext}::K.f::method` });
  });

  // Pins: the unknown key on the SAME side as the call still vetoes (tsc: the computed member is another name).
  const vetoes: Row[] = [
    ['instance [k]() + instance this.f()', (ext) => one(cls(ext, '  [k]() {}\n  f() {}\n  m() { this.f(); }\n'))(ext), ALL],
    ['static [k]() + static this.f()', (ext) => one(cls(ext, '  static [k]() {}\n  static f() {}\n  static s() { this.f(); }\n'))(ext), ALL],
    ['instance [k] = () => 1 + instance this.f()', (ext) => one(cls(ext, '  [k] = () => 1;\n  f() {}\n  m() { this.f(); }\n'))(ext), ALL],
    ['static [k] = 1 + static this.f()', (ext) => one(cls(ext, '  static [k] = 1;\n  static f() {}\n  static s() { this.f(); }\n'))(ext), ALL],
  ];
  it.each(expand(vetoes))('name-only: %s', async (label, tree, ext) => {
    await expectNameOnly(tree, ext, { caller: label.includes('static this') ? 'K.s' : 'K.m', declLine: lines(ext) + 1 });
  });
});

describe('coverage pins: unknown computed keys', () => {
  // Pin: an unknown key inside a class EXPRESSION nested in K's method is that class's member, not K's.
  it.each(TS)('a nested class expression with [k] does not veto the outer this.f() (%s)', async (ext) => {
    const src = 'declare const k: string;\nclass K {\n  f() {}\n  m() { const X = class { [k]() {} }; this.f(); }\n}\n';
    await expectArrow({ [`a.${ext}`]: src }, ext, { declLine: 3, target: `a.${ext}::K.f::method` });
  });
  it.each(['js', 'mjs'])('a nested class expression with [k] does not veto the outer this.f() (%s)', async (ext) => {
    const src = 'const k = String(Math.random());\nclass K {\n  f() {}\n  m() { const X = class { [k]() {} }; this.f(); }\n}\n';
    await expectArrow({ [`a.${ext}`]: src }, ext, { declLine: 3, target: `a.${ext}::K.f::method` });
  });

  // Pin: a base class's unknown key does not veto the subclass's own f (tsc: one declaration, D.f).
  it.each(ALL)('a base [k]() does not veto the subclass own f (%s)', async (ext) => {
    const pre = ext === 'ts' ? 'declare const k: string;\n' : 'const k = String(Math.random());\n';
    const src = `${pre}class B { [k]() {} }\nclass D extends B {\n  f() {}\n  m() { this.f(); }\n}\n`;
    await expectArrow({ [`a.${ext}`]: src }, ext, { caller: 'D.m', declLine: 4, target: `a.${ext}::D.f::method` });
  });

  // Pin: a member literally named * plus an unknown key stays name-only (the unknown key still vetoes).
  it.each(ALL)('a member named "*" plus an unknown key stays name-only (%s)', async (ext) => {
    const pre = ext === 'ts' ? 'declare const k: string;\n' : 'const k = String(Math.random());\n';
    await expectNameOnly({ [`a.${ext}`]: `${pre}class K {\n  f() {}\n  "*"() {}\n  [k]() {}\n  m() { this.f(); }\n}\n` }, ext, { declLine: 3 });
  });
});

describe('ids of definitions inside a class static block', () => {
  const src = 'class K {\n  f() {}\n  static { const X = class { f() {} g() { this.f(); } }; }\n}\n';
  const ids = async (ext: string, text = src) => (await link({ [`a.${ext}`]: text })).files.get(`a.${ext}`)!.symbols.map((s) => s.id);

  // Rule: a definition in a static block nests under a `static` segment, like a field initializer nests under its field.
  it.each(ALL)('a class expression in a static block nests under K.static (%s)', async (ext) => {
    const got = await ids(ext);
    expect(got).toContain(`a.${ext}::K.f::method`);
    expect(got).toContain(`a.${ext}::K.static.f::method`);
    expect(got).toContain(`a.${ext}::K.static.g::method`);
    expect(got.filter((id) => id.endsWith('::method~2'))).toEqual([]);
  });

  it.each(ALL)('this.f() in the static-block class resolves to its own f, not K.f (%s)', async (ext) => {
    await expectArrow({ [`a.${ext}`]: src }, ext, { caller: 'K.static.g', declLine: 3, target: `a.${ext}::K.static.f::method` });
  });

  it.each(ALL)('a function declared in a static block is K.static.h (%s)', async (ext) => {
    expect(await ids(ext, 'class K {\n  static { function h() {} }\n}\n')).toContain(`a.${ext}::K.static.h::function`);
  });

  it.each(ALL)('two static blocks defining the same name: the second takes ~2 (%s)', async (ext) => {
    const got = await ids(ext, 'class K {\n  static { function h() {} }\n  static { function h() {} }\n}\n');
    expect(got).toContain(`a.${ext}::K.static.h::function`);
    expect(got).toContain(`a.${ext}::K.static.h::function~2`);
  });
});

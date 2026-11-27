import { describe, expect, it } from 'vitest';
import { callOf, link } from './scope-helpers.js';
import { ALL, G, K, expand, expectArrow, expectNameOnly, one, type Row, type Spec } from './compiler-line-helpers.js';
import { tsDeclarationsAt } from './ts-oracle.js';

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

describe('gate 2 round 2', () => {
  const to = (id: string, caller: string) => (ext: string): Spec => ({ caller, target: `a.${ext}::${id}::method` });
  /** The expression's own `f` is indexed as `K.m.f` (read from the symbol table), tsc's one declaration is it: resolvedOne. */
  const own = to('K.m.f', 'K.m.g');
  const none = (caller: string, extra: Spec = {}) => (): Spec => ({ caller, declarations: 0, ...extra });

  describe('C1: a class expression owns its this', () => {
    // Core indexes the expression's own f as `K.m.f` (`K.s.f` for the static side): tsc's one declaration is that f.
    const owned: Row[] = [
      ['new (class { f() {} g() { this.f() } })()', one('class K {\n  f() {}\n  m() { return new (class { f() {} g() { return this.f(); } })(); }\n}\n'), ALL, own],
      ['a class expression passed as an argument', one('function mix(c) { return c; }\nclass K {\n  f() {}\n  m() { return mix(class { f() {} g() { return this.f(); } }); }\n}\n'), ALL, own],
      ['a class expression in an object literal', one('class K {\n  f() {}\n  m() { return { C: class { f() {} g() { return this.f(); } } }; }\n}\n'), ALL, own],
      ['a const-bound class expression', one('class K {\n  f() {}\n  m() { const C = class { f() {} g() { return this.f(); } }; return C; }\n}\n'), ALL, own],
      [
        'the static side of a class expression',
        one('class K {\n  static f() {}\n  static s() { return class { static f() {} static g() { return this.f(); } }; }\n}\n'),
        ALL,
        to('K.s.f', 'K.s.g'),
      ],
      // tsc: one declaration, the expression's own f on line 3; core indexes it under the field, `K.x.f`.
      ['a class expression in a field initializer', one('class K {\n  f() {}\n  x = class { f() {} g() { return this.f(); } };\n}\n'), ALL, to('K.x.f', 'K.x.g')],
    ];
    it.each(expand(owned))('arrow to the expression own f: %s', async (_label, tree, ext, spec) => {
      await expectArrow(tree, ext, spec);
    });

    // Name-only: the anonymous class has no f (tsc: no symbol).
    const unindexed: Row[] = [
      ['an anonymous class without an f', one('class K {\n  f() {}\n  m() { return class { g() { return this.f(); } }; }\n}\n'), ALL, none('K.m.g')],
    ];
    it.each(expand(unindexed))('name-only: %s', async (_label, tree, ext, spec) => {
      await expectNameOnly(tree, ext, spec);
    });
  });

  describe('C2: a quoted "constructor" is the constructor, not a method', () => {
    it.each(['"constructor"', "'constructor'"].flatMap((q) => ALL.map((ext) => [q, ext] as const)))('name-only: this.constructor() with %s (%s)', async (q, ext) => {
      const file = `a.${ext}`;
      const repo = await link({ [file]: `class K {\n  ${q}() { return 2; }\n  m() { return this.constructor(); }\n}\n` });
      const call = callOf(repo, 'constructor', 'K.m', file);
      const found = tsDeclarationsAt({ ...repo.tree }, file, call.range.start.line, call.range.start.column, 'constructor');
      expect(found, 'tsc sees the call').toBeDefined();
      expect(found!.length, 'tsc binds this.constructor to a declaration').toBeGreaterThan(0);
      expect(found!.map((d) => d.file).filter((f) => f === file), 'tsc declares it in lib, not in K').toEqual([]);
      expect(call).toMatchObject({ name: 'constructor', evidence: 'name-only' });
      expect(call).not.toHaveProperty('to');
    });
  });

  describe('C3: heritage and class decorators of a nested class bind the enclosing this', () => {
    it.each(ALL)('a nested class heritage this.f() is K.f (%s)', async (ext) => {
      await expectArrow({ [`a.${ext}`]: 'class K {\n  f() { return Object; }\n  m() { class B extends (this.f()) { f() {} } return B; }\n}\n' }, ext, { caller: '' });
    });
    it('a nested class decorator this.f() is K.f (ts)', async () => {
      const src = 'function dec(x: any) { return (c: any) => c; }\nclass K {\n  f() { return 1; }\n  m() { @dec(this.f()) class L { f() {} } return L; }\n}\n';
      await expectArrow({ 'a.ts': src }, 'ts', { caller: '' });
    });
    // Safe pin: core keeps a nested class's computed key name-only; tsc binds no symbol for `this.f` in that key (0 declarations).
    it.each(ALL)('a nested class computed key [this.f()] stays name-only (%s)', async (ext) => {
      await expectNameOnly({ [`a.${ext}`]: "class K {\n  f() { return 'x'; }\n  m() { class B { [this.f()]() {} } return B; }\n}\n" }, ext, { caller: '', declarations: 0 });
    });
  });

  describe('C4: member decorators evaluate in the class enclosing scope', () => {
    const DEC = 'function dec(x: any) { return (t: any, c: any) => t; }\n';
    it.each([
      ['a method decorator', `${DEC}class K {\n  f() { return 1; }\n  @dec(this.f())\n  m() { return 2; }\n}\n`],
      ['a field decorator', `${DEC}class K {\n  f() { return 1; }\n  @dec(this.f())\n  x = 1;\n}\n`],
      ['an accessor decorator', `${DEC}class K {\n  f() { return 1; }\n  @dec(this.f())\n  accessor y = 1;\n}\n`],
    ])('name-only (tsc: no symbol): top-level %s (ts)', async (_label, src) => {
      await expectNameOnly({ 'a.ts': src }, 'ts', { caller: '', declarations: 0 });
    });
    it('a nested class method decorator inside K.m is K.f (ts)', async () => {
      const src = `${DEC}class K {\n  f() { return 1; }\n  m() { class L { @dec(this.f()) n() {} } return L; }\n}\n`;
      await expectArrow({ 'a.ts': src }, 'ts', { caller: '' });
    });
  });

  describe('C5: escapes in quoted names unquote to the same member', () => {
    const dupOf = (key: string, name = 'f') => `class K {\n  ${name}() { return 1; }\n  ${key}() { return 2; }\n  m() { return this.${name}(); }\n}\n`;
    it.each(
      [
        ['"\\x66" (an escape of f)', dupOf('"\\x66"'), 'f'],
        ['"\\u0066" (a unicode escape of f)', dupOf('"\\u0066"'), 'f'],
        ['"f" (plain)', dupOf('"f"'), 'f'],
        ['"fg" next to fg()', dupOf('"fg"', 'fg'), 'fg'],
        ['"\\x66g" next to fg()', dupOf('"\\x66g"', 'fg'), 'fg'],
      ].flatMap(([label, src, name]) => ALL.map((ext) => [`${label} (${ext})`, src, ext, name] as const)),
    )('name-only, tsc lists 2: %s', async (_label, src, ext, name) => {
      await expectNameOnly({ [`a.${ext}`]: src! }, ext, { name, declLines: [2, 3] });
    });
  });

  describe('C6: a quoted method in an object literal is not a class member', () => {
    it.each(ALL)('arrow to K.f (%s)', async (ext) => {
      await expectArrow({ [`a.${ext}`]: 'class K {\n  f() { return 1; }\n  o = { "f"() { return 2; } };\n  m() { return this.f(); }\n}\n' }, ext, { declLine: 2, target: `a.${ext}::K.f::method` });
    });
  });

  describe('C7: globalThis', () => {
    // A module (export {}) so a local `globalThis` binding is legal.
    it.each(ALL)('a local const globalThis shadows the global: the write names nothing (%s)', async (ext) => {
      const src = `export {};\nconst globalThis = { Object: { defineProperty() {} } };\n${K}globalThis.Object.defineProperty(K.prototype, 'f', { value: 1 });\n`;
      await expectArrow({ [`a.${ext}`]: src }, ext);
    });
    // computed-key access to a builtin: accepted blind spot
    it.each(ALL)("globalThis['Object'].defineProperty(K.prototype, 'f', …) (%s)", async (ext) => {
      await expectArrow({ [`a.${ext}`]: `${G}${K}globalThis['Object'].defineProperty(K.prototype, 'f', { value: g });\n` }, ext);
    });
  });

  describe('C8: precision', () => {
    it.each(ALL)('#f() next to f(): this.f() is K.f (%s)', async (ext) => {
      await expectArrow({ [`a.${ext}`]: 'class K {\n  #f() {}\n  f() {}\n  m() { return this.f(); }\n}\n' }, ext, { declLine: 3, target: `a.${ext}::K.f::method` });
    });
    it.each(ALL)('static f = () => 1 next to an instance f(): this.f() is the instance method (%s)', async (ext) => {
      await expectArrow({ [`a.${ext}`]: 'class K {\n  static f = () => 1;\n  f() {}\n  m() { return this.f(); }\n}\n' }, ext, { declLine: 3, target: `a.${ext}::K.f::method` });
    });
  });
});

describe('gate 2 round 3', () => {
  // A template literal whose text is backslash-x66 (and backslash-u{66}) is the name `f`: the escapes are decoded.
  const keyed = (key: string, tail = '') => `class K {\n  f() {}\n  [${key}]() {}\n  m() { this.f(); }\n}\n${tail}`;
  const dupRows: Row[] = [
    ['T1 [`\\x66`]() next to f()', one(keyed('`\\x66`')), ALL, () => ({ declLines: [2, 3] })],
    ['T2 [`\\u{66}`]() next to f()', one(keyed('`\\u{66}`')), ALL, () => ({ declLines: [2, 3] })],
    ['T3 const k = `\\x66`; [k]() next to f()', one('const k = `\\x66`;\nclass K {\n  f() {}\n  [k]() {}\n  m() { this.f(); }\n}\n'), ALL, () => ({ declLines: [3, 4] })],
    ['control: [`f`]() next to f()', one(keyed('`f`')), ALL, () => ({ declLines: [2, 3] })],
  ];
  it.each(expand(dupRows))('name-only, tsc lists 2: %s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });

  // tsc JS inference counts the write as a declaration (lines 2 and 5 in .js/.mjs); TS lists one.
  const writeRows: Row[] = [
    ['T4 K.prototype[`\\x66`] = … names the prototype', one('class K {\n  f() {}\n  m() { this.f(); }\n}\nK.prototype[`\\x66`] = () => {};\n'), ALL, (ext) => (ext === 'ts' ? {} : { declLines: [2, 5] })],
    ['T5 this[`\\x66`] = 1 is an own write', one('class K {\n  f() {}\n  m() { this[`\\x66`] = 1; this.f(); }\n}\n')],
    ['control: K.prototype[`f`] = …', one('class K {\n  f() {}\n  m() { this.f(); }\n}\nK.prototype[`f`] = () => {};\n'), ALL, (ext) => (ext === 'ts' ? {} : { declLines: [2, 5] })],
  ];
  it.each(expand(writeRows))('name-only, tsc lists 1: %s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });

  // T6: a class expression under a computed-literal or quoted field name takes the decoded name in its symbol ids.
  it.each(
    [
      ["['y']", "['y']"],
      ['"y"', '"y"'],
      ['"\\x79"', '"\\x79"'],
    ].flatMap(([label, key]) => ALL.map((ext) => [`${label} (${ext})`, key, ext] as const)),
  )('T6 ids under a field named %s', async (_label, key, ext) => {
    const file = `a.${ext}`;
    const tree = { [file]: `class K {\n  ${key} = class {\n    f() {}\n    b() { this.f(); }\n  };\n  f() {}\n  c() { this.f(); }\n}\n` };
    const repo = await link(tree);
    const ids = new Set((repo.files.get(file)?.symbols ?? []).map((s) => s.id));
    for (const id of ['K.y.f', 'K.y.b', 'K.f', 'K.c']) expect(ids.has(`${file}::${id}::method`), `symbol ${id}`).toBe(true);
    await expectArrow(tree, ext, { caller: 'K.y.b', target: `${file}::K.y.f::method` });
    await expectArrow(tree, ext, { caller: 'K.c', target: `${file}::K.f::method` });
  });
});

describe('gate 2 round 4', () => {
  // `\u{…}` takes any number of leading zeros (node: "\u{0000066}" is "f"); the source text keeps the escape.
  const ZF = '\\u{0000066}';
  const ZY = '\\u{0000079}';

  it.each(ALL)('U1 a quoted method alone is K.f (%s)', async (ext) => {
    const file = `a.${ext}`;
    const tree = { [file]: `class K {\n  '${ZF}'() { return 1; }\n  m() { return this.f(); }\n}\n` };
    const repo = await link(tree);
    expect(repo.files.get(file)?.symbols.some((s) => s.id === `${file}::K.f::method`), 'symbol K.f').toBe(true);
    await expectArrow(tree, ext, { declLine: 2, target: `${file}::K.f::method` });
  });

  const dup = (key: string) => `class K {\n  f() {}\n  ${key}() {}\n  m() { this.f(); }\n}\n`;
  const dupRows: Row[] = [
    ['U2 a quoted \\u{0000066} next to f()', one(dup(`'${ZF}'`)), ALL, () => ({ declLines: [2, 3] })],
    ['U2 a template [`\\u{0000066}`] next to f()', one(dup(`[\`${ZF}\`]`)), ALL, () => ({ declLines: [2, 3] })],
  ];
  it.each(expand(dupRows))('name-only, tsc lists 2: %s', async (_label, tree, ext, spec) => {
    await expectNameOnly(tree, ext, spec);
  });

  it.each(ALL)('U3 ids under a field named with a zero-padded escape (%s)', async (ext) => {
    const file = `a.${ext}`;
    const tree = { [file]: `class K {\n  '${ZY}' = class {\n    f() {}\n    b() { this.f(); }\n  };\n  f() {}\n  c() { this.f(); }\n}\n` };
    const repo = await link(tree);
    const ids = new Set((repo.files.get(file)?.symbols ?? []).map((s) => s.id));
    for (const id of ['K.y.f', 'K.y.b', 'K.f', 'K.c']) expect(ids.has(`${file}::${id}::method`), `symbol ${id}`).toBe(true);
    await expectArrow(tree, ext, { caller: 'K.y.b', target: `${file}::K.y.f::method` });
    await expectArrow(tree, ext, { caller: 'K.c', target: `${file}::K.f::method` });
  });

  // tsc JS inference counts the write as a declaration (lines 2 and 5 in .js/.mjs); TS lists one.
  const write = 'class K {\n  f() {}\n  m() { this.f(); }\n}\n';
  it.each(expand([['U4 K.prototype[`\\u{0000066}`] = …', one(`${write}K.prototype[\`${ZF}\`] = () => 1;\n`), ALL, (ext: string) => (ext === 'ts' ? {} : { declLines: [2, 5] })]]))(
    'name-only: %s',
    async (_label, tree, ext, spec) => {
      await expectNameOnly(tree, ext, spec);
    },
  );

  it.each(expand([['U5 Object.defineProperty(K.prototype, `\\u{0000066}`, …)', one(`${write}Object.defineProperty(K.prototype, \`${ZF}\`, { value: () => 1 });\n`), ALL, (ext: string) => (ext === 'ts' ? {} : { declLines: [2, 5] })]]))(
    'name-only: %s',
    async (_label, tree, ext, spec) => {
      await expectNameOnly(tree, ext, spec);
    },
  );

  // '\u{10FFFF}' is the largest valid code point: a real member name, not the unknown-key sentinel.
  it.each(ALL)('U6 a member named by \\u{10FFFF} is a member, so this.f() is K.f (%s)', async (ext) => {
    const tree = { [`a.${ext}`]: "class K {\n  f() {}\n  '\\u{10FFFF}'() {}\n  m() { this.f(); }\n}\n" };
    await expectArrow(tree, ext, { declLine: 2, target: `a.${ext}::K.f::method` });
  });

  // A member literally named `*` is a real name.
  const star = (key: string) => `class K {\n  f() {}\n  ${key}() {}\n  m() { this.f(); }\n}\n`;
  const starRows: Row[] = [
    ["U7 ['*']() {}", one(star("['*']")), ALL, () => ({ declLine: 2 })],
    ['U7 [`\\x2a`]() {}', one(star('[`\\x2a`]')), ALL, () => ({ declLine: 2 })],
    ["U7 '*'() {}", one(star("'*'")), ALL, () => ({ declLine: 2 })],
  ];
  it.each(expand(starRows))('arrow: %s', async (_label, tree, ext) => {
    await expectArrow(tree, ext, { declLine: 2, target: `a.${ext}::K.f::method` });
  });

  // Pin: a key core cannot prove still vetoes (tsc: the computed member is another name, 1 declaration).
  it.each(ALL)('an unknown key [k] with let k = "f" stays name-only (%s)', async (ext) => {
    await expectNameOnly({ [`a.${ext}`]: "let k = 'f';\nclass K {\n  f() {}\n  [k]() {}\n  m() { this.f(); }\n}\n" }, ext, { declLine: 3 });
  });
});

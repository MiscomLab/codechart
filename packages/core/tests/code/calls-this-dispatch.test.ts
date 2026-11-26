import { describe, it } from 'vitest';
import { link, nameOnly, resolved } from './scope-helpers.js';

/**
 * COD-59: `this.f()` dispatches on the instance's class at run time, not on the class that spells the call. The
 * TypeScript checker (the oracle) reports the declaration in the class that writes `this.f()`; but a subclass that
 * declares `f`, or any `this.f = …` write, makes the call reach something else on some instance.
 *
 * Runtime, checked with `node` on the compiled JS of the first two shapes below:
 *   class K { f() { return 'K'; } m() { return this.f(); } }
 *   class L extends K { f() { return 'L'; } }                                   new L().m() === 'L'
 *   class P extends K { constructor() { super(); this.f = () => 'P'; } }        new P().m() === 'P'
 * so core may resolve `this.f()` only where no class that extends this one by name declares or assigns `f`.
 */

const K_DECLARATION = { kind: 'MethodDeclaration' };
const K = 'class K {\n  f() {}\n  m() {\n    this.f();\n  }\n}\n';

describe('this.f() with no subclass declaring f resolves to the class method (control)', () => {
  it('a class with no subclass', async () => {
    const repo = await link({ 'a.ts': K });
    resolved(repo, 'f', 'a.ts::K.f::method', K_DECLARATION, 'K.m');
  });

  it('a subclass that does not declare f', async () => {
    const repo = await link({ 'a.ts': `${K}class L extends K {\n  g() {}\n}\n` });
    resolved(repo, 'f', 'a.ts::K.f::method', K_DECLARATION, 'K.m');
  });

  it('a subclass of another class that declares f', async () => {
    const repo = await link({ 'a.ts': `${K}class Other {}\nclass L extends Other {\n  f() {}\n}\n` });
    resolved(repo, 'f', 'a.ts::K.f::method', K_DECLARATION, 'K.m');
  });
});

describe('this.f() is name-only when a subclass declares f', () => {
  it.each([
    ['a method', 'class L extends K {\n  f() {}\n}\n'],
    ['an arrow-function field', 'class L extends K {\n  f = () => {};\n}\n'],
    ['a property declaration', 'class L extends K {\n  f: unknown;\n}\n'],
    ['a getter', 'class L extends K {\n  get f() {\n    return () => {};\n  }\n}\n'],
  ])('in the same file, %s', async (_form, sub) => {
    const repo = await link({ 'a.ts': `${K}${sub}` });
    nameOnly(repo, 'f', K_DECLARATION, 'K.m');
  });

  it('in another file', async () => {
    const repo = await link({ 'a.ts': K.replace('class K', 'export class K'), 'b.ts': "import { K } from './a';\nclass L extends K {\n  f() {}\n}\n" });
    nameOnly(repo, 'f', K_DECLARATION, 'K.m');
  });

  it('two levels down', async () => {
    const repo = await link({ 'a.ts': `${K}class L extends K {}\nclass M extends L {\n  f() {}\n}\n` });
    nameOnly(repo, 'f', K_DECLARATION, 'K.m');
  });

  it('through a qualified extends expression', async () => {
    const repo = await link({ 'a.ts': K.replace('class K', 'export class K'), 'b.ts': "import * as ns from './a';\nclass L extends ns.K {\n  f() {}\n}\n" });
    nameOnly(repo, 'f', K_DECLARATION, 'K.m');
  });
});

describe('this.f() is name-only when f is assigned on the instance', () => {
  it('in the class itself', async () => {
    const repo = await link({ 'a.ts': 'class K {\n  f() {}\n  constructor() {\n    this.f = () => {};\n  }\n  m() {\n    this.f();\n  }\n}\n' });
    nameOnly(repo, 'f', K_DECLARATION, 'K.m');
  });

  it('in a subclass', async () => {
    const repo = await link({ 'a.ts': `${K}class P extends K {\n  constructor() {\n    super();\n    this.f = () => {};\n  }\n}\n` });
    nameOnly(repo, 'f', K_DECLARATION, 'K.m');
  });
});

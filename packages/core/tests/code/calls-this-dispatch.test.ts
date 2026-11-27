import { describe, it } from 'vitest';
import { link, nameOnly, resolved, resolvedOne } from './scope-helpers.js';

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
/** tsc's one declaration of `f`: the class method on line 2 of a.ts. */
const K_METHOD = { kind: 'MethodDeclaration', parentKind: 'ClassDeclaration', file: 'a.ts', line: 2 };
const K_F = 'a.ts::K.f::method';
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

describe('this.f() resolves to K.f when a subclass declares f (tsc; a subclass override is a blind spot)', () => {
  it.each([
    ['a method', 'class L extends K {\n  f() {}\n}\n'],
    ['an arrow-function field', 'class L extends K {\n  f = () => {};\n}\n'],
    ['a property declaration', 'class L extends K {\n  f: unknown;\n}\n'],
    ['a getter', 'class L extends K {\n  get f() {\n    return () => {};\n  }\n}\n'],
  ])('in the same file, %s', async (_form, sub) => {
    // Compiler line: tsc gives this.f() exactly one declaration, K.f; the subclass member is no rebind.
    await resolvedOne({ 'a.ts': `${K}${sub}` }, 'a.ts', K_F, K_METHOD, 'K.m');
  });

  it('in another file', async () => {
    await resolvedOne({ 'a.ts': K.replace('class K', 'export class K'), 'b.ts': "import { K } from './a';\nclass L extends K {\n  f() {}\n}\n" }, 'a.ts', K_F, K_METHOD, 'K.m');
  });

  it('two levels down', async () => {
    await resolvedOne({ 'a.ts': `${K}class L extends K {}\nclass M extends L {\n  f() {}\n}\n` }, 'a.ts', K_F, K_METHOD, 'K.m');
  });

  it('through a qualified extends expression', async () => {
    await resolvedOne({ 'a.ts': K.replace('class K', 'export class K'), 'b.ts': "import * as ns from './a';\nclass L extends ns.K {\n  f() {}\n}\n" }, 'a.ts', K_F, K_METHOD, 'K.m');
  });
});

describe('this.f() is name-only when f is assigned on the instance', () => {
  it('in the class itself', async () => {
    const repo = await link({ 'a.ts': 'class K {\n  f() {}\n  constructor() {\n    this.f = () => {};\n  }\n  m() {\n    this.f();\n  }\n}\n' });
    nameOnly(repo, 'f', K_DECLARATION, 'K.m');
  });

  it('in a subclass resolves to K.f (tsc; a write in a subclass is a blind spot)', async () => {
    // Compiler line: tsc gives this.f() exactly one declaration, K.f; the write is in P, not K or a resolved base.
    await resolvedOne({ 'a.ts': `${K}class P extends K {\n  constructor() {\n    super();\n    this.f = () => {};\n  }\n}\n` }, 'a.ts', K_F, K_METHOD, 'K.m');
  });
});

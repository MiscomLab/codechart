import { describe, expect, it } from 'vitest';
import { linkFiles, resolvedOne, results } from './scope-helpers.js';

/**
 * COD-59 QA gate, round 10: `this.f()` dispatch and class declarations the symbol table holds but the runtime does not.
 *
 * Oracle: the Node runtime on each program (transpiled with tsx); the output is in each comment. Core names a method
 * where the runtime reaches a base attribute, throws, or reaches an accessor's return value; `undefined` is the
 * sound outcome. The dispatch index is checked to be per link pass at the end.
 */

const targets = async (tree: Record<string, string>): Promise<(string | undefined)[]> => results(await linkFiles(tree), 'f', 'a.ts');

describe('gate: this.f() in a class whose base writes this.f is name-only', () => {
  it('a base constructor writes this.f', async () => {
    // Runtime: new C().m() === "base.attr": the base constructor's instance property wins over C.f.
    expect(
      await targets({
        'a.ts': `class Base {\n  constructor() { this.f = () => 'base.attr'; }\n}\nclass C extends Base {\n  f() { return 'C.f'; }\n  m() { return this.f(); }\n}\nconsole.log(new C().m());\n`,
      }),
    ).toEqual([undefined]);
  });

  it('a mixin class expression extends Base and writes this.f: this.f() resolves to C.f (tsc; an unresolved base is a blind spot)', async () => {
    // Runtime: new C().m() === "mixin.attr": the mixin constructor's instance property wins over C.f.
    // Unresolved base (a call) is not followed: accepted blind spot, the compiler line.
    // Compiler line: tsc gives this.f() exactly one declaration, C.f; the only this.f write is in the mixin's class.
    await resolvedOne(
      {
        'a.ts': `function Mixin(Base: any) {\n  return class extends Base {\n    constructor(...a: any[]) { super(...a); this.f = () => 'mixin.attr'; }\n  };\n}\nclass B {}\nclass C extends Mixin(B) {\n  f() { return 'C.f'; }\n  m() { return this.f(); }\n}\nconsole.log(new C().m());\n`,
      },
      'a.ts',
      'a.ts::C.f::method',
      { kind: 'MethodDeclaration', parentKind: 'ClassDeclaration', file: 'a.ts', line: 8 },
    );
  });
});

describe('gate: this.f() in a static method does not reach instance methods, and an instance does not reach statics', () => {
  it('a static method calls this.f() and f is an instance method', async () => {
    // Runtime: C.m() throws TypeError: this.f is not a function (this is the constructor).
    expect(
      await targets({
        'a.ts': `class C {\n  f() { return 'instance.f'; }\n  static m() { return this.f(); }\n}\nconsole.log(C.m());\n`,
      }),
    ).toEqual([undefined]);
  });

  it('an instance method calls this.f() and f is static', async () => {
    // Runtime: new C().m() throws TypeError: this.f is not a function (this is the instance).
    expect(
      await targets({
        'a.ts': `class C {\n  static f() { return 'static.f'; }\n  m() { return this.f(); }\n}\nconsole.log(new C().m());\n`,
      }),
    ).toEqual([undefined]);
  });
});

describe('gate: this.f() does not reach a getter, an abstract declaration or a merged interface member', () => {
  it('f is a getter returning a function', async () => {
    // Runtime: new C().m() === "getter.value": the call reaches the getter's return value, not the getter.
    expect(
      await targets({
        'a.ts': `class C {\n  get f() { return () => 'getter.value'; }\n  m() { return this.f(); }\n}\nconsole.log(new C().m());\n`,
      }),
    ).toEqual([undefined]);
  });

  it('f is a getter returning a non-callable', async () => {
    // Runtime: new C().m() throws TypeError: this.f is not a function.
    expect(
      await targets({
        'a.ts': `class C {\n  get f() { return 1; }\n  m() { return this.f(); }\n}\nconsole.log(new C().m());\n`,
      }),
    ).toEqual([undefined]);
  });

  it('f is only an abstract declaration', async () => {
    // Runtime with a concrete instance: TypeError: this.f is not a function; the declaration has no body.
    expect(
      await targets({
        'a.ts': `abstract class C {\n  abstract f(): string;\n  m() { return this.f(); }\n}\nclass D extends C {}\nconsole.log(new (D as any)().m());\n`,
      }),
    ).toEqual([undefined]);
  });

  it('f is only a merged interface member', async () => {
    // Runtime: new C().m() throws TypeError: this.f is not a function; the interface adds no runtime member.
    expect(
      await targets({
        'a.ts': `interface C {\n  f(): string;\n}\nclass C {\n  m() { return this.f(); }\n}\nconsole.log(new C().m());\n`,
      }),
    ).toEqual([undefined]);
  });
});

describe('gate: a this.f write in any assignment form demotes the call', () => {
  it.each([
    ['an update', 'this.f++;'],
    ['a computed subscript', "this['f'] = () => 'sub.attr';"],
    ['a destructuring target', "[this.f] = [() => 'destructured'];"],
  ])('%s', async (_form, write) => {
    // Runtime: the property is the written value (or a TypeError); never the C.f method.
    expect(
      await targets({
        'a.ts': `class C {\n  f() { return 'C.f'; }\n  m() {\n    ${write}\n    return this.f();\n  }\n}\nconsole.log(new C().m());\n`,
      }),
    ).toEqual([undefined]);
  });
});

describe('gate: the dispatch index is per link pass', () => {
  it('a subclass linked in one pass does not leak into the next', async () => {
    const K = 'class K {\n  f() {}\n  m() {\n    this.f();\n  }\n}\n';
    const alone = await linkFiles({ 'a.ts': K });
    expect(results(alone, 'f', 'a.ts')).toEqual(['a.ts::K.f::method']);
    // Compiler line: tsc gives this.f() exactly one declaration, K.f; L's override is not a rebind.
    await resolvedOne({ 'a.ts': `${K}class L extends K {\n  f() {}\n}\n` }, 'a.ts', 'a.ts::K.f::method', { kind: 'MethodDeclaration', parentKind: 'ClassDeclaration', file: 'a.ts', line: 2 });
    const again = await linkFiles({ 'a.ts': K });
    expect(results(again, 'f', 'a.ts')).toEqual(['a.ts::K.f::method']);
  });
});

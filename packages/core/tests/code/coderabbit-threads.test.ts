import { describe, expect, it } from 'vitest';
import { link, linkFiles, nameOnly } from './scope-helpers.js';

/** COD-59, CodeRabbit review threads on PR #107 that HEAD did not yet cover, each checked against the real oracle. */

describe('CodeRabbit js-scope-build.ts:42: scopes inside enum initializers', () => {
  it('an arrow parameter inside an enum member initializer shadows the top-level function', async () => {
    const repo = await link({ 'a.ts': 'function f() { return 1; }\nfunction run() { enum E { A = ((f: any) => f())(() => 2) } }\n' });
    nameOnly(repo, 'f', { kind: 'Parameter', parentKind: 'ArrowFunction' }, 'run.E');
  });
});

describe('CodeRabbit js-scope-build.ts:49: JavaScript using declarations', () => {
  it('a using declaration in a .js file shadows the top-level function', async () => {
    const repo = await link({ 'a.js': 'function f() {}\nfunction run() { using f = null; f(); }\n' });
    nameOnly(repo, 'f', { kind: 'VariableDeclaration' }, 'run', 'a.js');
  });
});

describe('CodeRabbit module-scope.ts:137: an explicit binding overrides an inherited type parameter', () => {
  // python3 -I: `K().m()` returns 'local' (the method's own def), `K().n()` returns 'module' (global f).
  const at = async (body: string) => (await linkFiles({ 'a.py': `def f():\n    pass\n\n\nclass K[f]:\n${body}` })).get('a.py')!.calls.filter((c) => c.name === 'f').map((c) => c.to);

  it('a def in a method of a generic class resolves to that def, not the class type parameter', async () => {
    expect(await at('    def m(self):\n        def f():\n            pass\n        f()\n')).toEqual(['a.py::K.m.f::function']);
  });

  it('a global declaration in a method of a generic class reaches the module function', async () => {
    expect(await at('    def n(self):\n        global f\n        f()\n')).toEqual(['a.py::f::function']);
  });
});

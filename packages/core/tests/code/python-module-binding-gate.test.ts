import { describe, expect, it } from 'vitest';
import { linkFiles, results } from './scope-helpers.js';

/**
 * COD-59 QA gate, round 8: the module scope is not exempt from flow. A module binding inside a compound statement that
 * never ran, or written after the module code that calls it, is not bound when the call runs. The generated sweep
 * covers this for `def` bindings; these are the import, constructed-receiver and plain module-expression forms of the
 * same hole (a module assignment's value is read when the assignment runs).
 *
 * Expectations from CPython 3.14.7 (`python3 -I`): each program raises at the call site as its comment says.
 */

const B = 'def f():\n    pass\n';

describe('gate: a module binding that never ran proves no module callee', () => {
  it.each([
    ['an import under if False', 'if False:\n    from b import f\n\n\nclass K:\n    x = f()\n\n\nK\n'],
    ['an import after the class body', 'class K:\n    x = f()\n\n\nK\nfrom b import f\n'],
    ['an import after a raise in a try', 'try:\n    raise ValueError\n    from b import f\nexcept ValueError:\n    pass\n\n\nclass K:\n    x = f()\n\n\nK\n'],
  ])('%s is name-only (Runtime: NameError, name f is not defined)', async (_form, text) => {
    expect(results(await linkFiles({ 'a.py': text, 'b.py': B }), 'f')).toEqual([undefined]);
  });
});

describe('gate: a module expression before the def does not reach it', () => {
  it('X = f() before def f is name-only (Runtime: NameError, name f is not defined)', async () => {
    expect(results(await linkFiles({ 'a.py': 'X = f()\n\n\ndef f():\n    pass\n' }), 'f')).toEqual([undefined]);
  });
});

describe('gate: a module binding that never ran proves no constructed receiver', () => {
  it('x.m() after if False: x = C() is name-only (Runtime: NameError, name x is not defined)', async () => {
    const files = await linkFiles({
      'a.py': 'class C:\n    def m(self):\n        pass\n\n\nclass K:\n    def go(self):\n        return x.m()\n\n\nK().go()\nif False:\n    x = C()\n',
    });
    const call = files.get('a.py')!.calls.find((c) => c.name === 'm');
    expect(call?.to).toBeUndefined();
  });
});

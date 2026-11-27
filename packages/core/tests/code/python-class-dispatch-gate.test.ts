import { describe, expect, it } from 'vitest';
import { linkFiles, results } from './scope-helpers.js';

/**
 * COD-59 QA gate, round 10: a Python constructed receiver is not necessarily an instance of the class spelled at the
 * call. A metaclass's `__call__` or a class's `__new__` may return any object; core names the class's method anyway.
 *
 * Expectations from CPython 3.14.7 (`python3 -I`) on the same texts: both programs print "other", never calling C.f.
 */

const targets = async (text: string): Promise<(string | undefined)[]> => results(await linkFiles({ 'a.py': text }), 'f');

describe('gate: a constructed receiver follows __call__/__new__, not just the class named at the call', () => {
  it('a metaclass __call__ returning another type', async () => {
    // Runtime: C() returns Other(); c.f() is Other.f and prints "other".
    expect(
      await targets(`class Other:\n    def f(self):\n        return 'other'\n\n\nclass M(type):\n    def __call__(cls, *a, **k):\n        return Other()\n\n\nclass C(metaclass=M):\n    def f(self):\n        return 'C'\n\n\ndef run():\n    c = C()\n    return c.f()\n\n\nrun()\n`),
    ).toEqual([undefined]);
  });

  it('a class __new__ returning another type', async () => {
    // Runtime: C() returns Other(); c.f() is Other.f and prints "other".
    expect(
      await targets(`class Other:\n    def f(self):\n        return 'other'\n\n\nclass C:\n    def __new__(cls):\n        return Other()\n\n    def f(self):\n        return 'C'\n\n\ndef run():\n    c = C()\n    return c.f()\n\n\nrun()\n`),
    ).toEqual([undefined]);
  });
});

describe('COD-59 compiler line (G2): a Python base core cannot see keeps self.f() name-only', () => {
  // CPython 3.14.7 (`PYTHONPATH=. python3 k.py` with ext.py outside the repo): an external base whose __init__ sets
  // `self.f = lambda: "ext"` makes K().m() print "ext", not K.f; the same K over a plain base prints "K.f".
  // The unseen base may write self.f, so core stays name-only whether or not the external base does (JS/TS differ: G2).
  const external = (base: string) => ({
    'k.py': `from ext import ${base}\nclass K(${base}):\n    def f(self): return "K.f"\n    def m(self): return self.f()\n`,
  });

  it.each([
    ['an external base that writes self.f in __init__ (not in the repo)', 'SomeExternal'],
    ['an external base that does not write self.f (not in the repo)', 'PlainExternal'],
  ])('%s', async (_label, base) => {
    expect(results(await linkFiles(external(base)), 'f', 'k.py')).toEqual([undefined]);
  });

  it('a base in the repo without a write still resolves (control)', async () => {
    const tree = { 'k.py': 'class Plain:\n    pass\nclass K(Plain):\n    def f(self): return "K.f"\n    def m(self): return self.f()\n' };
    expect(results(await linkFiles(tree), 'f', 'k.py')).toEqual(['k.py::K.f::method']);
  });
});

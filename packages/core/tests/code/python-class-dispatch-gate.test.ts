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

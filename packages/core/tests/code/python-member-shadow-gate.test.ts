import { describe, expect, it } from 'vitest';
import { linkFiles, results } from './scope-helpers.js';

/**
 * COD-59 QA gate, round 8: `self.`/`cls.` and constructed-receiver calls resolve a method from the symbol table
 * without consulting the class body's binding of that name. A decorator replaces the name, a later assignment or
 * `del` changes it, and `self` in a class body is not bound at all: CPython reaches none of those methods.
 *
 * Expectations from CPython 3.14.7 (`python3 -I`) on the same texts: each program below logs or raises at the call
 * site as the comment says, and never reaches the method symbol core names.
 */

const targets = async (text: string, path = 'a.py'): Promise<(string | undefined)[]> => results(await linkFiles({ [path]: text }), 'f', path);

describe('gate: a decorated class-body def is the callee of self./instance calls only when the decorator returns it', () => {
  it.each([
    [
      'self.f() in a method',
      // Runtime: self.f is the decorator's lambda; the call returns object(), the method never runs.
      'class K:\n    @(lambda fn: (lambda *a: object()))\n    def f(self):\n        pass\n\n    def g(self):\n        return self.f()\n\nK().g()\n',
    ],
    [
      'c.f() through a constructed receiver',
      // Runtime: c.f is the decorator's lambda; the call returns object(), the method never runs.
      'class C:\n    @(lambda fn: (lambda *a: object()))\n    def f(self):\n        pass\n\n\ndef run():\n    c = C()\n    return c.f()\n\n\nrun()\n',
    ],
  ])('%s is not the method', async (_form, text) => {
    expect(await targets(text)).toEqual([undefined]);
  });

  it('an imported class’s decorated method is not the method', async () => {
    // Runtime: c.f is the decorator's lambda; the call returns object(), the method never runs.
    const files = await linkFiles({
      'a.py': 'from c import C\n\n\ndef run():\n    c = C()\n    return c.f()\n\n\nrun()\n',
      'c.py': 'class C:\n    @(lambda fn: (lambda *a: object()))\n    def f(self):\n        pass\n',
    });
    expect(results(files, 'f', 'a.py')).toEqual([undefined]);
  });
});

describe('gate: a class-body binding after the def still decides what self./instance calls reach', () => {
  it.each([
    [
      'self.f() after the class attribute is rebound',
      // Runtime: TypeError: the rebound lambda is bound as a method and takes no self; the def never runs.
      'class K:\n    def f(self):\n        pass\n\n    def g(self):\n        return self.f()\n\n    f = lambda: object()\n\nK().g()\n',
    ],
    [
      'c.f() after the class attribute is rebound',
      // Runtime: TypeError: the rebound lambda is bound as a method and takes no self; the def never runs.
      'class C:\n    def f(self):\n        pass\n\n    f = lambda: object()\n\n\ndef run():\n    c = C()\n    return c.f()\n\n\nrun()\n',
    ],
    [
      'self.f() after the method is deleted',
      // Runtime: AttributeError: 'K' object has no attribute 'f'.
      'class K:\n    def f(self):\n        pass\n\n    del f\n\n    def g(self):\n        return self.f()\n\nK().g()\n',
    ],
  ])('%s is not the method', async (_form, text) => {
    expect(await targets(text)).toEqual([undefined]);
  });
});

describe('gate: self in a class body is not a class instance', () => {
  it('self.f() in the class namespace is name-only (Runtime: NameError, name self is not defined)', async () => {
    expect(await targets('class K:\n    def f(self):\n        pass\n\n    x = self.f()\n')).toEqual([undefined]);
  });
});

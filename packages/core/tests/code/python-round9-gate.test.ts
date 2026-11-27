import { describe, expect, it } from 'vitest';
import { linkFiles, results } from './scope-helpers.js';

/**
 * COD-59 QA gate, round 9: inheritance and TYPE_CHECKING shadows, and the documented import-time limit.
 *
 * Expectations from CPython 3.14.7 (`python3 -I`) on the same texts. A base class's `self.f = …` write shadows a
 * subclass method; `TYPE_CHECKING` is a normal name, so a module, class or parameter binding of it decides whether
 * `if not TYPE_CHECKING:` runs; and an import-time call above the later `def f` raises NameError even when the
 * program catches it and imports (or reaches a builtin `f` instead). Core names the subclass method / module def in
 * every case below; CPython reaches none of them.
 */

const targets = async (tree: Record<string, string>, name = 'f', path = 'a.py'): Promise<(string | undefined)[]> =>
  results(await linkFiles(tree), name, path);

describe('gate: a base class’s self.<name> write shadows the subclass method', () => {
  it('self.f() after a base __init__ writes it (same file) is name-only', async () => {
    // Runtime: C().g() calls the base __init__'s lambda, never C.f.
    expect(
      await targets({
        'a.py': `class B:\n    def __init__(self):\n        self.f = lambda *a: object()\n\n\nclass C(B):\n    def f(self):\n        return object\n\n    def g(self):\n        return self.f()\n\n\nC().g()\n`,
      }),
    ).toEqual([undefined]);
  });

  it('self.f() after a base __init__ writes it (base in another file) is name-only', async () => {
    // Runtime: C().g() calls the base __init__'s lambda, never C.f.
    expect(
      await targets({
        'a.py': `from b import B\n\n\nclass C(B):\n    def f(self):\n        return object\n\n    def g(self):\n        return self.f()\n\n\nC().g()\n`,
        'b.py': 'class B:\n    def __init__(self):\n        self.f = lambda *a: object()\n',
      }),
    ).toEqual([undefined]);
  });
});

describe('gate: TYPE_CHECKING is a name, not always the typing constant', () => {
  it('a module binding TYPE_CHECKING = True makes if not TYPE_CHECKING skip the def', async () => {
    // Runtime: the body is skipped; the class body raises NameError, which the try catches, and the module imports.
    expect(
      await targets({
        'a.py': `TYPE_CHECKING = True\nif not TYPE_CHECKING:\n    def f():\n        return object\n\n\ntry:\n    class K:\n        x = f()\nexcept NameError:\n    pass\n`,
      }),
    ).toEqual([undefined]);
  });

  it('a monkeypatched typing.TYPE_CHECKING = True makes if not typing.TYPE_CHECKING skip the def', async () => {
    // Runtime: the body is skipped; the class body raises NameError, which the try catches, and the module imports.
    expect(
      await targets({
        'a.py': `import typing\ntyping.TYPE_CHECKING = True\nif not typing.TYPE_CHECKING:\n    def f():\n        return object\n\n\ntry:\n    class K:\n        x = f()\nexcept NameError:\n    pass\n`,
      }),
    ).toEqual([undefined]);
  });

  it('a parameter TYPE_CHECKING = True makes if not TYPE_CHECKING skip the def', async () => {
    // Runtime: run(True) leaves f unbound and f() raises UnboundLocalError, which the try catches.
    expect(
      await targets({
        'a.py': `def run(TYPE_CHECKING):\n    if not TYPE_CHECKING:\n        def f():\n            return object\n    return f()\n\n\ntry:\n    run(True)\nexcept UnboundLocalError:\n    pass\n`,
      }),
    ).toEqual([undefined]);
  });

  it('a class-body TYPE_CHECKING = True makes if not TYPE_CHECKING skip the def before a bare call', async () => {
    // Runtime: the class body skips the def, so x = f() raises NameError, which the try catches.
    expect(
      await targets({
        'a.py': `try:\n    class K:\n        TYPE_CHECKING = True\n        if not TYPE_CHECKING:\n            def f():\n                return object\n        x = f()\nexcept NameError:\n    pass\n`,
      }),
    ).toEqual([undefined]);
  });
});

// Documented limit (python-sweep.test.ts): core cannot tell statically which functions run at import time (directly,
// through callbacks or threads, or after a builtin is installed), short of dropping every function-body call to a module
// def written later. These two stay as the gate wrote them, marked `it.fails`: they flip to failing if the limit is lifted.
describe('gate: the documented import-time limit in a program that imports', () => {
  it.fails('a caught NameError above the def is not an edge to the def', async () => {
    // Runtime: run() catches NameError from f() before the def, so the module imports and the call reached nothing.
    expect(
      await targets({
        'a.py': `def run():\n    try:\n        return f()\n    except NameError:\n        return None\n\n\nrun()\ndef f():\n    return object\n`,
      }),
    ).toEqual([undefined]);
  });

  it.fails('a builtin f reached above the def is not an edge to the later def', async () => {
    // Runtime: the module installs builtins.f, so run() reaches that lambda, not the def written below; it imports.
    expect(
      await targets({
        'a.py': `import builtins\nbuiltins.f = lambda: object()\n\n\ndef run():\n    return f()\n\n\nrun()\ndef f():\n    return object\n`,
      }),
    ).toEqual([undefined]);
  });
});

describe('gate: a member call follows the instance’s class, not only the class that spells self.f()', () => {
  it('a base method’s self.f() on a subclass instance reaches the subclass override', async () => {
    // Runtime: L().m() returns "L": self.f is L.f, not the K.f core names.
    expect(
      await targets({
        'a.py': `class K:\n    def f(self):\n        return 'K'\n\n    def m(self):\n        return self.f()\n\n\nclass L(K):\n    def f(self):\n        return 'L'\n\n\nL().m()\n`,
      }),
    ).toEqual([undefined]);
  });

  it('a class attribute assigned at module level replaces the method', async () => {
    // Runtime: K().m() returns "X": K.f was replaced by the module-level lambda.
    expect(
      await targets({
        'a.py': `class K:\n    def f(self):\n        return 'K'\n\n    def m(self):\n        return self.f()\n\n\nK.f = lambda self: 'X'\nK().m()\n`,
      }),
    ).toEqual([undefined]);
  });

  it('an instance attribute set on a constructed receiver replaces the method', async () => {
    // Runtime: run() returns "X": k.f is the lambda set in run, not the method.
    expect(
      await targets({
        'a.py': `class K:\n    def f(self):\n        return 'K'\n\n\ndef run():\n    k = K()\n    k.f = lambda: 'X'\n    return k.f()\n\n\nrun()\n`,
      }),
    ).toEqual([undefined]);
  });
});

describe('gate: a module attribute call does not prove a module def that never ran', () => {
  it.each([
    ['under if False', 'if False:\n    def f(): return "F"\n'],
    ['after a raise in a try', 'try:\n    raise ImportError\n    def f(): return "F"\nexcept ImportError:\n    pass\n'],
    ['under if __name__ == "__main__"', 'if __name__ == "__main__":\n    def f(): return "F"\n'],
  ])('%s', async (_form, m) => {
    // Runtime: m binds no f, so m.f() raises AttributeError, which the try catches; both modules import.
    expect(
      await targets({
        'm.py': m,
        'a.py': 'import m\n\n\ndef run():\n    try:\n        return m.f()\n    except AttributeError:\n        return None\n\n\nrun()\n',
      }),
    ).toEqual([undefined]);
  });
});

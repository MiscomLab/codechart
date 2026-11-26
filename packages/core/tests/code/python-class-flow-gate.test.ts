import { describe, expect, it } from 'vitest';
import { linkFiles } from './scope-helpers.js';

/**
 * COD-59 QA gate: a class body runs top to bottom like any block, so a class-body binding may not exist yet, may never
 * have been made (an `if` or `try` that skipped it), or may be replaced later in a loop. Its name then falls through to
 * the module, or reaches the later value. Expectations from running each program with CPython 3.14.7 (`python3 -I`).
 *
 * Soundness only: name-only is acceptable everywhere, and where CPython reached the module `f`, resolving to it is too.
 * What must never happen is a resolved call to the class-body `K.f` that CPython did not reach.
 */

const sound = async (text: string, allowed: readonly (string | undefined)[]): Promise<void> => {
  const calls = (await linkFiles({ 'a.py': text })).get('a.py')!.calls.filter((c) => c.name === 'f');
  expect(calls).toHaveLength(1);
  expect(allowed, `core resolved to ${calls[0]!.to}`).toContain(calls[0]!.to);
};

const MODULE_OR_NONE = [undefined, 'a.py::f::function'];

describe('gate: a class-body binding that never ran does not shadow the module function', () => {
  it.each([
    // Runtime: K.x == "MOD".
    ['an if False block, called in the body', 'def f(): return "MOD"\nclass K:\n    if False:\n        class f: pass\n    x = f()\n'],
    // Runtime: K.x == "MOD"; the raise skips the class statement.
    ['a try block that raised first', 'def f(): return "MOD"\nclass K:\n    try:\n        raise ValueError\n        class f: pass\n    except ValueError:\n        pass\n    x = f()\n'],
    // Runtime: K.m.__defaults__ == ("MOD",).
    ['an if False block, called in a method default', 'def f(): return "MOD"\nclass K:\n    if False:\n        class f: pass\n    def m(self, a=f()): pass\n'],
    // Runtime: K.I.__bases__ == (object,), from the module f.
    ['an if False block, called in a nested class base', 'def f(): return object\nclass K:\n    if False:\n        class f: pass\n    class I(f()): pass\n'],
  ])('%s', async (_form, text) => {
    await sound(text, MODULE_OR_NONE);
  });
});

describe('gate: a class-body binding replaced later in a loop proves no single target', () => {
  it.each([
    // Runtime: the second iteration raises TypeError ('int' object is not callable): the call reached the int.
    ['an assignment after the call', 'def f(): return "MOD"\nclass K:\n    class f: pass\n    for _ in range(2):\n        x = f()\n        f = 1\n'],
    // Runtime: the second iteration raises NameError: the class-body f was deleted.
    ['a del after the call', 'def f(): return "MOD"\nclass K:\n    class f: pass\n    n = 0\n    while n < 2:\n        x = f()\n        n += 1\n        del f\n'],
  ])('%s', async (_form, text) => {
    await sound(text, [undefined]);
  });
});

describe('gate: a class-body binding inside any compound statement may never have run', () => {
  it.each([
    // Runtime (python3 -I, 3.14.7): each class's x == "MOD"; the class-body `class f` never ran.
    ['a for loop over nothing', 'def f(): return "MOD"\nclass K:\n    for _ in []:\n        class f: pass\n    x = f()\n'],
    ['a while loop that never runs', 'def f(): return "MOD"\nclass K:\n    while False:\n        class f: pass\n    x = f()\n'],
    ['an except clause that never runs', 'def f(): return "MOD"\nclass K:\n    try:\n        pass\n    except Exception:\n        class f: pass\n    x = f()\n'],
    [
      'a with block whose body raised in a nested if',
      'import contextlib\ndef f(): return "MOD"\nclass K:\n    with contextlib.suppress(ValueError):\n        if True:\n            raise ValueError\n        class f: pass\n    x = f()\n',
    ],
    ['a match case that does not match', 'def f(): return "MOD"\nclass K:\n    match 0:\n        case 1:\n            class f: pass\n    x = f()\n'],
  ])('%s', async (_form, text) => {
    await sound(text, MODULE_OR_NONE);
  });
});

describe('gate: a lambda in a type alias’s own type-parameter bound binds its parameter', () => {
  it('the call reaches the lambda argument, not the module function', async () => {
    // Runtime: `type Al[T: (lambda f: f())(lambda: "P")] = int`; Al.__type_params__[0].__bound__ == "P".
    await sound('def f(): return "MOD"\ndef run():\n    type Al[T: (lambda f: f())(lambda: "P")] = int\n    return Al\n', [undefined]);
  });
});

describe('gate: a comprehension’s later iterable skips the class body', () => {
  it('a call in the second for clause reaches the module function', async () => {
    // Runtime: K.x == ["MOD"]: only the first iterable runs in the class body.
    await sound('def f(): return "MOD"\nclass K:\n    class f: pass\n    x = [v for _ in [0] for v in [f()]]\n', MODULE_OR_NONE);
  });
});

describe('python sweep causes: class-body flow and lazy positions', () => {
  const calls = async (text: string) => {
    const files = await linkFiles({ 'a.py': `def f():\n    pass\n\n\n${text}` });
    return files.get('a.py')!.calls.filter((c) => c.name === 'f').map((c) => c.to);
  };

  it('a class-body def in a try that raised is not the callee', async () => {
    // CPython: the call reaches the module f; the def never ran.
    expect(await calls('class K:\n    try:\n        raise ValueError\n        def f():\n            pass\n    except ValueError:\n        pass\n    x = f()\n')).toEqual(['a.py::f::function']);
  });

  it('a lazy annotation sees the final class body, so a later rebinding makes the class def unprovable', async () => {
    // CPython 3.14 annotationlib VALUE: the annotation calls the later `f = lambda: 'rebind'`, not the class `f`.
    expect(await calls("class K:\n    class f:\n        pass\n    def m(self, a: f()):\n        pass\n    f = lambda: 'rebind'\n")).toEqual([undefined]);
  });

  it('a class def rebound in a loop is not the callee of every iteration', async () => {
    // CPython: iteration 1 reaches the class f, iteration 2 the rebound value.
    expect(await calls('class K:\n    class f:\n        pass\n    for _i in range(2):\n        x = f()\n        f = 1\n')).toEqual([undefined]);
  });

  it.each([
    ['a type alias value', 'def run():\n    type A = (lambda f: f())(g)\n'],
    ['a type parameter bound', 'def run[T: (lambda f: f())(g)]():\n    pass\n'],
  ])('a lambda in %s binds its own parameter', async (_form, text) => {
    // CPython: `A.__value__` / the bound evaluates the lambda's argument, not the module f.
    expect(await calls(`def g():\n    pass\n\n\n${text}`)).toEqual([undefined]);
  });
});

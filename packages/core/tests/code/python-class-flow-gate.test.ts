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

describe('gate: a comprehension’s later iterable skips the class body', () => {
  it('a call in the second for clause reaches the module function', async () => {
    // Runtime: K.x == ["MOD"]: only the first iterable runs in the class body.
    await sound('def f(): return "MOD"\nclass K:\n    class f: pass\n    x = [v for _ in [0] for v in [f()]]\n', MODULE_OR_NONE);
  });
});

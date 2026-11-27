import { describe, expect, it } from 'vitest';
import { linkFiles } from './scope-helpers.js';

/**
 * COD-59 QA gate: member calls (`self.f()`, `cls.f()`, `c.f()`, `m.f()`) and module flow the sweep does not generate.
 * Expectations from running each program with CPython 3.14.7 (`python3 -I`). Soundness: a resolved call must be one
 * CPython reaches; name-only is always sound.
 */

const fTargets = async (tree: Record<string, string>, path = 'a.py'): Promise<(string | undefined)[]> =>
  (await linkFiles(tree)).get(path)!.calls.filter((c) => c.name === 'f').map((c) => c.to);

describe('gate: an instance attribute a method writes replaces the method (pins the attribute-write scan)', () => {
  it.each([
    // Runtime: K().m() == "ATTR".
    ['an assignment', 'self.f = lambda: "ATTR"'],
    // Runtime: the attribute is the loop value, "FOR".
    ['a for target', 'for self.f in [lambda: "FOR"]: pass'],
    // Runtime: the attribute is the tuple element.
    ['a tuple target', 'self.f, _ = (lambda: "T"), 0'],
    // Runtime: `self.f += …` on a bound method raises TypeError; the write is still a write.
    ['an augmented assignment', 'self.f += 1'],
    // Runtime: `del self.f` raises AttributeError (no instance attribute); the call never reaches K.f through it.
    ['a del', 'del self.f'],
  ])('%s', async (_form, write) => {
    const text = `class K:\n    def f(self): return "K"\n    def __init__(self):\n        ${write}\n    def m(self):\n        return self.f()\n`;
    expect(await fTargets({ 'a.py': text })).toEqual([undefined]);
  });
});

describe('gate: a method defined under a condition may not exist (pins plainMethod’s conditional check)', () => {
  it.each([
    // Runtime: AttributeError: the method was never defined.
    ['self.f()', 'class K:\n    if False:\n        def f(self): return "K"\n    def m(self):\n        return self.f()\n'],
    ['a constructed receiver', 'class K:\n    if False:\n        def f(self): return "K"\ndef run():\n    c = K()\n    return c.f()\n'],
  ])('%s', async (_form, text) => {
    expect(await fTargets({ 'a.py': text })).toEqual([undefined]);
  });
});

describe('gate: self in a method header is not the method’s self (pins the header check)', () => {
  it('a default naming self resolves to nothing', async () => {
    // Runtime: NameError at class creation: `self` is not bound where the default is evaluated.
    expect(await fTargets({ 'a.py': 'class K:\n    def f(self): return "K"\n    def m(self, a=self.f()): return a\n' })).toEqual([undefined]);
  });
});

describe('gate: a method a subclass overrides is not proven for self calls', () => {
  it('self.f() in the base reaches the override on a subclass instance', async () => {
    // Runtime: L().m() == "L".
    const text = 'class K:\n    def f(self): return "K"\n    def m(self):\n        return self.f()\nclass L(K):\n    def f(self): return "L"\n';
    expect(await fTargets({ 'a.py': text })).toEqual([undefined]);
  });
});

describe('gate: a method replaced from outside the class is not proven', () => {
  it.each([
    // Runtime: K().m() == "X": `K.f = …` at module level replaces the class attribute.
    ['a class attribute assigned at module level', 'class K:\n    def f(self): return "K"\n    def m(self):\n        return self.f()\nK.f = lambda self: "X"\n'],
    // Runtime: run() == "X": the instance attribute set in run shadows the method.
    ['an instance attribute set on a constructed receiver', 'class K:\n    def f(self): return "K"\ndef run():\n    k = K()\n    k.f = lambda: "X"\n    return k.f()\n'],
  ])('%s', async (_form, text) => {
    expect(await fTargets({ 'a.py': text })).toEqual([undefined]);
  });
});

describe('gate: a module attribute call does not prove a module def that never ran', () => {
  it.each([
    // Runtime: `import m; m.f()` raises AttributeError: m never bound f.
    ['under if False', 'if False:\n    def f(): return "F"\n'],
    ['after a raise in a try', 'try:\n    raise ImportError\n    def f(): return "F"\nexcept ImportError:\n    pass\n'],
  ])('%s', async (_form, m) => {
    expect(await fTargets({ 'm.py': m, 'a.py': 'import m\ndef run():\n    return m.f()\n' })).toEqual([undefined]);
  });
});

describe('gate: `if not TYPE_CHECKING` always runs only when TYPE_CHECKING is typing’s', () => {
  it('a module that sets TYPE_CHECKING = True never runs the body', async () => {
    // Runtime: run() raises NameError.
    const text = 'TYPE_CHECKING = True\nif not TYPE_CHECKING:\n    def f(): return "F"\ndef run():\n    return f()\n';
    expect(await fTargets({ 'a.py': text })).toEqual([undefined]);
  });
});

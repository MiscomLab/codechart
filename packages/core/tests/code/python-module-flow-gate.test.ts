import { describe, expect, it } from 'vitest';
import { linkFiles } from './scope-helpers.js';

/**
 * COD-59 QA gate: module-scope bindings and importers. Expectations from running each program with CPython 3.14.7
 * (`python3 -I`). Soundness: a resolved call must be one CPython reaches; name-only is always sound.
 */

const fTargets = async (tree: Record<string, string>, path = 'a.py'): Promise<(string | undefined)[]> =>
  (await linkFiles(tree)).get(path)!.calls.filter((c) => c.name === 'f').map((c) => c.to);

const DECORATED_B = 'def deco(fn):\n    return lambda: "DECO"\n@deco\ndef f():\n    return "F"\n';

describe('gate: an importer does not resolve to a top-level def a decorator replaces', () => {
  it.each([
    // Runtime: with this b.py, `from b import f; f()` returns "DECO".
    ['a from-import', 'from b import f\ndef run():\n    return f()\n'],
    // Runtime: `import b; b.f()` returns "DECO".
    ['a module attribute', 'import b\ndef run():\n    return b.f()\n'],
  ])('%s', async (_form, a) => {
    expect(await fTargets({ 'a.py': a, 'b.py': DECORATED_B })).toEqual([undefined]);
  });
});

describe('gate: a module def that never ran is not the callee', () => {
  it.each([
    // Runtime: each program's run() raises NameError: name 'f' is not defined.
    ['under if False', 'if False:\n    def f(): return "F"\ndef run():\n    return f()\n'],
    ['after a raise in a try', 'try:\n    raise ImportError\n    def f(): return "F"\nexcept ImportError:\n    pass\ndef run():\n    return f()\n'],
    ['in a loop over nothing', 'for _ in []:\n    def f(): return "F"\ndef run():\n    return f()\n'],
    ['in a while False loop', 'while False:\n    def f(): return "F"\ndef run():\n    return f()\n'],
    ['after a raise a with block suppresses', 'import contextlib\nwith contextlib.suppress(ValueError):\n    raise ValueError\n    def f(): return "F"\ndef run():\n    return f()\n'],
  ])('%s', async (_form, a) => {
    expect(await fTargets({ 'a.py': a })).toEqual([undefined]);
  });
});

describe('gate: module code that runs before the def does not reach it', () => {
  it.each([
    // Runtime: NameError at import: the class body runs before `def f`.
    ['a module class body', 'class K:\n    x = f()\ndef f(): return "F"\n'],
    // Runtime: NameError at import: the default is evaluated when `def run` runs, before `def f`.
    ['a module def default', 'def run(a=f()): return a\ndef f(): return "F"\n'],
  ])('%s', async (_form, a) => {
    expect(await fTargets({ 'a.py': a })).toEqual([undefined]);
  });
});

describe('gate: a function body may call a module def written later (pin)', () => {
  it('the call resolves: the module has defined f by the time run is called', async () => {
    // Runtime: `def run(): return f()` then `def f(): return "F"` then `run()` returns "F".
    expect(await fTargets({ 'a.py': 'def run():\n    return f()\ndef f(): return "F"\n' })).toEqual(['a.py::f::function']);
  });
});

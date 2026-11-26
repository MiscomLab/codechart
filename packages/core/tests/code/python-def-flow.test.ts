import { describe, expect, it } from 'vitest';
import { linkFiles } from './scope-helpers.js';

/**
 * COD-59, causes the generated Python sweep found (packages/core/tests/code/python-sweep), each confirmed with CPython
 * 3.14.7 (`python3 -I`): a local def or class the call cannot have reached yet, and a definition a decorator replaces.
 */
const calls = async (text: string): Promise<(string | undefined)[]> => {
  const files = await linkFiles({ 'a.py': `def f():\n    pass\n\n\n${text}` });
  return files.get('a.py')!.calls.filter((c) => c.name === 'f').map((c) => c.to);
};

describe('a local definition the call has not reached yet', () => {
  it.each([
    ['a def after the call', 'def run():\n    f()\n    def f():\n        pass\n'],
    ['a class after the call', 'def run():\n    f()\n    class f:\n        pass\n'],
    ['a def under if False', 'def run():\n    if False:\n        def f():\n            pass\n    f()\n'],
    ['a def after a raise in a try', 'def run():\n    try:\n        raise ValueError\n        def f():\n            pass\n    except ValueError:\n        pass\n    f()\n'],
    ['a class body run before the def', 'def run():\n    class K:\n        x = f()\n    def f():\n        pass\n'],
    ['a def rebound in a loop after the call', 'def run():\n    for _i in range(2):\n        try:\n            f()\n        except Exception:\n            pass\n        def f():\n            pass\n'],
  ])('%s is not the callee', async (_form, text) => {
    // CPython: UnboundLocalError (or NameError from the class body / varies across iterations), never the local def.
    expect(await calls(text)).toEqual([undefined]);
  });

  it('a def before the call still resolves', async () => {
    expect(await calls('def run():\n    def f():\n        pass\n    f()\n')).toEqual(['a.py::run.f::function']);
  });
});

describe('a decorated definition binds what the decorator returns', () => {
  it.each([
    ['a module def', '@(lambda fn: (lambda: 0))\ndef g():\n    pass\n\n\ndef run():\n    g()\n', 'g'],
    ['a local def', 'def run():\n    @(lambda fn: (lambda: 0))\n    def f():\n        pass\n    f()\n', 'f'],
    ['a local class', 'def run():\n    @(lambda c: (lambda: 0))\n    class f:\n        pass\n    f()\n', 'f'],
    ['a class-body class', 'class K:\n    @(lambda c: (lambda: 0))\n    class f:\n        pass\n    x = f()\n', 'f'],
  ])('a call to %s a decorator replaces is not the definition', async (_form, text, name) => {
    // CPython: the call reaches the decorator's return value (here a lambda), not the def or class.
    const files = await linkFiles({ 'a.py': `def f():\n    pass\n\n\n${text}` });
    expect(files.get('a.py')!.calls.filter((c) => c.name === name).map((c) => c.to)).toEqual([undefined]);
  });
});

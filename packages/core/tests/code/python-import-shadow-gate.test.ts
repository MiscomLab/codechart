import { describe, expect, it } from 'vitest';
import { linkFiles, results } from './scope-helpers.js';

/**
 * COD-59: a class a later (or earlier) `from x import Foreign as K` rebinds. Oracle: CPython 3.14.7 (`PYTHONPATH=. python3 -I a.py`
 * with x.py = `class Foreign:\n    def f(self): return "foreign"`); each output is in its comment.
 */

const X = 'class Foreign:\n    def f(self): return "foreign"\n';
const run = async (a: string): Promise<(string | undefined)[]> => results(await linkFiles({ 'a.py': a, 'x.py': X }), 'f');

describe('Python: the base name L(K) is the binding live at the class statement', () => {
  it('the import comes first, the local class rebinds K: self.f() reaches the local K.f', async () => {
    // CPython: prints `local ['__main__.L', '__main__.K', 'builtins.object']`: the later `class K` wins, MRO L, K(local), object.
    expect(await run('from x import Foreign as K\nclass K:\n    def f(self): return "local"\nclass L(K):\n    def g(self): return self.f()\n')).toEqual(['a.py::K.f::method']);
  });

  it('the local class comes first, the import rebinds K: self.f() never reaches the local K.f', async () => {
    // CPython: prints `foreign ['__main__.L', 'x.Foreign', 'builtins.object']`: L's base is Foreign; local K.f is not in the MRO.
    // a.py's K.f would be wrong. Core does not dispatch self calls through an imported base (`from x import Foreign as K`
    // then `class L(K)` alone is name-only too), so the call stays name-only, exactly as with no local K.
    expect(await run('class K:\n    def f(self): return "local"\nfrom x import Foreign as K\nclass L(K):\n    def g(self): return self.f()\n')).toEqual([undefined]);
    expect(await run('from x import Foreign as K\nclass L(K):\n    def g(self): return self.f()\n')).toEqual([undefined]);
  });
});

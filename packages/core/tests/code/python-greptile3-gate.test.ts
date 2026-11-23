import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * Gate 1 scenarios for Greptile's P2 on d55db9b (`import test` with no repo `test`). The fix must narrow the `test`
 * guard without letting a repo folder be mistaken for CPython's installed `test` package. Each case quotes a
 * `python3 -I` (3.14) run or the repo's existing rule for a name found elsewhere in the repo.
 */

async function link(tree: Record<string, string>): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const outcome = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.imports.map((i) => [i.spec, i.status, i.resolved]);
const callsOf = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.calls.map((c) => [c.name, c.evidence, c.to]);

describe('`test` and the repo', () => {
  // Repo rule (python-incremental "unknown once a module of that name appears"): a name found in the repo but not on the
  // importing file's roots may be what runs, so it is unknown, not external.
  it('a test module elsewhere in the repo, not on the roots, keeps test unknown', async () => {
    const files = await link({ 'main.py': 'import test\n', 'tools/test.py': 'x = 1\n' });
    expect(outcome(files, 'main.py')).toEqual([['test', 'unknown', undefined]]);
  });

  it('a test package nested in another package keeps test unknown', async () => {
    const files = await link({ 'main.py': 'import test.support\n', 'pkg/__init__.py': '', 'pkg/test/__init__.py': '' });
    expect(outcome(files, 'main.py')).toEqual([['test.support', 'unknown', undefined]]);
  });

  // Stub stems count as "this name exists in the repo" (COD-44 decision), so a test.pyi keeps it unknown.
  it('a test.pyi stub keeps test unknown', async () => {
    const files = await link({ 'main.py': 'import test\n', 'test.pyi': 'x: int\n' });
    expect(outcome(files, 'main.py')).toEqual([['test', 'unknown', undefined]]);
  });

  // sys.path.insert(0, repo): `import test; test.f()` -> 'repo test.py' (a module on an earlier entry beats the stdlib package).
  it('a test.py module on the root is the repo module', async () => {
    const files = await link({ 'main.py': 'import test\n\n\ndef run():\n    return test.f()\n', 'test.py': 'def f():\n    pass\n' });
    expect(outcome(files, 'main.py')).toEqual([['test', 'resolved', 'test.py']]);
    expect(callsOf(files, 'main.py')).toEqual([['f', 'resolved', 'test.py::f::function']]);
  });

  // sys.path.insert(0, repo) with test/ lacking __init__.py: `from test import helpers` -> ImportError (stdlib `test` wins).
  // The import must not carry the folder, or `helpers.h()` would resolve into it.
  it('from test import x with a namespace test folder proves nothing about x', async () => {
    const files = await link({ 'main.py': 'from test import helpers\n\n\ndef run():\n    return helpers.h()\n', 'test/helpers.py': 'def h():\n    pass\n' });
    expect(outcome(files, 'main.py')).toEqual([['test', 'unknown', undefined]]);
    expect(files.get('main.py')!.imports[0]).not.toHaveProperty('packageFolder');
    expect(callsOf(files, 'main.py')).toEqual([['h', 'name-only', undefined]]);
  });

  // A sys.path edit makes every absolute non-stdlib import unknown (`test` is not in sys.stdlib_module_names), and the
  // narrowed guard must not turn this one external.
  it('a file that edits sys.path still makes import test unknown', async () => {
    const files = await link({ 'main.py': 'import sys\nsys.path.insert(0, "x")\nimport test\n' });
    expect(outcome(files, 'main.py')).toEqual([
      ['sys', 'external', undefined],
      ['test', 'unknown', undefined],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * Gate 2 scenarios for folders named like a standard-library package. CPython installs the regular package `test`
 * (Lib/test/__init__.py) although `sys.stdlib_module_names` does not list it; each case quotes a `python3 -I` (3.14) run.
 */

async function link(tree: Record<string, string>): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const outcome = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.imports.map((i) => [i.spec, i.status, i.resolved]);

describe('folders named like a standard-library package', () => {
  // sys.path.insert(0, repo): `import main` (`from test.helpers import h`, test/ has no __init__.py) ->
  // ModuleNotFoundError: No module named 'test.helpers' (the stdlib regular package `test` wins over the namespace folder).
  it('an absolute import into a namespace folder named test is not the repo folder', async () => {
    const files = await link({
      'main.py': 'from test.helpers import h\n',
      'test/helpers.py': 'def h():\n    pass\n',
    });
    expect(outcome(files, 'main.py').map(([spec, status]) => [spec, status === 'resolved' ? 'resolved' : 'not resolved'])).toEqual([['test.helpers', 'not resolved']]);
  });

  // sys.path.insert(0, repo): `import test.test_a; test.test_a.h()` -> 'repo regular' (a regular package on an entry
  // before the stdlib wins), so the relative import has its one target whenever it runs.
  it('a relative import inside a regular repo package named test resolves', async () => {
    const files = await link({
      'test/__init__.py': '',
      'test/helpers.py': 'def h():\n    pass\n',
      'test/test_a.py': 'from .helpers import h\n',
    });
    expect(outcome(files, 'test/test_a.py')).toEqual([['.helpers', 'resolved', 'test/helpers.py']]);
  });

  // sys.path.insert(0, repo): `import email.m` -> ModuleNotFoundError: No module named 'email.m' (stdlib email wins).
  it('a relative import inside a namespace folder named like a listed stdlib package is unknown', async () => {
    const files = await link({
      'email/h.py': 'x = 1\n',
      'email/m.py': 'from .h import x\n',
    });
    expect(outcome(files, 'email/m.py')).toEqual([['.h', 'unknown', undefined]]);
  });
});

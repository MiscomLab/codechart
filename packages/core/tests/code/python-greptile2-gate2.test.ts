import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * Gate 2 scenarios for the relative-import rewrite (Greptile's second review of PR #94): a relative import only runs when
 * the importing file is imported under its package name, so a package chain the import system finds elsewhere proves
 * nothing. Each case quotes a `python3 -I` (3.14) run.
 */

async function link(tree: Record<string, string>): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const outcome = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.imports.map((i) => [i.spec, i.status, i.resolved]);

describe('the file must run under the package its folder names', () => {
  // sys.path [src, .] and [., src]: `import tools.x.main` -> ModuleNotFoundError: No module named 'tools.x'
  // (the regular package src/tools wins over the namespace folder tools/).
  it('a regular package of the same name on another root shadows the file’s namespace folder', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'src/tools/__init__.py': '',
      'tools/x/__init__.py': '',
      'tools/x/helper.py': 'h = 1\n',
      'tools/x/main.py': 'from .helper import h\n',
    });
    expect(outcome(files, 'tools/x/main.py')).toEqual([['.helper', 'unknown', undefined]]);
  });

  // sys.path [.]: `import a.b.main` -> ModuleNotFoundError: 'a.b' is not a package (the module a/b.py beats the folder a/b/).
  it('a module of the same name as the file’s folder means the folder is not a package', async () => {
    const files = await link({
      'a/__init__.py': '',
      'a/b.py': 'x = 1\n',
      'a/b/h.py': 'x = 2\n',
      'a/b/main.py': 'from .h import x\n',
    });
    expect(outcome(files, 'a/b/main.py')).toEqual([['.h', 'unknown', undefined]]);
  });

  // Same layout: a/b/main.py never runs as a.b.main, so `from ..c import y` proves nothing even though a/c.py exists.
  it('two dots from a folder shadowed by a module of its name are not proven', async () => {
    const files = await link({
      'a/__init__.py': '',
      'a/b.py': 'x = 1\n',
      'a/c.py': 'y = 1\n',
      'a/b/main.py': 'from ..c import y\n',
    });
    expect(outcome(files, 'a/b/main.py')).toEqual([['..c', 'unknown', undefined]]);
  });

  // sys.path [src, .] and [., src]: `import tools.x.main` -> ModuleNotFoundError: No module named 'tools.x.main'
  // (tools is src/tools, so tools.x is only the namespace portion src/tools/x, which has no main).
  it('a namespace subfolder under a regular package elsewhere does not include the file’s folder', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'src/tools/__init__.py': '',
      'src/tools/x/helper.py': 'h = 1\n',
      'tools/x/helper.py': 'h = 2\n',
      'tools/x/main.py': 'from .helper import h\n',
    });
    expect(outcome(files, 'tools/x/main.py')).toEqual([['.helper', 'unknown', undefined]]);
  });

  // sys.path ['.', stdlib…]: `import test` is the stdlib regular package (Lib/test/__init__.py); `import test.test_a` ->
  // ModuleNotFoundError: No module named 'test.test_a'. A namespace folder named like a stdlib package never runs as one.
  // (`test` is installed with CPython but missing from sys.stdlib_module_names.)
  it('a namespace folder named like a stdlib package does not run under that name', async () => {
    const files = await link({
      'test/helpers.py': 'def h():\n    pass\n',
      'test/test_a.py': 'from .helpers import h\n',
    });
    expect(outcome(files, 'test/test_a.py')).toEqual([['.helpers', 'unknown', undefined]]);
  });
});

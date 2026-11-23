import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * Gate 2 (second run) scenarios for COD-44. Expected values come from real `python3 -I` runs (3.14), quoted per case.
 */

async function link(tree: Record<string, string>): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const outcome = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.imports.map((i) => [i.spec, i.status, i.resolved]);
const callTo = (files: Map<string, ParsedFile>, path: string, name: string) => {
  const call = files.get(path)!.calls.find((c) => c.name === name)!;
  return [call.evidence, call.to];
};
const NOT_PROVEN = ['name-only', undefined];

describe('a src layout does not put the project root on the package’s sys.path', () => {
  // Installed (sys.path [src, site]): `import shop.app; shop.app.run()` -> 'site-packages tasks'.
  // Run by pytest from the root (sys.path [root, src, site]) -> 'repo-root tasks.py'. Not provable either way.
  it('a module under src/ importing a name that only exists at the project root is not resolved', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "shop"\n',
      'src/shop/__init__.py': '',
      'src/shop/app.py': 'import tasks\n\n\ndef run():\n    return tasks.go()\n',
      'tasks.py': 'def go():\n    pass\n',
    });
    expect(outcome(files, 'src/shop/app.py')).toEqual([['tasks', 'unknown', undefined]]);
    expect(callTo(files, 'src/shop/app.py', 'go')).toEqual(NOT_PROVEN);
  });
});

describe('import_module calls whose target is not provable state no import (mutation survivors)', () => {
  const TREE = { 'a/__init__.py': '', 'a/b/__init__.py': '', 'a/x.py': 'def f():\n    pass\n', 'a/b/x.py': 'def f():\n    pass\n' };

  // importlib.import_module('...x', 'a.b') -> ImportError: attempted relative import beyond top-level package.
  it('a relative name above its anchor package', async () => {
    const files = await link({ ...TREE, 'a/b/m.py': 'import importlib\n\nm = importlib.import_module("...x", "a.b")\n' });
    expect(outcome(files, 'a/b/m.py')).toEqual([['importlib', 'external', undefined]]);
  });

  // importlib.import_module('.x') -> TypeError: the 'package' argument is required to perform a relative import for '.x'.
  it('a relative name with no package argument', async () => {
    const files = await link({ ...TREE, 'a/b/m.py': 'import importlib\n\nm = importlib.import_module(".x")\n' });
    expect(outcome(files, 'a/b/m.py')).toEqual([['importlib', 'external', undefined]]);
  });

  // `__package__` is None or '' when the file runs as __main__, so the anchor is not a literal fact.
  it('a relative name anchored at a non-literal package', async () => {
    const files = await link({ ...TREE, 'a/b/m.py': 'import importlib\n\nm = importlib.import_module(".x", __package__)\n' });
    expect(outcome(files, 'a/b/m.py')).toEqual([['importlib', 'external', undefined]]);
  });

  // importlib.import_module('..x', 'a.b') -> a.x.
  it('two dots climb one package from the anchor', async () => {
    const files = await link({ ...TREE, 'a/b/m.py': 'import importlib\n\nm = importlib.import_module("..x", "a.b")\n\n\ndef run():\n    return m.f()\n' });
    expect(outcome(files, 'a/b/m.py')).toEqual([['importlib', 'external', undefined], ['..x', 'resolved', 'a/x.py']]);
    expect(callTo(files, 'a/b/m.py', 'f')).toEqual(['resolved', 'a/x.py::f::function']);
  });
});

describe('a Python import hidden by a syntax error (mutation survivor)', () => {
  // Live map #11: nothing new comes from broken text; the last good import stands in while its line is broken.
  it('keeps the last good import while its statement is broken', async () => {
    const good = (await parseCode('m.py', 'from os import path\n\n\ndef run():\n    return path\n'))!;
    const broken = (await parseCode('m.py', 'from os import path, (\n\n\ndef run():\n    return path\n', good))!;
    expect(broken.parseErrors.length).toBeGreaterThan(0);
    expect(broken.imports.map((i) => [i.spec, i.names])).toEqual([['os', [{ imported: 'path', local: 'path' }]]]);
  });
});

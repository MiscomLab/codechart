import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCodeIndex, type CodeIndex } from '../../src/code/code-index.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * Gate 1 scenarios for COD-44. Each expected value comes from Python's documented import and scoping rules, checked
 * with a real `python3 -I` run (3.14) where the rule is not obvious; the run is quoted next to the case.
 */

async function link(tree: Record<string, string>): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const outcome = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.imports.map((i) => [i.spec, i.status, i.resolved]);
const calls = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.calls.map((c) => [c.name, c.evidence, c.to]);

describe('module lookup: no target Python itself cannot import', () => {
  // python3: `import pkg.a` (pkg/a.py: `import b`) -> ModuleNotFoundError: No module named 'b' (PEP 328, no implicit relative imports).
  it('a bare import inside a package does not find a sibling module', async () => {
    const files = await link({
      'pkg/__init__.py': '',
      'pkg/a.py': 'import b\n\n\ndef run():\n    b.f()\n',
      'pkg/b.py': 'def f():\n    pass\n',
      'pkg/sub/__init__.py': '',
      'pkg/sub/c.py': 'import b\n',
    });
    expect(outcome(files, 'pkg/a.py')).toEqual([['b', 'unknown', undefined]]);
    expect(outcome(files, 'pkg/sub/c.py')).toEqual([['b', 'unknown', undefined]]);
    expect(calls(files, 'pkg/a.py')).toEqual([['f', 'name-only', undefined]]);
  });

  // python3 main.py (`from .mod import f`) -> ImportError: attempted relative import with no known parent package.
  it('a relative import in a top-level script has no package to be relative to', async () => {
    const files = await link({ 'main.py': 'from .mod import f\n', 'mod.py': 'def f():\n    pass\n' });
    expect(outcome(files, 'main.py')).toEqual([['.mod', 'unknown', undefined]]);
  });

  // python3 with src on sys.path, `import shop.app` -> ImportError: attempted relative import beyond top-level package.
  it('a relative import above the top-level package of a src layout is unknown', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "shop"\n',
      'src/shop/__init__.py': '',
      'src/shop/app.py': 'from ..other.policies import allow\n\n\ndef run():\n    allow()\n',
      'src/other/policies.py': 'def allow():\n    pass\n',
    });
    expect(outcome(files, 'src/shop/app.py')).toEqual([['..other.policies', 'unknown', undefined]]);
    expect(calls(files, 'src/shop/app.py')).toEqual([['allow', 'name-only', undefined]]);
  });

  // PEP 420: a regular package anywhere on the path beats a namespace portion. python3 loads src/shop/billing.py over
  // root/shop/billing.py (root/shop has no __init__.py) with sys.path ['.', 'src'] and ['src', '.'] alike.
  it('a regular package on one source root beats a namespace folder of the same name on another', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "shop"\n',
      'src/shop/__init__.py': '',
      'src/shop/billing.py': 'def charge():\n    pass\n',
      'shop/billing.py': 'def charge():\n    pass\n',
      'tools/script.py': 'from shop.billing import charge\n',
    });
    expect(outcome(files, 'tools/script.py')).toEqual([['shop.billing', 'resolved', 'src/shop/billing.py']]);
  });

  // `tomllib` is in sys.stdlib_module_names (3.11+); `test` is not (the docs: test modules are excluded), and
  // `python3 -s -E -c 'import test.helpers'` in a repo with test/__init__.py loads test/helpers.py.
  it('reads the standard library as Python lists it', async () => {
    const files = await link({
      'main.py': 'import tomllib\nfrom test.helpers import h\n',
      'test/__init__.py': '',
      'test/helpers.py': 'def h():\n    pass\n',
    });
    expect(outcome(files, 'main.py')).toEqual([
      ['tomllib', 'external', undefined],
      ['test.helpers', 'resolved', 'test/helpers.py'],
    ]);
  });
});

describe('bindings follow Python scoping', () => {
  // python3: `class C: from other import f; def m(self): return f()` -> NameError: name 'f' is not defined.
  it('an import in a class body does not bind the name in its methods', async () => {
    const files = await link({
      'other.py': 'def f():\n    pass\n',
      'main.py': 'class C:\n    from other import f\n\n    def m(self):\n        f()\n',
    });
    expect(calls(files, 'main.py')).toEqual([['f', 'name-only', undefined]]);
  });

  // python3: `def run(f): return f()` called with a lambda returns the lambda's value, not m.f's.
  it('a parameter or local assignment shadows an imported name', async () => {
    const files = await link({
      'm.py': 'def f():\n    pass\n',
      'main.py': 'import m\nfrom m import f\n\n\ndef by_param(f):\n    f()\n\n\ndef by_local(g):\n    f = g\n    f()\n\n\ndef by_module_param(m):\n    m.f()\n',
    });
    expect(calls(files, 'main.py')).toEqual([
      ['f', 'name-only', undefined],
      ['f', 'name-only', undefined],
      ['f', 'name-only', undefined],
    ]);
  });

  it('a module-level reassignment after the import leaves the name unproven', async () => {
    const files = await link({
      'm.py': 'def f():\n    pass\n',
      'main.py': 'from m import f\n\nf = print\n\n\ndef run():\n    f()\n',
    });
    expect(calls(files, 'main.py')).toEqual([['f', 'name-only', undefined]]);
  });

  // python3: the fallback runs (prints "slow") without fast.py and prints "fast" with it: the target depends on the environment.
  it('a try/except ImportError fallback is a runtime import, and the call it binds is not proven', async () => {
    const files = await link({
      'fast.py': 'def f():\n    pass\n',
      'slow.py': 'def f():\n    pass\n',
      'main.py': 'try:\n    from fast import f\nexcept ImportError:\n    from slow import f\n\n\ndef run():\n    f()\n',
    });
    expect(calls(files, 'main.py')).toEqual([['f', 'name-only', undefined]]);
    expect(files.get('main.py')!.imports.map((i) => [i.spec, i.typeOnly ?? false])).toEqual([
      ['fast', false],
      ['slow', false],
    ]);
  });

  // typing docs: TYPE_CHECKING is False at run time; python3 runs the `if not TYPE_CHECKING:` body.
  it('the body of if not TYPE_CHECKING runs', async () => {
    const files = await link({
      'm.py': 'def f():\n    pass\n',
      'main.py': 'from typing import TYPE_CHECKING\n\nif not TYPE_CHECKING:\n    from m import f\n\n\ndef run():\n    f()\n',
    });
    expect(files.get('main.py')!.imports.map((i) => [i.spec, i.typeOnly ?? false])).toEqual([
      ['typing', false],
      ['m', false],
    ]);
    expect(calls(files, 'main.py')).toEqual([['f', 'resolved', 'm.py::f::function']]);
  });

  it('a function defined in both branches of an if is not proven', async () => {
    const files = await link({
      'm.py': 'import sys\n\nif sys.platform == "win32":\n    def a():\n        pass\nelse:\n    def a():\n        pass\n',
      'main.py': 'from m import a\n\n\ndef run():\n    a()\n',
    });
    expect(calls(files, 'main.py')).toEqual([['a', 'name-only', undefined]]);
  });

  it('exports definitions inside module-level with, for and else blocks', async () => {
    const files = await link({
      'm.py': 'import contextlib\n\nwith contextlib.suppress(Exception):\n    def c():\n        pass\nfor _ in range(1):\n    def d():\n        pass\ntry:\n    pass\nexcept ImportError:\n    pass\nelse:\n    def e():\n        pass\n',
      'main.py': 'from m import c, d, e\n\n\ndef run():\n    c()\n    d()\n    e()\n',
    });
    expect(calls(files, 'main.py')).toEqual([
      ['c', 'resolved', 'm.py::c::function'],
      ['d', 'resolved', 'm.py::d::function'],
      ['e', 'resolved', 'm.py::e::function'],
    ]);
  });

  // python3: pkg/__init__.py defines `def mod`, pkg/mod.py exists; `from pkg import mod` binds the function ("function init-fn").
  it('from pkg import name prefers the package attribute over a submodule of the same name', async () => {
    const files = await link({
      'pkg/__init__.py': 'def mod():\n    pass\n',
      'pkg/mod.py': 'def f():\n    pass\n',
      'main.py': 'from pkg import mod\n\n\ndef run():\n    mod()\n    mod.f()\n',
    });
    expect(calls(files, 'main.py')).toEqual([
      ['mod', 'resolved', 'pkg/__init__.py::mod::function'],
      ['f', 'name-only', undefined],
    ]);
    expect(files.get('main.py')!.imports[0]!.names!.find((n) => n.local === 'mod')).toEqual({ imported: 'mod', local: 'mod', definedIn: 'pkg/__init__.py' });
  });
});

describe('dynamic imports', () => {
  // python3: importlib.import_module(b'json') and __import__(b'json') raise TypeError; u'json' imports json.
  it('a bytes literal names no module; a u-prefixed one does', async () => {
    const files = await link({ 'a.py': "import importlib\n\nm = importlib.import_module(b'pkg')\nn = __import__(b'pkg')\no = importlib.import_module(u'pkg')\n" });
    expect(files.get('a.py')!.imports.filter((i) => i.kind === 'dynamic').map((i) => i.spec)).toEqual(['pkg']);
  });

  // Python docs for __import__: for 'package.module' the top-level package is returned. python3: __import__('pkg.mod').__name__ == 'pkg'.
  it('__import__ of a dotted name binds the top-level package, not the submodule', async () => {
    const files = await link({
      'pkg/__init__.py': '',
      'pkg/mod.py': 'def f():\n    pass\n',
      'main.py': "m = __import__('pkg.mod')\n\n\ndef run():\n    m.f()\n",
    });
    expect(calls(files, 'main.py').filter(([name]) => name === 'f')).toEqual([['f', 'name-only', undefined]]);
  });
});

describe('constructed receivers', () => {
  it('a for loop that rebinds the receiver leaves it unproven', async () => {
    const files = await link({
      'a.py': 'class A:\n    def charge(self):\n        pass\n',
      'main.py': 'from a import A\n\n\ndef run(items):\n    service = A()\n    for service in items:\n        service.charge()\n',
    });
    expect(calls(files, 'main.py')).toEqual([
      ['A', 'resolved', 'a.py::A::class'],
      ['charge', 'name-only', undefined],
    ]);
  });
});

describe('incremental updates on the py-src fixture', () => {
  const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'code', 'py-src');
  let repo: string;
  let index: CodeIndex;
  const write = (path: string, text: string) => {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  /** The import's status and target, and where the name `local` it binds is defined. */
  const importOutcome = (path: string, spec: string, local: string) => {
    const imp = index.file(path)?.imports.find((i) => i.spec === spec);
    return imp ? [imp.status, imp.resolved, imp.names?.find((n) => n.local === local)?.definedIn] : undefined;
  };

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'codechart-py-gate-'));
    cpSync(FIXTURE, repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    index = await openCodeIndex(repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('turns a regular package back into a namespace one when its __init__.py is removed', async () => {
    write('nspkg/__init__.py', 'from .common import log\n');
    await index.update(['nspkg/__init__.py']);
    unlinkSync(join(repo, 'nspkg/__init__.py'));
    const update = await index.update(['nspkg/__init__.py']);
    expect(update.removed).toEqual(['nspkg/__init__.py']);
    expect(update.relinked).toContain('nspkg/consumer.py');
    expect(importOutcome('nspkg/consumer.py', 'nspkg', 'plugin')).toEqual(['unknown', undefined, 'nspkg/plugin.py']);
  });

  it('a second module on another source root makes an absolute import ambiguous', async () => {
    expect(importOutcome('tools/script.py', 'shop.billing', 'charge')).toEqual(['resolved', 'src/shop/billing.py', 'src/shop/billing.py']);
    // The repo root and src/ are both source roots, each with a regular `shop` package: python3 loads root/shop/billing.py
    // with sys.path ['.', 'src'] and src/shop/billing.py with ['src', '.'], so the target depends on sys.path order.
    write('shop/__init__.py', '');
    write('shop/billing.py', 'def charge(amount: float) -> str:\n    return ""\n');
    const update = await index.update(['shop/__init__.py', 'shop/billing.py']);
    expect(update.relinked).toContain('tools/script.py');
    expect(importOutcome('tools/script.py', 'shop.billing', 'charge')).toEqual(['unknown', undefined, undefined]);
  });

  it('removing the sys.path edit resolves the file again', async () => {
    write('tools/hack.py', '"""No longer edits sys.path."""\n\nimport sys\n\nfrom shop.billing import charge\n');
    await index.update(['tools/hack.py']);
    expect(index.file('tools/hack.py')?.sysPathEdited ?? false).toBe(false);
    expect(importOutcome('tools/hack.py', 'shop.billing', 'charge')).toEqual(['resolved', 'src/shop/billing.py', 'src/shop/billing.py']);
  });
});

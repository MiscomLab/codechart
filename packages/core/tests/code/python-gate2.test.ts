import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * Gate 2 scenarios for COD-44. Each expected value comes from a real `python3 -I` run (3.14) with the sys.path stated
 * next to the case; where the target depends on how the code is started, the only truthful answer is "not resolved".
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

describe('import targets that depend on how the code is started', () => {
  // sys.path [repo, site] (PEP 420: acme has no __init__.py), `import acme.app.core` -> `tools` is site/tools, not acme/tools.
  // Started from inside acme/ it would be acme/tools, so the target is not provable.
  it('a regular package inside a namespace folder does not put that folder on sys.path', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'acme/app/__init__.py': '',
      'acme/app/core.py': 'from tools import helper\n\n\ndef run():\n    return helper()\n',
      'acme/tools/__init__.py': 'def helper():\n    pass\n',
    });
    expect(outcome(files, 'acme/app/core.py')).toEqual([['tools', 'unknown', undefined]]);
    expect(callTo(files, 'acme/app/core.py', 'helper')).toEqual(NOT_PROVEN);
  });

  // importlib.import_module('.billing', 'q') from shop/loader.py -> q/billing.py (the anchor is the second argument).
  it('import_module with an explicit package is relative to that package, not to the calling file', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'shop/__init__.py': '',
      'shop/billing.py': 'def f():\n    pass\n',
      'q/__init__.py': '',
      'q/billing.py': 'def f():\n    pass\n',
      'shop/loader.py': 'import importlib\n\nmod = importlib.import_module(".billing", "q")\n\n\ndef run():\n    return mod.f()\n',
    });
    const [, dynamic] = outcome(files, 'shop/loader.py');
    expect([['.billing', 'unknown', undefined], ['.billing', 'resolved', 'q/billing.py']]).toContainEqual(dynamic);
    expect([NOT_PROVEN, ['resolved', 'q/billing.py::f::function']]).toContainEqual(callTo(files, 'shop/loader.py', 'f'));
  });
});

describe('stub files are not what Python imports', () => {
  // sys.path [repo]: `import a` -> a.py (FileFinder has no .pyi loader, so a/ with only __init__.pyi is a namespace portion).
  it('a module beats a folder that only has an __init__.pyi stub', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'a/__init__.pyi': 'def f() -> None: ...\n',
      'a.py': 'def f():\n    pass\n',
      'main.py': 'import a\n',
    });
    expect(outcome(files, 'main.py')).toEqual([['a', 'resolved', 'a.py']]);
  });

  // sys.path [repo]: `import b` with b.pyi and a folder b/ -> namespace package, b.__file__ is None.
  it('a .pyi stub next to a namespace folder is not the module', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'b.pyi': 'def g() -> None: ...\n',
      'b/inner.py': 'x = 1\n',
      'main.py': 'import b\n',
    });
    expect(outcome(files, 'main.py')).toEqual([['b', 'unknown', undefined]]);
  });
});

describe('scopes the call linker must see', () => {
  const M = { 'm.py': 'def f():\n    pass\n', 'b.py': 'def f():\n    pass\n', 'other.py': 'def f():\n    pass\n' };

  // run([lambda: 'comp-var']) -> ['comp-var']: the comprehension variable shadows the import.
  it('a comprehension variable shadows an imported name', async () => {
    const files = await link({ ...M, 'a.py': 'from m import f\n\n\ndef run(fs):\n    return [f() for f in fs]\n' });
    expect(callTo(files, 'a.py', 'f')).toEqual(NOT_PROVEN);
  });

  // run(lambda: 'lambda-arg') -> 'lambda-arg'.
  it('a lambda parameter shadows an imported name', async () => {
    const files = await link({ ...M, 'a.py': 'from m import f\n\n\ndef run(g):\n    return (lambda f: f())(g)\n' });
    expect(callTo(files, 'a.py', 'f')).toEqual(NOT_PROVEN);
  });

  // run(lambda: 'match-capture') -> 'match-capture': `case f:` binds f in run.
  it('a match capture pattern binds the name locally', async () => {
    const files = await link({ ...M, 'a.py': 'from m import f\n\n\ndef run(v):\n    match v:\n        case f:\n            pass\n    return f()\n' });
    expect(callTo(files, 'a.py', 'f')).toEqual(NOT_PROVEN);
  });

  // run() -> 'walrus': a walrus in a module-level comprehension rebinds the module name.
  it('an assignment expression inside a comprehension binds in the enclosing scope', async () => {
    const files = await link({ ...M, 'a.py': 'from m import f\n\n_ = [(f := g) for g in [lambda: "walrus"]]\n\n\ndef run():\n    return f()\n' });
    expect(callTo(files, 'a.py', 'f')).toEqual(NOT_PROVEN);
  });

  // run() -> 'rebound': `nonlocal f` in inner rebinds run's f.
  it('a nonlocal write rebinds the enclosing function name', async () => {
    const files = await link({
      'a.py': 'def run():\n    def f():\n        return "outer.f"\n\n    def inner():\n        nonlocal f\n        f = lambda: "rebound"\n\n    inner()\n    return f()\n',
    });
    expect(callTo(files, 'a.py', 'f')).toEqual(NOT_PROVEN);
  });

  // run() -> 'b.f': the later star import rebinds f.
  it('a star import after an import can rebind its name', async () => {
    const files = await link({ ...M, 'a.py': 'from m import f\nfrom b import *\n\n\ndef run():\n    return f()\n' });
    expect([NOT_PROVEN, ['resolved', 'b.py::f::function']]).toContainEqual(callTo(files, 'a.py', 'f'));
  });

  // `from pkg import f` -> m.f: the function-local `from other import f` binds only inside helper.
  it('a function-local import in a package does not decide what the package exports', async () => {
    const files = await link({
      ...M,
      'pkg/__init__.py': 'def helper():\n    from other import f\n    return f\n\n\nfrom m import f\n',
      'a.py': 'from pkg import f\n\n\ndef run():\n    return f()\n',
    });
    expect([NOT_PROVEN, ['resolved', 'm.py::f::function']]).toContainEqual(callTo(files, 'a.py', 'f'));
  });
});

describe('cases the current tests do not pin (mutation survivors)', () => {
  // sys.path [src]: `import shop.app` -> ImportError: attempted relative import beyond top-level package.
  it('two dots from a top-level package module are beyond the top level even when the target exists', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'src/shop/__init__.py': '',
      'src/shop/x.py': 'def f():\n    pass\n',
      'src/shop/app.py': 'from ..shop.x import f\n',
    });
    expect(outcome(files, 'src/shop/app.py')).toEqual([['..shop.x', 'unknown', undefined]]);
  });

  // sys.path [repo]: `import shop.app` -> ImportError: attempted relative import beyond top-level package.
  it('two dots from a top-level package at the repo root are beyond the top level even when the target exists', async () => {
    const files = await link({
      'shop/__init__.py': '',
      'shop/x.py': 'def f():\n    pass\n',
      'shop/app.py': 'from ..shop.x import f\n',
    });
    expect(outcome(files, 'shop/app.py')).toEqual([['..shop.x', 'unknown', undefined]]);
  });

  // Which branch binds `f` in pkg depends on whether pkg.a imports, so `from pkg import f` has no provable target.
  it('a package that binds a name in two branches does not export a proven target for it', async () => {
    const files = await link({
      'pkg/__init__.py': 'try:\n    from .a import f\nexcept ImportError:\n    from .b import f\n',
      'pkg/a.py': 'def f():\n    pass\n',
      'pkg/b.py': 'def f():\n    pass\n',
      'main.py': 'from pkg import f\n\n\ndef run():\n    return f()\n',
    });
    expect(callTo(files, 'main.py', 'f')).toEqual(NOT_PROVEN);
  });

  // sys.path [tools, src]: `import shop.billing` -> src/shop/billing.py, though tools/shop (no __init__) comes first.
  it('a regular package on a later entry beats a namespace portion on an earlier one', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'tools/shop/billing.py': 'X = 1\n',
      'src/shop/__init__.py': '',
      'src/shop/billing.py': 'X = 2\n',
      'tools/run.py': 'import shop.billing\n',
    });
    expect(outcome(files, 'tools/run.py')).toEqual([['shop.billing', 'resolved', 'src/shop/billing.py']]);
  });

  // sys.path [repo], `import nspkg.x; nspkg.x.main()` -> 'plugin.run'.
  it('from . import mod in a namespace package names the module in its folder', async () => {
    const files = await link({
      'nspkg/plugin.py': 'def run():\n    pass\n',
      'nspkg/x.py': 'from . import plugin\n\n\ndef main():\n    return plugin.run()\n',
    });
    expect(callTo(files, 'nspkg/x.py', 'run')).toEqual(['resolved', 'nspkg/plugin.py::run::function']);
  });

  // sys.path [k6]: `from pkg import billing` -> the function from pkg.alt; the package attribute wins over the submodule.
  it('a package name bound twice is not the submodule of that name', async () => {
    const files = await link({
      'pkg/__init__.py': 'try:\n    from .alt import billing\nexcept ImportError:\n    billing = None\n',
      'pkg/alt.py': 'def billing():\n    pass\n',
      'pkg/billing.py': 'def charge():\n    pass\n',
      'a.py': 'from pkg import billing\n\n\ndef run():\n    return billing.charge()\n',
    });
    expect(callTo(files, 'a.py', 'charge')).toEqual(NOT_PROVEN);
  });

  // sys.path [k7]: `from pkg import billing` -> the function pkg.x exports through `from .x import *`.
  it('a star import in a package can bind the name before the submodule is looked for', async () => {
    const files = await link({
      'pkg/__init__.py': 'from .x import *\n',
      'pkg/x.py': 'def billing():\n    pass\n',
      'pkg/billing.py': 'def charge():\n    pass\n',
      'a.py': 'from pkg import billing\n\n\ndef run():\n    return billing.charge()\n',
    });
    expect(callTo(files, 'a.py', 'charge')).toEqual(NOT_PROVEN);
  });

  // Python: a class body that defines `charge` twice keeps the last one; the linker requires exactly one.
  it('a constructed receiver whose class defines the method twice is not proven', async () => {
    const files = await link({
      'a.py': 'class C:\n    def charge(self):\n        pass\n\n    def charge(self):\n        pass\n\n\ndef run():\n    c = C()\n    return c.charge()\n',
    });
    expect(callTo(files, 'a.py', 'charge')).toEqual(NOT_PROVEN);
  });
});

describe('TypeScript keeps its last-good default export rule', () => {
  // origin/main parse.ts: an export whose name is gone from the text was deleted, and `default` is written `export default`.
  it('a broken file whose text says default only in a switch no longer exports default', async () => {
    const good = (await parseCode('a.ts', 'export function bar() {}\nexport default function main() {}\n'))!;
    const broken = (await parseCode('a.ts', 'export function bar(x: number) {\n  switch (x) {\n    default:\n  }\n}\nconst y = ;\n', good))!;
    expect(broken.parseErrors.length).toBeGreaterThan(0);
    expect(broken.exports.names).toEqual([{ name: 'bar' }]);
  });
});

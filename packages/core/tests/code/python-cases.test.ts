import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/** Parses and links an in-memory repo; files not ending in a code extension are still readable as project files. */
async function link(tree: Record<string, string>): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const call = (files: Map<string, ParsedFile>, path: string, name: string) => files.get(path)!.calls.find((c) => c.name === name)!;
const target = (files: Map<string, ParsedFile>, path: string, name: string) => {
  const c = call(files, path, name);
  return [c.evidence, c.to];
};
const imports = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.imports.map((i) => [i.spec, i.status, i.resolved, i.names]);

describe('Python import statements bind only what Python binds', () => {
  it('from-import binds the imported names, never the module name', async () => {
    const files = await link({ 'a.py': 'from pkg import f\nfrom pkg.sub import g as h\nfrom . import mod\n' });
    expect(files.get('a.py')!.imports.map((i) => [i.spec, i.names])).toEqual([
      ['pkg', [{ imported: 'f', local: 'f' }]],
      ['pkg.sub', [{ imported: 'g', local: 'h' }]],
      ['.', [{ imported: 'mod', local: 'mod' }]],
    ]);
  });

  it('a comma import is one import per module, each with its own target', async () => {
    const files = await link({
      'main.py': 'import alpha, beta\n\n\ndef run():\n    beta.f()\n',
      'alpha.py': 'def f():\n    pass\n',
      'beta.py': 'def f():\n    pass\n',
    });
    expect(imports(files, 'main.py')).toEqual([
      ['alpha', 'resolved', 'alpha.py', [{ imported: '*', local: 'alpha', definedIn: 'alpha.py' }]],
      ['beta', 'resolved', 'beta.py', [{ imported: '*', local: 'beta', definedIn: 'beta.py' }]],
    ]);
    expect(target(files, 'main.py', 'f')).toEqual(['resolved', 'beta.py::f::function']);
  });

  it('reads a raw or byte-prefixed literal module name and skips an f-string', async () => {
    const files = await link({ 'a.py': "import importlib\n\nm = importlib.import_module(r'pkg.mod')\nn = importlib.import_module(f'pkg.{x}')\n" });
    expect(files.get('a.py')!.imports.filter((i) => i.kind === 'dynamic').map((i) => i.spec)).toEqual(['pkg.mod']);
  });
});

describe('Python module lookup follows Python’s import system', () => {
  it('a regular package wins over a module of the same name in one folder', async () => {
    const files = await link({ 'main.py': 'import pkg\n', 'pkg.py': '', 'pkg/__init__.py': '', 'pkg/sub.py': '' });
    expect(imports(files, 'main.py')[0]!.slice(0, 3)).toEqual(['pkg', 'resolved', 'pkg/__init__.py']);
  });

  it('a dotted import whose last part is missing is not resolved to its parent', async () => {
    const files = await link({ 'main.py': 'import a.b\n', 'a.py': 'def f():\n    pass\n' });
    expect(imports(files, 'main.py')[0]!.slice(0, 3)).toEqual(['a.b', 'unknown', undefined]);
  });

  it('a namespace package under src/ still finds the module it holds', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'src/ns/plugin.py': 'def run():\n    pass\n',
      'src/app/__init__.py': '',
      'src/app/main.py': 'from ns import plugin\n\n\ndef go():\n    plugin.run()\n',
    });
    expect(imports(files, 'src/app/main.py')[0]!.slice(0, 3)).toEqual(['ns', 'unknown', undefined]);
    expect(target(files, 'src/app/main.py', 'run')).toEqual(['resolved', 'src/ns/plugin.py::run::function']);
  });
});

describe('Python exports', () => {
  it('follows an aliased re-export in a package to the defining module', async () => {
    const files = await link({
      'pkg/__init__.py': 'from .impl import f as g\n',
      'pkg/impl.py': 'def f():\n    pass\n',
      'main.py': 'from pkg import g\n\n\ndef run():\n    g()\n',
    });
    expect(files.get('main.py')!.imports[0]!.names).toEqual([{ imported: 'g', local: 'g', definedIn: 'pkg/impl.py' }]);
    expect(target(files, 'main.py', 'g')).toEqual(['resolved', 'pkg/impl.py::f::function']);
  });

  it('exports definitions inside module-level if, try, with and for blocks', async () => {
    const files = await link({
      'm.py': 'if True:\n    def a():\n        pass\ntry:\n    def b():\n        pass\nexcept ImportError:\n    pass\n',
      'main.py': 'from m import a, b\n\n\ndef run():\n    a()\n    b()\n',
    });
    expect(target(files, 'main.py', 'a')).toEqual(['resolved', 'm.py::a::function']);
    expect(target(files, 'main.py', 'b')).toEqual(['resolved', 'm.py::b::function']);
  });

  it('__all__ limits star imports, not explicit imports or attribute access', async () => {
    const files = await link({
      'mod.py': "__all__ = ['public']\n\n\ndef public():\n    pass\n\n\ndef helper():\n    pass\n",
      'main.py': 'import mod\nfrom mod import helper\n\n\ndef run():\n    helper()\n    mod.helper()\n',
    });
    expect(files.get('main.py')!.calls.map((c) => [c.name, c.via, c.evidence, c.to])).toEqual([
      ['helper', 'bare', 'resolved', 'mod.py::helper::function'],
      ['helper', 'member', 'resolved', 'mod.py::helper::function'],
    ]);
  });

  it('the else branch of if TYPE_CHECKING runs, so its import is a runtime export', async () => {
    const files = await link({
      'pkg/__init__.py': 'from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from .stub import f\nelse:\n    from .real import f\n',
      'pkg/stub.py': 'def f():\n    pass\n',
      'pkg/real.py': 'def f():\n    pass\n',
      'main.py': 'from pkg import f\n\n\ndef run():\n    f()\n',
    });
    const init = files.get('pkg/__init__.py')!.imports.filter((i) => i.spec !== 'typing');
    expect(init.map((i) => [i.spec, i.typeOnly ?? false])).toEqual([
      ['.stub', true],
      ['.real', false],
    ]);
    expect(target(files, 'main.py', 'f')).toEqual(['resolved', 'pkg/real.py::f::function']);
  });
});

describe('Python calls stay name-only unless the target is proven', () => {
  it('a call to a name imported only under TYPE_CHECKING is name-only', async () => {
    const files = await link({
      'm.py': 'def f():\n    pass\n',
      'main.py': 'from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from m import f\n\n\ndef run():\n    f()\n',
    });
    expect(target(files, 'main.py', 'f')).toEqual(['name-only', undefined]);
  });

  it('self.child.f() is not a call to the enclosing class’s f', async () => {
    const files = await link({ 'a.py': 'class A:\n    def f(self):\n        pass\n\n    def run(self):\n        self.child.f()\n' });
    const c = call(files, 'a.py', 'f');
    expect([c.via, c.evidence, c.to]).toEqual(['member', 'name-only', undefined]);
  });

  it('cls.f() and self.f() still resolve to the class method', async () => {
    const files = await link({ 'a.py': 'class A:\n    def f(self):\n        pass\n\n    def run(self):\n        self.f()\n\n    @classmethod\n    def make(cls):\n        cls.f()\n' });
    expect(files.get('a.py')!.calls.map((c) => [c.via, c.to])).toEqual([
      ['this', 'a.py::A.f::method'],
      ['this', 'a.py::A.f::method'],
    ]);
  });

  it('an import inside one function does not bind a name in another', async () => {
    const files = await link({
      'other.py': 'def f():\n    pass\n',
      'main.py': 'def setup():\n    import other as ns\n    from other import f\n\n\ndef run(ns):\n    ns.f()\n    f()\n',
    });
    expect(files.get('main.py')!.calls.filter((c) => c.from === 'main.py::run::function').map((c) => [c.name, c.evidence])).toEqual([
      ['f', 'name-only'],
      ['f', 'name-only'],
    ]);
  });

  it('an import inside the calling function does bind there', async () => {
    const files = await link({ 'other.py': 'def f():\n    pass\n', 'main.py': 'def run():\n    from other import f\n    f()\n' });
    expect(target(files, 'main.py', 'f')).toEqual(['resolved', 'other.py::f::function']);
  });

  it('an object built in another function is not the receiver', async () => {
    const files = await link({
      'a.py': 'class A:\n    def charge(self):\n        pass\n',
      'main.py': 'from a import A\n\n\ndef other():\n    service = A()\n\n\ndef run(service):\n    service.charge()\n',
    });
    expect(target(files, 'main.py', 'charge')).toEqual(['name-only', undefined]);
  });

  it('a receiver reassigned after construction is not proven', async () => {
    const files = await link({
      'a.py': 'class A:\n    def charge(self):\n        pass\n',
      'main.py': 'from a import A\n\n\ndef run(other):\n    service = A()\n    service = other\n    service.charge()\n',
    });
    expect(target(files, 'main.py', 'charge')).toEqual(['name-only', undefined]);
  });

  it('an object constructed in a method resolves its method call', async () => {
    const files = await link({
      'a.py': 'class A:\n    def charge(self):\n        pass\n',
      'main.py': 'from a import A\n\n\nclass C:\n    def m(self):\n        service = A()\n        service.charge()\n',
    });
    expect(target(files, 'main.py', 'charge')).toEqual(['resolved', 'a.py::A.charge::method']);
  });

  it('an object constructed in the calling function resolves its method call', async () => {
    const files = await link({
      'a.py': 'class A:\n    def charge(self):\n        pass\n',
      'main.py': 'from a import A\n\n\ndef run():\n    service = A()\n    service.charge()\n',
    });
    expect(target(files, 'main.py', 'charge')).toEqual(['resolved', 'a.py::A.charge::method']);
  });
});

describe('sys.path edits', () => {
  it.each([
    ['print(sys.path)', false],
    ['for p in sys.path:\n    print(p)', false],
    ['sys.path.insert(0, "x")', true],
    ['sys.path.append("x")', true],
    ['sys.path.extend(["x"])', true],
    ['sys.path = ["x"]', true],
    ['sys.path[0:0] = ["x"]', true],
    ['sys.path += ["x"]', true],
  ])('%s edits sys.path: %s', async (line, edits) => {
    const parsed = await parseCode('a.py', `import sys\n${line}\n`);
    expect(parsed!.sysPathEdited ?? false).toBe(edits);
  });
});

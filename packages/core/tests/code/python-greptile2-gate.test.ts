import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeIndex, type CodeIndex } from '../../src/code/code-index.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/**
 * Gate 1 scenarios for Greptile's second review of PR #94. Incremental cases use a fresh index over the same files as the
 * oracle (an update must end where a full parse starts); resolution cases quote a `python3 -I` (3.14) run.
 */

async function link(tree: Record<string, string>): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const outcome = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.imports.map((i) => [i.spec, i.status, i.resolved]);
const callsOf = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.calls.map((c) => [c.name, c.evidence, c.to]);

describe('incremental: what a namespace folder or package holds decides a name, so changes to it relink', () => {
  let repo: string | undefined;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo!, path)), { recursive: true });
    writeFileSync(join(repo!, path), text);
  };
  async function start(files: Record<string, string>): Promise<CodeIndex> {
    repo = mkdtempSync(join(tmpdir(), 'codechart-g2gate-'));
    for (const [path, text] of Object.entries(files)) write(path, text);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    return openCodeIndex(repo);
  }
  async function expectFresh(index: CodeIndex, path: string) {
    const fresh = await openCodeIndex(repo!);
    expect(index.file(path)!.imports).toEqual(fresh.file(path)!.imports);
    expect(index.file(path)!.calls).toEqual(fresh.file(path)!.calls);
  }
  const MAIN = 'from ns import plugin as p\n\n\ndef go():\n    return p.run()\n';
  const RUN = 'def run():\n    pass\n';

  it('a submodule that appears in the namespace folder is what the name binds', async () => {
    const index = await start({ 'pyproject.toml': '[project]\nname = "x"\n', 'src/ns/other.py': RUN, 'tools/main.py': MAIN });
    write('src/ns/plugin.py', RUN);
    await index.update(['src/ns/plugin.py']);
    await expectFresh(index, 'tools/main.py');
  });

  // CPython FileFinder: a package folder beats a module of the same name in one directory.
  it('a package that appears next to the submodule replaces it', async () => {
    const index = await start({ 'pyproject.toml': '[project]\nname = "x"\n', 'src/ns/plugin.py': RUN, 'tools/main.py': MAIN });
    write('src/ns/plugin/__init__.py', RUN);
    await index.update(['src/ns/plugin/__init__.py']);
    await expectFresh(index, 'tools/main.py');
  });

  it('the namespace folder moving to another source root moves the name', async () => {
    const index = await start({ 'pyproject.toml': '[project]\nname = "x"\n', 'src/ns/plugin.py': RUN, 'src/keep/k.py': RUN, 'tools/main.py': MAIN });
    unlinkSync(join(repo!, 'src/ns/plugin.py'));
    write('ns/plugin.py', RUN);
    await index.update(['src/ns/plugin.py', 'ns/plugin.py']);
    await expectFresh(index, 'tools/main.py');
  });

  it('the namespace folder disappearing drops the call target', async () => {
    const index = await start({ 'pyproject.toml': '[project]\nname = "x"\n', 'src/ns/plugin.py': RUN, 'src/keep/k.py': RUN, 'tools/main.py': MAIN });
    unlinkSync(join(repo!, 'src/ns/plugin.py'));
    await index.update(['src/ns/plugin.py']);
    await expectFresh(index, 'tools/main.py');
  });

  // The reverse of Greptile's case: with one portion left, `plugin` is src/ns/plugin.py again (python3, sys.path [src, .]).
  it('the second namespace portion disappearing proves the name again', async () => {
    const index = await start({ 'pyproject.toml': '[project]\nname = "x"\n', 'src/ns/plugin.py': RUN, 'ns/other.py': RUN, 'tools/main.py': MAIN });
    expect(index.file('tools/main.py')!.calls.map((c) => [c.evidence, c.to])).toEqual([['name-only', undefined]]);
    unlinkSync(join(repo!, 'ns/other.py'));
    await index.update(['ns/other.py']);
    expect(index.file('tools/main.py')!.calls.map((c) => [c.evidence, c.to])).toEqual([['resolved', 'src/ns/plugin.py::run::function']]);
    await expectFresh(index, 'tools/main.py');
  });

  it('a submodule that appears in a regular package is what `from pkg import mod` binds', async () => {
    const index = await start({ 'pkg/__init__.py': '', 'main.py': 'from pkg import mod\n\n\ndef go():\n    return mod.run()\n' });
    write('pkg/mod.py', RUN);
    await index.update(['pkg/mod.py']);
    await expectFresh(index, 'main.py');
  });

  it('a subpackage that appears next to a regular package submodule replaces it', async () => {
    const index = await start({ 'pkg/__init__.py': '', 'pkg/mod.py': RUN, 'main.py': 'from pkg import mod\n\n\ndef go():\n    return mod.run()\n' });
    write('pkg/mod/__init__.py', RUN);
    await index.update(['pkg/mod/__init__.py']);
    await expectFresh(index, 'main.py');
  });
});

describe('relative imports through namespace packages', () => {
  // sys.path ['src', '.'] -> src/acme/sibling.py ('src acme'); ['.', 'src'] -> acme/sibling.py ('root acme').
  it('two dots into a namespace package with a portion on each source root is not proven', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'acme/sub/__init__.py': '',
      'acme/sub/main.py': 'from ..sibling import f\nfrom .. import sibling\n\n\ndef run():\n    f()\n    sibling.f()\n',
      'acme/sibling.py': 'def f():\n    pass\n',
      'src/acme/sibling.py': 'def f():\n    pass\n',
      'src/acme/keep.py': '',
    });
    expect(outcome(files, 'acme/sub/main.py').map(([spec, status]) => [spec, status])).toEqual([
      ['..sibling', 'unknown'],
      ['..', 'unknown'],
    ]);
    expect(callsOf(files, 'acme/sub/main.py')).toEqual([
      ['f', 'name-only', undefined],
      ['f', 'name-only', undefined],
    ]);
  });

  // Same layout, one dot from a module of the namespace package: python3 gives 'src' or 'root' by sys.path order.
  it('one dot inside a namespace package with a portion on each source root is not proven', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'nspkg/consumer.py': 'from .common import log\n',
      'nspkg/common.py': 'def log():\n    pass\n',
      'src/nspkg/common.py': 'def log():\n    pass\n',
    });
    expect(outcome(files, 'nspkg/consumer.py')).toEqual([['.common', 'unknown', undefined]]);
  });

  // sys.path ['src'] (installed src layout): `import acme.sub.main` -> acme is a namespace under src, `..sibling` works.
  it('two dots from a regular package in a namespace package under src/ reach the namespace package', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "x"\n',
      'src/acme/sub/__init__.py': '',
      'src/acme/sub/main.py': 'from ..sibling import f\n',
      'src/acme/sibling.py': 'def f():\n    pass\n',
    });
    expect(outcome(files, 'src/acme/sub/main.py')).toEqual([['..sibling', 'resolved', 'src/acme/sibling.py']]);
  });

  // A nested project's own root bounds the dots: lib/acme/sub/main.py `..sibling` is lib/acme/sibling.py.
  it('a nested project counts package levels from its own root', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "outer"\n',
      'lib/pyproject.toml': '[project]\nname = "lib"\n',
      'lib/acme/sub/__init__.py': '',
      'lib/acme/sub/main.py': 'from ..sibling import f\n',
      'lib/acme/sibling.py': 'def f():\n    pass\n',
    });
    expect(outcome(files, 'lib/acme/sub/main.py')).toEqual([['..sibling', 'resolved', 'lib/acme/sibling.py']]);
  });

  // python3, repo on sys.path: `import acme.sub.main` with `from ...x` -> ImportError beyond top-level package.
  it('dots beyond the source root stay unknown', async () => {
    const files = await link({
      'acme/sub/__init__.py': '',
      'acme/sub/main.py': 'from ...x import f\n',
      'x.py': 'def f():\n    pass\n',
    });
    expect(outcome(files, 'acme/sub/main.py')).toEqual([['...x', 'unknown', undefined]]);
  });
});

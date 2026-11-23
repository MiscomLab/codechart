import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeIndex } from '../../src/code/code-index.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/** Greptile's second review of PR #94; each expected value was checked with `python3 -I` (3.14), quoted next to the case. */

async function link(tree: Record<string, string>): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

describe('relative imports through a namespace package', () => {
  // sys.path [repo]: `import acme.sub.main` -> f() == 'sibling'; with acme/ itself on sys.path it raises, so the
  // import has one target whenever it runs.
  it('two dots from a regular package inside a namespace package reach the namespace package', async () => {
    const files = await link({
      'acme/sub/__init__.py': '',
      'acme/sub/main.py': 'from ..sibling import f\n\n\ndef run():\n    return f()\n',
      'acme/sibling.py': 'def f():\n    return "sibling"\n',
    });
    const main = files.get('acme/sub/main.py')!;
    expect(main.imports.map((i) => [i.spec, i.status, i.resolved])).toEqual([['..sibling', 'resolved', 'acme/sibling.py']]);
    expect(main.calls.map((c) => [c.name, c.evidence, c.to])).toEqual([['f', 'resolved', 'acme/sibling.py::f::function']]);
  });
});

describe('incremental update when a second namespace portion appears', () => {
  let repo: string | undefined;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo!, path)), { recursive: true });
    writeFileSync(join(repo!, path), text);
  };

  // sys.path [src, .] -> src/ns/plugin.py; sys.path [., src] -> ns/plugin.py: which module `plugin` is depends on the order.
  it('drops the call target the namespace folder proved, as a fresh index would', async () => {
    repo = mkdtempSync(join(tmpdir(), 'codechart-greptile2-'));
    write('pyproject.toml', '[project]\nname = "x"\n');
    write('src/ns/plugin.py', 'def run():\n    return "src"\n');
    write('tools/main.py', 'from ns import plugin as p\n\n\ndef go():\n    return p.run()\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const index = await openCodeIndex(repo);
    expect(index.file('tools/main.py')!.calls.map((c) => [c.name, c.evidence, c.to])).toEqual([['run', 'resolved', 'src/ns/plugin.py::run::function']]);

    write('ns/plugin.py', 'def other():\n    return "root"\n');
    await index.update(['ns/plugin.py']);
    const fresh = await openCodeIndex(repo);
    const main = index.file('tools/main.py')!;
    expect(main.calls.map((c) => [c.name, c.evidence, c.to])).toEqual([['run', 'name-only', undefined]]);
    expect(main.imports).toEqual(fresh.file('tools/main.py')!.imports);
    expect(main.calls).toEqual(fresh.file('tools/main.py')!.calls);
  });
});

describe("CPython's installed test package", () => {
  // python3 -I: `import test.support` -> .../lib/python3.14/test/support/__init__.py, a package outside the repo.
  it('imports test from outside the repo as external when the repo has no test module or folder', async () => {
    const files = await link({ 'main.py': 'import test\nimport test.support\n' });
    expect(files.get('main.py')!.imports.map((i) => [i.spec, i.status, i.resolved])).toEqual([
      ['test', 'external', undefined],
      ['test.support', 'external', undefined],
    ]);
  });
});

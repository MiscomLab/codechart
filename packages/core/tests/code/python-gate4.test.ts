import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeIndex } from '../../src/code/code-index.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

/** Gate 2 (third run) scenarios for COD-44: what the src-only roots for files under `src/` must keep and change. */

async function link(tree: Record<string, string>): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

const outcome = (files: Map<string, ParsedFile>, path: string) => files.get(path)!.imports.map((i) => [i.spec, i.status, i.resolved]);

let repo: string | undefined;
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

describe('roots for files inside and outside src/', () => {
  // pytest from the root (rootdir insertion) and `python -m tests.test_a`: tests/ files see root packages and src/.
  it('a file outside src/ still finds packages at the project root and under src/', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "shop"\n',
      'src/shop/__init__.py': '',
      'testing/__init__.py': '',
      'testing/helpers.py': 'def h():\n    pass\n',
      'tests/test_a.py': 'import shop\nfrom testing.helpers import h\n',
    });
    expect(outcome(files, 'tests/test_a.py')).toEqual([
      ['shop', 'resolved', 'src/shop/__init__.py'],
      ['testing.helpers', 'resolved', 'testing/helpers.py'],
    ]);
  });

  // A folder whose name only starts with "src" is not the src layout: it is started from the root like any other.
  it('a folder named like src but not src/ keeps the project root', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "shop"\n',
      'src/shop/__init__.py': '',
      'srcgen/run.py': 'import util\n',
      'util.py': 'def u():\n    pass\n',
    });
    expect(outcome(files, 'srcgen/run.py')).toEqual([['util', 'resolved', 'util.py']]);
  });

  // Relative imports under src/ are unaffected by the roots: `from ..policies` in shop.jobs is shop.policies.
  it('relative imports under src/ still resolve inside the package', async () => {
    const files = await link({
      'pyproject.toml': '[project]\nname = "shop"\n',
      'src/shop/__init__.py': '',
      'src/shop/policies.py': 'def allow():\n    pass\n',
      'src/shop/jobs/__init__.py': '',
      'src/shop/jobs/nightly.py': 'from ..policies import allow\nfrom shop.policies import allow as a2\n',
    });
    expect(outcome(files, 'src/shop/jobs/nightly.py')).toEqual([
      ['..policies', 'resolved', 'src/shop/policies.py'],
      ['shop.policies', 'resolved', 'src/shop/policies.py'],
    ]);
  });

  // A nested project's src/ is its own: lib/src files search only lib/src.
  it('a nested project src layout searches only its own src', async () => {
    const files = await link({
      'lib/pyproject.toml': '[project]\nname = "lib"\n',
      'lib/src/libpkg/__init__.py': 'import tasks\nimport libpkg\n',
      'lib/tasks.py': 'x = 1\n',
    });
    expect(outcome(files, 'lib/src/libpkg/__init__.py')).toEqual([
      ['tasks', 'unknown', undefined],
      ['libpkg', 'resolved', 'lib/src/libpkg/__init__.py'],
    ]);
  });

  // Incremental: a src/ file importing a name found nowhere is external; once a root module of that name appears it may be
  // what runs (started from the root), so it turns unknown, never resolved.
  it('a module added at the project root makes a src/ import unknown, not resolved', async () => {
    repo = mkdtempSync(join(tmpdir(), 'codechart-gate4-'));
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(repo!, path)), { recursive: true });
      writeFileSync(join(repo!, path), text);
    };
    write('pyproject.toml', '[project]\nname = "shop"\n');
    write('src/shop/__init__.py', '');
    write('src/shop/app.py', 'import tasks\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const index = await openCodeIndex(repo);
    const status = () => index.file('src/shop/app.py')!.imports.map((i) => [i.spec, i.status, i.resolved]);
    expect(status()).toEqual([['tasks', 'external', undefined]]);
    write('tasks.py', 'def go():\n    pass\n');
    const update = await index.update(['tasks.py']);
    expect(update.relinked).toContain('src/shop/app.py');
    expect(status()).toEqual([['tasks', 'unknown', undefined]]);
  });
});

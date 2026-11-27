import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCodeIndex, type CodeIndex } from '../../src/code/code-index.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'code', 'py-src');
let repo: string;
let index: CodeIndex;

const write = (path: string, text: string) => {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};

const read = (path: string) => readFileSync(join(repo, path), 'utf8');

const importOutcome = (path: string, spec: string) => {
  const imp = index.file(path)?.imports.find((i) => i.spec === spec);
  return imp ? [imp.status, imp.resolved, imp.names?.map((n) => n.definedIn)] : undefined;
};

const callOutcome = (path: string, name: string) => {
  const call = index.file(path)?.calls.find((c) => c.name === name);
  return call ? [call.to, call.evidence] : undefined;
};

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'codechart-py-index-'));
  cpSync(FIXTURE, repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  index = await openCodeIndex(repo);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('openCodeIndex on Python', () => {
  it('starts with the fixture resolved', () => {
    expect(importOutcome('src/shop/app.py', '.billing')).toEqual(['resolved', 'src/shop/billing.py', ['src/shop/billing.py', 'src/shop/billing.py']]);
    expect(callOutcome('src/shop/billing.py', 'pad')).toEqual(['src/shop/utils/text.py::pad::function', 'resolved']);
    expect(importOutcome('tools/script.py', 'shop.billing')).toEqual(['resolved', 'src/shop/billing.py', ['src/shop/billing.py']]);
  });

  it('re-parses one file and relinks only what its edit can reach', async () => {
    const text = read('src/shop/utils/text.py').replace('def pad', 'def pad_text');
    write('src/shop/utils/text.py', text);
    const update = await index.update(['src/shop/utils/text.py']);
    expect(update.parsed).toEqual(['src/shop/utils/text.py']);
    // The utility barrel and the module that used `pad` lose it; the package barrel still exports `slug`.
    expect(update.relinked).toEqual(['src/shop/billing.py', 'src/shop/utils/__init__.py']);
    expect(callOutcome('src/shop/billing.py', 'pad')).toEqual([undefined, 'name-only']);
    expect(callOutcome('src/shop/billing.py', 'slug')).toEqual(['src/shop/utils/text.py::slug::function', 'resolved']);
  });

  it('resolves a module added under a src layout', async () => {
    write('src/shop/tax.py', 'def rate(amount: float) -> float:\n    return amount * 0.2\n');
    await index.update(['src/shop/tax.py']);
    write('src/shop/billing.py', `${read('src/shop/billing.py')}\nfrom .tax import rate\n`);
    const update = await index.update(['src/shop/billing.py']);
    expect(update.parsed).toEqual(['src/shop/billing.py']);
    expect(importOutcome('src/shop/billing.py', '.tax')).toEqual(['resolved', 'src/shop/tax.py', ['src/shop/tax.py']]);
  });

  it('turns a namespace package into a regular one when its __init__.py appears', async () => {
    expect(importOutcome('nspkg/consumer.py', 'nspkg')).toEqual(['unknown', undefined, ['nspkg/plugin.py']]);
    write('nspkg/__init__.py', 'from .common import log\n');
    const update = await index.update(['nspkg/__init__.py']);
    expect(update.parsed).toEqual(['nspkg/__init__.py']);
    // The new package file changes what `nspkg` resolves to, so every importer of it is re-resolved.
    expect(update.relinked).toContain('nspkg/consumer.py');
    // `__init__.py` does not define `plugin`, so `from nspkg import plugin` still binds the submodule.
    expect(importOutcome('nspkg/consumer.py', 'nspkg')).toEqual(['resolved', 'nspkg/__init__.py', ['nspkg/plugin.py']]);
  });

  it('resolves a module that appears under the package', async () => {
    expect(importOutcome('src/shop/billing.py', '.models')).toEqual(['unknown', undefined, [undefined]]);
    write('src/shop/models.py', 'def receipt() -> None:\n    pass\n');
    const update = await index.update(['src/shop/models.py']);
    expect(update.relinked).toContain('src/shop/billing.py');
    expect(importOutcome('src/shop/billing.py', '.models')).toEqual(['resolved', 'src/shop/models.py', [undefined]]);
  });

  it('imports a package found nowhere in the repo as external, and unknown once a module of that name appears', async () => {
    write('src/shop/report.py', 'import rich\n\n\ndef build() -> None:\n    rich.print("x")\n');
    await index.update(['src/shop/report.py']);
    expect(importOutcome('src/shop/report.py', 'rich')).toEqual(['external', undefined, [undefined]]);
    // scripts/rich.py is not on report.py's sys.path, so whether `rich` is site-packages or that file is not provable.
    write('scripts/rich.py', 'def print(x: str) -> None:\n    pass\n');
    const update = await index.update(['scripts/rich.py']);
    expect(update.relinked).toContain('src/shop/report.py');
    expect(importOutcome('src/shop/report.py', 'rich')).toEqual(['unknown', undefined, [undefined]]);
  });

  it('re-resolves when only a project file changes the source roots', async () => {
    write('lib/src/libpkg/__init__.py', 'def x() -> None:\n    pass\n');
    write('lib/tools/use.py', 'from libpkg import x\n');
    await index.update(['lib/src/libpkg/__init__.py', 'lib/tools/use.py']);
    expect(importOutcome('lib/tools/use.py', 'libpkg')).toEqual(['unknown', undefined, [undefined]]);
    // lib/pyproject.toml makes lib/ a project with a src layout, so lib/src is on its files' sys.path.
    write('lib/pyproject.toml', '[project]\nname = "lib"\n');
    const update = await index.update(['lib/pyproject.toml']);
    expect(update.relinked).toContain('lib/tools/use.py');
    expect(importOutcome('lib/tools/use.py', 'libpkg')).toEqual(['resolved', 'lib/src/libpkg/__init__.py', ['lib/src/libpkg/__init__.py']]);
  });

  it('keeps the sys.path edit and its unknown imports across an unrelated edit', async () => {
    write('tools/hack.py', `${read('tools/hack.py')}\n# edited\n`);
    const update = await index.update(['tools/hack.py']);
    expect(update.parsed).toEqual(['tools/hack.py']);
    expect(index.file('tools/hack.py')?.sysPathEdited).toBe(true);
    expect(importOutcome('tools/hack.py', 'shop.billing')).toEqual(['unknown', undefined, [undefined]]);
  });
});

/**
 * COD-59: call resolution reads other files' class indexes (`ClassInfo.writes`, members, bases), not just the
 * resolution surface `affected` compares. A live update must re-resolve those callers, so its resolved calls equal a
 * freshly built index over the same files.
 */
describe('a live index re-resolves the callers a change to another file’s class reaches', () => {
  const K = 'class K:\n    def f(self):\n        return "K"\n\n    def m(self):\n        return self.f()\n';
  const targets = (idx: CodeIndex) => idx.file('k.py')!.calls.filter((c) => c.name === 'f').map((c) => c.to);

  const editedSubclass = async (body: string) => {
    write('k.py', K);
    write('l.py', 'from k import K\n\n\nclass L(K):\n    pass\n');
    await index.update();
    expect(targets(index)).toEqual(['k.py::K.f::method']);
    write('l.py', `from k import K\n\n\nclass L(K):\n${body}`);
    const update = await index.update(['l.py']);
    expect(update.parsed).toEqual(['l.py']);
    const fresh = await openCodeIndex(repo);
    // CPython: L().m() reaches the written attribute, so K.f is never the call's target.
    expect(targets(index), 'live index after the edit').toEqual(targets(fresh));
    expect(targets(index)).toEqual([undefined]);
  };

  it('adding an attr write in another file makes the base method call name-only', async () => {
    await editedSubclass('    def __init__(self):\n        self.f = lambda: 2\n');
  });

  it('adding a subclass override by class attribute makes the base method call name-only', async () => {
    await editedSubclass('    f = lambda self: 2\n');
  });
});

/**
 * COD-59 round 2, L1: `surface()` omits the module `bindings` that cross-file call resolution reads. A live update that
 * changes only how `b.py` binds its top-level `f` must re-resolve the importers of `b`, exactly as a fresh index over
 * the same files does, and the call must be name-only: a decorated name is the decorator's result, and a binding that
 * never ran does not exist.
 */
describe('a live index re-resolves importers when a module binding changes', () => {
  const A_FROM = 'from b import f\n\n\ndef run():\n    return f()\n';
  const A_MODULE = 'import b\n\n\ndef run():\n    return b.f()\n';
  const targets = (idx: CodeIndex) => idx.file('a.py')!.calls.filter((call) => call.name === 'f').map((call) => call.to);

  const editAndCompare = async (aText: string, initialB: string, editedB: string) => {
    write('c.py', 'def deco(fn):\n    return lambda: 3\n');
    write('a.py', aText);
    write('b.py', initialB);
    await index.update();
    expect(targets(index), 'the call starts resolved').toEqual(['b.py::f::function']);
    write('b.py', editedB);
    const update = await index.update(['b.py']);
    expect(update.parsed).toEqual(['b.py']);
    const fresh = await openCodeIndex(repo);
    // CPython 3.14: a decorated `f` is the decorator's return value, and a conditional one never ran, so b.f is not
    // the definition the call reaches; a fresh index says name-only.
    expect(targets(index), 'live index after the edit').toEqual(targets(fresh));
    expect(targets(index)).toEqual([undefined]);
  };

  // `from c import deco` is already in b.py, so adding the decorator changes only how `f` binds: the surface the
  // affected set compares cannot see it, which is the live-index bug.
  const PLAIN = 'from c import deco\n\n\ndef f():\n    return 1\n';
  const DECORATED = 'from c import deco\n\n\n@deco\ndef f():\n    return 1\n';
  const CONDITIONAL = 'if False:\n    def f():\n        return 1\n';

  it('a decorator added to the module function: from-import', async () => {
    await editAndCompare(A_FROM, PLAIN, DECORATED);
  });

  it('a decorator added to the module function: module attribute call', async () => {
    await editAndCompare(A_MODULE, PLAIN, DECORATED);
  });

  it('a conditional module function: module attribute call', async () => {
    await editAndCompare(A_MODULE, 'def f():\n    return 1\n', CONDITIONAL);
  });

  it('a conditional module function: from-import', async () => {
    await editAndCompare(A_FROM, 'def f():\n    return 1\n', CONDITIONAL);
  });
});

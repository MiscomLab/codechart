import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Import } from '../../src/code/model.js';
import type { ParsedFile } from '../../src/code/parse.js';
import { parseCode } from '../../src/code/parse.js';
import { parseRepo } from '../../src/code/repo.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'code', 'py-src');
let repo: string;
let files: ParsedFile[];

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'codechart-py-'));
  cpSync(FIXTURE, repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  files = await parseRepo(repo);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

const fileOf = (path: string): ParsedFile => files.find((f) => f.file.path === path)!;
const outcome = (imp: Import) => [imp.spec, imp.status, imp.resolved];
const importsOf = (path: string) => fileOf(path).imports.map(outcome);
const callOf = (path: string, name: string) => fileOf(path).calls.find((c) => c.name === name);

describe('Python imports on the py-src fixture', () => {
  it('resolves a src layout package, its barrels and relative imports', () => {
    expect(importsOf('src/shop/app.py')).toEqual([
      ['.', 'resolved', 'src/shop/__init__.py'],
      ['.billing', 'resolved', 'src/shop/billing.py'],
      ['.utils', 'resolved', 'src/shop/utils/__init__.py'],
      ['.policies', 'resolved', 'src/shop/policies.py'],
    ]);
  });

  it('resolves a two-dot relative import from a subpackage to the package root', () => {
    expect(importsOf('src/shop/jobs/nightly.py')).toEqual([['..policies', 'resolved', 'src/shop/policies.py']]);
    expect(callOf('src/shop/jobs/nightly.py', 'allow')).toMatchObject({ to: 'src/shop/policies.py::allow::function', evidence: 'resolved' });
  });

  it('reads stdlib, absolute and relative imports, and marks a TYPE_CHECKING import', () => {
    expect(importsOf('src/shop/billing.py')).toEqual([
      ['__future__', 'external', undefined],
      ['os', 'external', undefined],
      ['typing', 'external', undefined],
      ['.utils', 'resolved', 'src/shop/utils/__init__.py'],
      ['.utils.text', 'resolved', 'src/shop/utils/text.py'],
      ['.models', 'unknown', undefined],
    ]);
    expect(fileOf('src/shop/billing.py').imports[5]).toMatchObject({ typeOnly: true, names: [{ imported: 'Receipt', local: 'Receipt' }] });
  });

  it('binds exactly the names each statement binds', () => {
    expect(fileOf('src/shop/billing.py').imports.map((i) => [i.spec, i.names])).toEqual([
      ['__future__', []],
      ['os', [{ imported: '*', local: 'os' }]],
      ['typing', [{ imported: 'TYPE_CHECKING', local: 'TYPE_CHECKING' }]],
      ['.utils', [{ imported: 'slug', local: 'slug', definedIn: 'src/shop/utils/text.py' }]],
      ['.utils.text', [{ imported: 'pad', local: 'pad', definedIn: 'src/shop/utils/text.py' }]],
      ['.models', [{ imported: 'Receipt', local: 'Receipt', typeOnly: true }]],
    ]);
    expect(fileOf('nspkg/consumer.py').imports.map((i) => i.names?.map((n) => n.local))).toEqual([['plugin'], ['log']]);
  });

  it('keeps a namespace package itself unknown but resolves the modules inside it', () => {
    expect(importsOf('nspkg/consumer.py')).toEqual([
      ['nspkg', 'unknown', undefined],
      ['nspkg.common', 'resolved', 'nspkg/common.py'],
    ]);
    // `from nspkg import plugin` names the module the folder holds, even though the package has no file.
    expect(callOf('nspkg/consumer.py', 'run')).toMatchObject({ to: 'nspkg/plugin.py::run::function', evidence: 'resolved' });
  });

  it('makes a file that edits sys.path unknown, and resolves a script outside a package through src', () => {
    expect(importsOf('tools/hack.py')).toEqual([
      ['sys', 'external', undefined],
      ['shop.billing', 'unknown', undefined],
    ]);
    expect(fileOf('tools/hack.py').sysPathEdited).toBe(true);
    expect(importsOf('tools/script.py')).toEqual([
      ['importlib', 'external', undefined],
      ['shop.billing', 'resolved', 'src/shop/billing.py'],
      ['shop.billing', 'resolved', 'src/shop/billing.py'],
    ]);
    expect(fileOf('tools/script.py').sysPathEdited).toBeUndefined();
  });

  it('proves the names an import binds, through a barrel', () => {
    const app = fileOf('src/shop/app.py');
    expect(app.imports.map((i) => i.names?.map((n) => [n.local, n.definedIn]))).toEqual([
      [['billing', 'src/shop/billing.py']],
      [['PaymentService', 'src/shop/billing.py'], ['charge', 'src/shop/billing.py']],
      [['make_slug', 'src/shop/utils/text.py']],
      [['allow', 'src/shop/policies.py']],
    ]);
  });
});

describe('Python calls on the py-src fixture', () => {
  it('resolves a grouped import, a submodule bound by from-import and the method of a constructed class', () => {
    expect(callOf('src/shop/app.py', 'allow')).toMatchObject({ via: 'bare', to: 'src/shop/policies.py::allow::function' });
    expect(callOf('src/shop/app.py', 'make_slug')).toMatchObject({ via: 'bare', to: 'src/shop/utils/text.py::slug::function' });
    expect(callOf('src/shop/app.py', 'PaymentService')).toMatchObject({ via: 'bare', to: 'src/shop/billing.py::PaymentService::class' });
    const method = fileOf('src/shop/app.py').calls.filter((c) => c.from === 'src/shop/app.py::run_service::function').find((c) => c.name === 'charge');
    expect(method).toMatchObject({ via: 'member', receiver: 'service', to: 'src/shop/billing.py::PaymentService.charge::method', evidence: 'resolved' });
    // `from . import billing` binds the module src/shop/billing.py, so `billing.charge()` is its top-level `charge`.
    expect(callOf('src/shop/app.py', 'charge')).toMatchObject({ via: 'member', receiver: 'billing', to: 'src/shop/billing.py::charge::function', evidence: 'resolved' });
  });

  it('resolves a bare call through a barrel and a self call to its method', () => {
    expect(callOf('src/shop/billing.py', 'pad')).toMatchObject({ to: 'src/shop/utils/text.py::pad::function' });
    const refund = fileOf('src/shop/billing.py').calls.filter((c) => c.from === 'src/shop/billing.py::PaymentService.refund::method');
    expect(refund.map((c) => [c.name, c.to])).toEqual([
      ['charge', 'src/shop/billing.py::PaymentService.charge::method'],
      ['_format', 'src/shop/billing.py::PaymentService._format::method'],
    ]);
  });

  it('resolves a class call and the method of a class constructed in the same function', () => {
    const charge = fileOf('src/shop/billing.py').calls.filter((c) => c.from === 'src/shop/billing.py::charge::function');
    expect(charge.map((c) => [c.name, c.to, c.evidence])).toEqual([
      ['PaymentService', 'src/shop/billing.py::PaymentService::class', 'resolved'],
      ['charge', 'src/shop/billing.py::PaymentService.charge::method', 'resolved'],
    ]);
  });

  it('leaves a stdlib call name-only', () => {
    const call = callOf('src/shop/billing.py', 'getcwd');
    expect(call?.evidence).toBe('name-only');
    expect(call).not.toHaveProperty('to');
  });
});

describe('an import whose statement holds a syntax error', () => {
  const specsOf = async (text: string) => ((await parseCode('a.py', text))?.imports ?? []).map((i) => i.spec);

  // tree-sitter puts the ERROR inside the anonymous `not in` node here (checked by dumping the web-tree-sitter tree), so the statement has an error and `m` is hidden.
  it('hides a dynamic import whose arguments hold an ERROR under a `not in` operator', async () => {
    expect(await specsOf('import importlib\ny = importlib.import_module("m", a not 1 in b)\n')).toEqual(['importlib']);
  });

  // Here the MISSING `in` sits inside the anonymous `not in` node.
  it('hides a dynamic import whose arguments hold a MISSING token under a `not in` operator', async () => {
    expect(await specsOf('import importlib\ny = importlib.import_module("m", a is 1 not b)\n')).toEqual(['importlib']);
  });

  it('keeps the dynamic import when the same operators parse cleanly', async () => {
    expect(await specsOf('import importlib\ny = importlib.import_module("m", a not in b)\n')).toEqual(['importlib', 'm']);
  });
});

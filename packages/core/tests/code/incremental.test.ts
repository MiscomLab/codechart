import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCodeIndex, type CodeIndex } from '../../src/code/code-index.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'code', 'ts-calls');
let repo: string;
let index: CodeIndex;

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

const read = (path: string) => readFileSync(join(repo, path), 'utf8');

const callOutcome = (path: string, name: string) => {
  const call = index.file(path)?.calls.find((c) => c.name === name);
  return call ? [call.to, call.evidence] : undefined;
};

const importOutcome = (path: string, spec: string) => {
  const imp = index.file(path)?.imports.find((i) => i.spec === spec);
  return imp ? [imp.status, imp.resolved, imp.names?.map((n) => n.definedIn)] : undefined;
};

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'codechart-index-'));
  cpSync(FIXTURE, repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  index = await openCodeIndex(repo);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('openCodeIndex', () => {
  it('starts with the unresolved call and keeps the control file independent', () => {
    expect(importOutcome('src/main.ts', './missing')).toEqual(['unknown', undefined, [undefined]]);
    expect(callOutcome('src/main.ts', 'helper')).toEqual([undefined, 'name-only']);
    expect(callOutcome('src/control.ts', 'local')).toEqual(['src/control.ts::local::function', 'resolved']);
  });

  it('skips a file whose hash did not change', async () => {
    write('src/main.ts', read('src/main.ts'));
    const update = await index.update(['src/main.ts']);
    expect(update).toEqual({ changed: [], parsed: [], relinked: [], removed: [] });
  });

  it('finds an edit even when no path is passed (bulk mode)', async () => {
    write('src/control.ts', 'export function control(): void {\n  local();\n}\n\nfunction local(): void {}\n// edited\n');
    const update = await index.update();
    expect(update.parsed).toEqual(['src/control.ts']);
    expect(update.relinked).toEqual([]);
  });

  it('accepts an absolute path', async () => {
    write('src/control.ts', 'export function control(): void {}\n');
    const update = await index.update([join(repo, 'src', 'control.ts')]);
    expect(update.parsed).toEqual(['src/control.ts']);
  });

  it('serialises overlapping updates instead of losing one map', async () => {
    const beforeMain = index.file('src/main.ts')!.file.hash;
    const beforeControl = index.file('src/control.ts')!.file.hash;
    write('src/main.ts', `${read('src/main.ts')}// edited\n`);
    write('src/control.ts', 'export function control(): void {\n  local();\n}\n\nfunction local(): void {}\n// edited\n');
    const [first, second] = await Promise.all([index.update(['src/main.ts']), index.update(['src/control.ts'])]);
    expect(first.parsed).toEqual(['src/main.ts']);
    expect(second.parsed).toEqual(['src/control.ts']);
    expect(index.file('src/main.ts')!.file.hash).not.toBe(beforeMain);
    expect(index.file('src/control.ts')!.file.hash).not.toBe(beforeControl);
  });
});

describe('the ripple from adding and removing a file', () => {
  it('turns unknown imports and name-only calls into resolved ones only in affected files', async () => {
    write('src/missing.ts', 'export function helper(): void {}\n');
    const update = await index.update(['src/missing.ts']);
    expect(update.changed).toEqual(['src/missing.ts']);
    expect(update.parsed).toEqual(['src/missing.ts']);
    expect(update.relinked).toEqual(['src/main.ts', 'src/unresolved.ts']);
    expect(update.removed).toEqual([]);
    expect(importOutcome('src/main.ts', './missing')).toEqual(['resolved', 'src/missing.ts', ['src/missing.ts']]);
    expect(callOutcome('src/main.ts', 'helper')).toEqual(['src/missing.ts::helper::function', 'resolved']);
    expect(callOutcome('src/unresolved.ts', 'helper')).toEqual(['src/missing.ts::helper::function', 'resolved']);
    expect(callOutcome('src/control.ts', 'local')).toEqual(['src/control.ts::local::function', 'resolved']);
  });

  it('turns them back to unknown and name-only when the file is deleted', async () => {
    write('src/missing.ts', 'export function helper(): void {}\n');
    await index.update(['src/missing.ts']);
    rmSync(join(repo, 'src', 'missing.ts'));
    const update = await index.update(['src/missing.ts']);
    expect(update.changed).toEqual(['src/missing.ts']);
    expect(update.removed).toEqual(['src/missing.ts']);
    expect(update.relinked).toEqual(['src/main.ts', 'src/unresolved.ts']);
    expect(importOutcome('src/main.ts', './missing')).toEqual(['unknown', undefined, [undefined]]);
    expect(callOutcome('src/main.ts', 'helper')).toEqual([undefined, 'name-only']);
  });

  it('re-resolves an import when a new file shadows the old target', async () => {
    write('src/foo.js', 'export function x() {}\n');
    write('src/shadow.ts', "import { x } from './foo';\nexport function run() { x(); }\n");
    await index.update();
    expect(importOutcome('src/shadow.ts', './foo')).toEqual(['resolved', 'src/foo.js', ['src/foo.js']]);
    write('src/foo.ts', 'export function x(): void {}\n');
    const update = await index.update(['src/foo.ts']);
    expect(update.relinked).toEqual(['src/shadow.ts']);
    expect(importOutcome('src/shadow.ts', './foo')).toEqual(['resolved', 'src/foo.ts', ['src/foo.ts']]);
    expect(callOutcome('src/shadow.ts', 'x')).toEqual(['src/foo.ts::x::function', 'resolved']);
  });
});

describe('a change to a barrel or a target', () => {
  it('does not relink importers when only a function body changes', async () => {
    write('src/service.ts', read('src/service.ts').replace('return amount;', 'return amount + 0;'));
    const update = await index.update(['src/service.ts']);
    expect(update.parsed).toEqual(['src/service.ts']);
    expect(update.relinked).toEqual([]);
    expect(callOutcome('src/main.ts', 'charge')).toEqual(['src/service.ts::charge::function', 'resolved']);
  });

  it('relinks the barrel and its importers when an export is renamed', async () => {
    write('src/service.ts', read('src/service.ts').replace('function charge', 'function bill').replace('charge(1)', 'bill(1)').replace('charge(2)', 'bill(2)'));
    const update = await index.update(['src/service.ts']);
    expect(update.parsed).toEqual(['src/service.ts']);
    expect(update.relinked).toEqual(['src/barrel.ts', 'src/main.ts']);
    expect(importOutcome('src/barrel.ts', './service')).toEqual(['resolved', 'src/service.ts', [undefined]]);
    expect(callOutcome('src/main.ts', 'charge')).toEqual([undefined, 'name-only']);
    expect(callOutcome('src/main.ts', 'settle')).toEqual(['src/service.ts::settle::function', 'resolved']);
    expect(callOutcome('src/control.ts', 'local')).toEqual(['src/control.ts::local::function', 'resolved']);
  });

  it('re-resolves an import when an earlier alias target appears', async () => {
    write('tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@x/*":["./src/preferred/*","./src/fallback/*"]}}}\n');
    write('src/fallback/task.ts', 'export function task(): void {}\n');
    write('src/alias.ts', "import { task } from '@x/task';\nexport function run() { task(); }\n");
    await index.update();
    expect(importOutcome('src/alias.ts', '@x/task')).toEqual(['resolved', 'src/fallback/task.ts', ['src/fallback/task.ts']]);
    write('src/preferred/task.ts', 'export function task(): void {}\n');
    const update = await index.update(['src/preferred/task.ts']);
    expect(update.relinked).toContain('src/alias.ts');
    expect(importOutcome('src/alias.ts', '@x/task')).toEqual(['resolved', 'src/preferred/task.ts', ['src/preferred/task.ts']]);
    expect(callOutcome('src/alias.ts', 'task')).toEqual(['src/preferred/task.ts::task::function', 'resolved']);
  });

  it('re-resolves only imports that checked for an added file, not every alias import', async () => {
    write('tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@x/*":["./src/*"]}}}\n');
    write('src/target.ts', 'export function target(): void {}\n');
    write('src/alias.ts', "import { target } from '@x/target';\nexport function run() { target(); }\n");
    await index.update();
    const before = index.file('src/alias.ts');
    write('src/unrelated.ts', 'export function unrelated(): void {}\n');
    const update = await index.update(['src/unrelated.ts']);
    expect(update.relinked).toEqual([]);
    expect(index.file('src/alias.ts')).toBe(before);
  });

  it('re-resolves imports when pnpm-workspace.yaml changes', async () => {
    write('packages/lib/package.json', '{"name":"@lib","source":"./src/index.ts"}\n');
    write('packages/lib/src/index.ts', 'export function lib(): void {}\n');
    write('src/pnpm-user.ts', "import { lib } from '@lib';\nexport function run() { lib(); }\n");
    await index.update();
    expect(importOutcome('src/pnpm-user.ts', '@lib')).toEqual(['external', undefined, [undefined]]);
    write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    const update = await index.update(['pnpm-workspace.yaml']);
    expect(update.relinked).toEqual(['src/pnpm-user.ts']);
    expect(importOutcome('src/pnpm-user.ts', '@lib')).toEqual(['resolved', 'packages/lib/src/index.ts', ['packages/lib/src/index.ts']]);
    expect(callOutcome('src/pnpm-user.ts', 'lib')).toEqual(['packages/lib/src/index.ts::lib::function', 'resolved']);
  });

  it('re-resolves imports across the repo when a tsconfig path alias changes', async () => {
    write('tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@x/*":["./src/*"]}}}\n');
    write('src/target.ts', 'export function target(): void {}\n');
    write('src/alias.ts', "import { target } from '@x/target';\nexport function run() { target(); }\n");
    await index.update();
    expect(importOutcome('src/alias.ts', '@x/target')).toEqual(['resolved', 'src/target.ts', ['src/target.ts']]);
    write('tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@x/*":["./lib/*"]}}}\n');
    write('lib/target.ts', 'export function target(): void {}\n');
    const update = await index.update(['tsconfig.json', 'lib/target.ts']);
    expect(update.relinked).toContain('src/alias.ts');
    expect(importOutcome('src/alias.ts', '@x/target')).toEqual(['resolved', 'lib/target.ts', ['lib/target.ts']]);
    expect(callOutcome('src/alias.ts', 'target')).toEqual(['lib/target.ts::target::function', 'resolved']);
  });
});

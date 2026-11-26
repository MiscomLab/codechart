import { describe, expect, it } from 'vitest';
import type { CallRef } from '../../src/code/model.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';
import { tsDeclarationAt } from './ts-oracle.js';

/**
 * COD-59 QA gate: lines of the scope builder no other test reaches (surviving mutants), each checked against the
 * TypeScript checker. A write is any assignment target ECMA-262 binds (AssignmentPattern, AssignmentProperty, TS `!`),
 * and the plan makes a written binding prove no target.
 */

type Tree = Record<string, string>;

async function link(tree: Tree): Promise<Map<string, ParsedFile>> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

function callFrom(files: Map<string, ParsedFile>, caller: string): CallRef {
  const calls = files.get('a.ts')!.calls.filter((c) => c.name === 'f' && c.from.startsWith(`a.ts::${caller}::`));
  expect(calls.length).toBe(1);
  return calls[0]!;
}

const ts = (tree: Tree, call: CallRef) => tsDeclarationAt(tree, 'a.ts', call.range.start.line, call.range.start.column, call.name);

describe('gate: writes through every assignment pattern demote the binding', () => {
  it.each([
    ['a non-null assertion', 'f! = null;'],
    ['an assignment property', '({ a: f } = o);'],
    ['a shorthand property with a default', '({ f = 1 } = o);'],
    ['an array element with a default', '[f = 1] = o;'],
  ])('a write through %s leaves the call name-only', async (_form, write) => {
    const tree = { 'a.ts': `export function f() {}\nexport function run(o: any) { ${write} f(); }\n` };
    const call = callFrom(await link(tree), 'run');
    // The checker binds the name to the top-level declaration; the write makes the value at the call another one.
    expect(ts(tree, call)).toMatchObject({ kind: 'FunctionDeclaration', parentKind: 'SourceFile', line: 1 });
    expect(call.evidence).toBe('name-only');
    expect(call).not.toHaveProperty('to');
  });
});

describe('gate: a callback in a catch parameter default gets its own parameter scope', () => {
  it('the callback parameter shadows the top-level function', async () => {
    const tree = { 'a.ts': 'export function f() {}\nexport function run() { try {} catch ({ x = (f) => f() }) {} }\n' };
    const call = callFrom(await link(tree), 'run');
    expect(ts(tree, call)).toMatchObject({ kind: 'Parameter', parentKind: 'ArrowFunction' });
    expect(call.evidence).toBe('name-only');
    expect(call).not.toHaveProperty('to');
  });
});

describe('gate: two same-named locals on one line resolve each to its own', () => {
  it('the column decides between definitions that start on the same line', async () => {
    const tree = { 'a.ts': 'export function run() { const f = () => 1; f(); } export function other() { const f = () => 2; f(); }\n' };
    const files = await link(tree);
    const run = callFrom(files, 'run');
    const other = callFrom(files, 'other');
    expect(ts(tree, run)).toMatchObject({ kind: 'VariableDeclaration', name: 'f' });
    expect(ts(tree, other)).toMatchObject({ kind: 'VariableDeclaration', name: 'f' });
    expect(run).toMatchObject({ to: 'a.ts::run.f::function', evidence: 'resolved' });
    expect(other).toMatchObject({ to: 'a.ts::other.f::function', evidence: 'resolved' });
  });
});

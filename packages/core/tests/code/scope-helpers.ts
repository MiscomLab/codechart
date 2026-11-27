import { expect } from 'vitest';
import type { CallRef } from '../../src/code/model.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';
import { tsDeclarationAt, tsDeclarationOfIdentifier, tsDeclarationsAt, type TsDeclaration } from './ts-oracle.js';

/** Shared harnesses of the COD-59 scope tests: in-memory linking, call lookup and the TS-checker assertions. */

export type Tree = Record<string, string>;
export type LinkedFiles = Map<string, ParsedFile>;

export interface Repo {
  tree: Tree;
  files: Map<string, ParsedFile>;
}

/** Parses and links an in-memory repo, exactly as `calls.test.ts` does. */
export async function link(tree: Tree): Promise<Repo> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return { tree, files: new Map(linked.map((f) => [f.file.path, f])) };
}

/** Parses and links an in-memory repo, keyed by path: the Python and single-language tests' shape. */
export async function linkFiles(tree: Tree): Promise<LinkedFiles> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return new Map(linked.map((f) => [f.file.path, f]));
}

export const fileOf = (repo: Repo, path = 'a.ts'): ParsedFile => repo.files.get(path)!;

export const fileOfFiles = (files: LinkedFiles, path = 'a.py'): ParsedFile => files.get(path)!;

/** The one call named `name`, optionally made from the symbol `caller` (`run`, `run.inner`, `K.m`…). */
export function callOf(repo: Repo, name: string, caller?: string, path = 'a.ts'): CallRef {
  const calls = fileOf(repo, path).calls.filter((c) => c.name === name && (!caller || c.from.startsWith(`${path}::${caller}::`)));
  expect(calls.length, `calls named ${name}${caller ? ` from ${caller}` : ''}`).toBe(1);
  return calls[0]!;
}

export interface TsExpect {
  kind: string;
  parentKind?: string;
  file?: string;
  line?: number;
  name?: string;
}

/** The checker's declaration for the call's callee (aliases followed). */
export const tsOf = (repo: Repo, call: CallRef): TsDeclaration | undefined => {
  const path = call.from.slice(0, call.from.indexOf('::'));
  return tsDeclarationAt(repo.tree, path, call.range.start.line, call.range.start.column, call.name);
};

export function expectTs(actual: TsDeclaration | undefined, expected: TsExpect): TsDeclaration {
  expect(actual).toBeDefined();
  expect(actual).toMatchObject(expected);
  return actual!;
}

/** The call is name-only, and the checker binds its name as the plan says (a parameter, a binding element…). */
export function nameOnly(repo: Repo, name: string, ts: TsExpect, caller?: string, path = 'a.ts'): CallRef {
  const call = callOf(repo, name, caller, path);
  expectTs(tsOf(repo, call), ts);
  expect(call).toMatchObject({ name, evidence: 'name-only' });
  expect(call).not.toHaveProperty('to');
  return call;
}

/** The call resolves to `to`, and the checker's declaration is that symbol's own name. */
export function resolved(repo: Repo, name: string, to: string, ts: TsExpect, caller?: string, path = 'a.ts'): CallRef {
  const call = callOf(repo, name, caller, path);
  const found = expectTs(tsOf(repo, call), ts);
  const target = fileOf(repo, to.slice(0, to.indexOf('::'))).symbols.find((symbol) => symbol.id === to);
  expect(target, `symbol ${to}`).toBeDefined();
  expect(found).toMatchObject({ file: target!.file });
  expect(found.line).toBeGreaterThanOrEqual(target!.range.start.line);
  expect(found.line).toBeLessThanOrEqual(target!.range.end.line);
  expect(call).toMatchObject({ name, to, evidence: 'resolved' });
  return call;
}

/** The compiler line: tsc gives the call exactly ONE declaration (`ts`), and the call resolves to that symbol `to`. */
export async function resolvedOne(tree: Tree, path: string, to: string, ts: TsExpect, caller?: string, name = 'f'): Promise<CallRef> {
  const repo = await link(tree);
  const call = callOf(repo, name, caller, path);
  const declarations = tsDeclarationsAt(tree, path, call.range.start.line, call.range.start.column, name);
  expect(declarations, `tsc declarations of ${name} in ${path}`).toHaveLength(1);
  return resolved(repo, name, to, ts, caller, path);
}

export function unbound(repo: Repo, name: string, caller?: string): CallRef {
  const call = callOf(repo, name, caller);
  expect(tsOf(repo, call)).toBeUndefined();
  expect(call).toMatchObject({ name, evidence: 'name-only' });
  expect(call).not.toHaveProperty('to');
  return call;
}

/** A member call whose receiver a local binding shadows: the checker sees the receiver as that binding. */
export function receiverOnly(repo: Repo, name: string, receiver: string, ts: TsExpect, caller?: string): CallRef {
  const call = callOf(repo, name, caller);
  const path = call.from.slice(0, call.from.indexOf('::'));
  expectTs(tsDeclarationOfIdentifier(repo.tree, path, call.range.start.line, call.range.start.column, receiver), { ...ts, name: receiver });
  expect(call).toMatchObject({ name, via: 'member', receiver, evidence: 'name-only' });
  expect(call).not.toHaveProperty('to');
  return call;
}

/** Every call `name` in the file's source order, as its resolved target or undefined for name-only. */
export const results = (files: LinkedFiles, name: string, path = 'a.py'): (string | undefined)[] =>
  files
    .get(path)!
    .calls.filter((c) => c.name === name)
    .map((c) => c.to);

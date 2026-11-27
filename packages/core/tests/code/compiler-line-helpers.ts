import { expect } from 'vitest';
import type { CallRef } from '../../src/code/model.js';
import { type Repo, type Tree, callOf, fileOf, link } from './scope-helpers.js';
import { tsDeclarationsAt, type TsDeclaration } from './ts-oracle.js';

/**
 * COD-59 compiler line (plan: .openchamber/cod-59-plan-compiler-line.md, gate rounds 1-5). For TypeScript and
 * JavaScript an arrow is right when the TypeScript checker resolves the callee to exactly ONE declaration and that is
 * the target. A rebind the write itself names (a prototype expression or alias, the class's own `this`/`self` writes,
 * a static-side write for a static call, a reassigned binding, a duplicate member, an unknown computed key) keeps the
 * call name-only, even though the checker still reports one declaration there: the rebind, not tsc, is the reason.
 *
 * Oracle: `ts-oracle.ts` (`tsDeclarationsAt` lists EVERY declaration of the callee's symbol). Every case asserts the
 * checker's declaration count and position in the test itself, then core's outcome.
 */

export interface Spec {
  /** The file holding the call (default `a.ts`). */
  file?: string;
  /** The symbol the call is made from, without the file (default `K.m`). */
  caller?: string;
  name?: string;
  /** The symbol id core must name, or that the checker's declaration sits in (`a.ts::K.f::method`). */
  target?: string;
  /** Instead of `target`, the 1-based line of the checker's declaration. */
  declLine?: number;
  /** How many declarations the checker lists for the callee (default 1). */
  declarations?: number;
  /** Instead of `declarations`: exactly these declaration lines in `file`, in tsc's order. */
  declLines?: number[];
}

export type Row = [label: string, tree: (ext: string) => Tree, exts?: readonly string[], spec?: (ext: string) => Spec];

export const ALL = ['ts', 'js', 'mjs'] as const;
export const TS = ['ts'] as const;
export const MODULES = ['ts', 'js'] as const;

export const one = (src: string) => (ext: string) => ({ [`a.${ext}`]: src });
export const G = 'const g = () => 1;\n';
export const K = 'class K {\n  f() {}\n  m() { this.f(); }\n}\n';
export const KX = 'export class K {\n  f() {}\n  m() { this.f(); }\n}\n';
export const KS = 'class K {\n  static f() {}\n  static s() { this.f(); }\n}\n';
export const KSX = 'export class K {\n  static f() {}\n  static s() { this.f(); }\n}\n';
export const IMPORT_K = "import { K } from './a';\n";

/** TS: one declaration (K.f). JS: tsc JS inference counts the write at `line` as a declaration, so it lists K.f (line 3) and the write. */
export const jsWrite =
  (line: number, extra: Spec = {}) =>
  (ext: string): Spec =>
    ext === 'ts' ? extra : { ...extra, declLines: [3, line] };

export const targetOf = (ext: string, spec: Spec): string | undefined => spec.target ?? (spec.declLine === undefined ? `a.${ext}::K.f::method` : undefined);

/** The checker's declarations for the call, asserted against the spec: count, file and the target's range. */
export function checkTsc(repo: Repo, call: CallRef, file: string, spec: Spec, target: string | undefined): TsDeclaration[] {
  const found = tsDeclarationsAt({ ...repo.tree }, file, call.range.start.line, call.range.start.column, call.name);
  expect(found, `tsc sees a call to ${call.name} at ${call.range.start.line}:${call.range.start.column}`).toBeDefined();
  if (spec.declLines) {
    expect(found!.map((d) => `${d.file}:${d.line}`), 'tsc declarations of the callee').toEqual(spec.declLines.map((line) => `${file}:${line}`));
    return found!;
  }
  expect(found!.map((d) => `${d.file}:${d.line}`), 'tsc declarations of the callee').toHaveLength(spec.declarations ?? 1);
  if (found!.length === 0) return found!;
  if (spec.declLine !== undefined) {
    expect(found![0]).toMatchObject({ file, line: spec.declLine });
    return found!;
  }
  const symbol = fileOf(repo, target!.slice(0, target!.indexOf('::'))).symbols.find((s) => s.id === target);
  expect(symbol, `symbol ${target}`).toBeDefined();
  expect(found![0]!.file).toBe(symbol!.file);
  expect(found![0]!.line).toBeGreaterThanOrEqual(symbol!.range.start.line);
  expect(found![0]!.line).toBeLessThanOrEqual(symbol!.range.end.line);
  return found!;
}

/** tsc resolves the callee to exactly one declaration, that declaration is the target, and core resolves to it. */
export async function expectArrow(tree: Tree, ext: string, spec: Spec = {}): Promise<void> {
  const file = spec.file ?? `a.${ext}`;
  const repo = await link(tree);
  const call = callOf(repo, spec.name ?? 'f', spec.caller ?? 'K.m', file);
  const target = targetOf(ext, spec);
  checkTsc(repo, call, file, { ...spec, declarations: spec.declarations ?? 1 }, target);
  expect(call).toMatchObject({ name: spec.name ?? 'f', to: target, evidence: 'resolved' });
}

/** The call stays name-only: tsc's declaration count and position are asserted, then core's `to` is absent. */
export async function expectNameOnly(tree: Tree, ext: string, spec: Spec = {}): Promise<void> {
  const file = spec.file ?? `a.${ext}`;
  const repo = await link(tree);
  const call = callOf(repo, spec.name ?? 'f', spec.caller ?? 'K.m', file);
  checkTsc(repo, call, file, spec, targetOf(ext, spec));
  expect(call).toMatchObject({ name: spec.name ?? 'f', evidence: 'name-only' });
  expect(call).not.toHaveProperty('to');
}

export const expand = (rows: readonly Row[]): [string, Tree, string, Spec][] =>
  rows.flatMap(([label, tree, exts = ALL, spec]) => exts.map((ext): [string, Tree, string, Spec] => [`${label} (${ext})`, tree(ext), ext, spec?.(ext) ?? {}]));

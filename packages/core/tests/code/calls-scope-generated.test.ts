import { beforeAll, describe, expect, it } from 'vitest';
import type { CallRef, CodeSymbol } from '../../src/code/model.js';
import { tsCallAt, type TsDeclaration } from './ts-oracle.js';
import { type Repo, type Tree, link } from './scope-helpers.js';

/**
 * COD-59: every value-binding construct of the TypeScript and JavaScript grammars, expanded over every place a call can
 * sit, checked against the TypeScript compiler API.
 *
 * Each template holds exactly one site marker (`@` a statement, `%` an expression) and is expanded over the wrappers
 * below: a binding that shadows the name must do so wherever the call is written, not only in a flat function body.
 * All files of a group share one in-memory tree, one core link pass and one TS program, so the whole matrix runs in
 * seconds.
 *
 * The oracle is the checker's declaration for the callee (aliases followed). A call core resolves must have a TS
 * declaration in the target symbol's file, with the symbol's name, and its name position (line and column) inside the
 * symbol's range. The report at the end counts name-only calls whose TS declaration is a function symbol core already
 * has: precision core gave up.
 *
 * The checker reports the declaration a written binding still points at, not what a reassignment leaves in it, so
 * writes are covered by the explicit tests in `calls-scope.test.ts`, not by this oracle.
 */

const DEFAULT_HEADER = 'function f() {}\n';
/** Every import template shares one `b.ts`; `g` is there for template 76's alias. */
const B = 'export function f() {}\nexport default function d() {}\nexport function g() {}\n';
const X = 'export const y = 1;\n';

interface Template {
  id: number;
  /** One per variant; each holds exactly one `@` or `%`. */
  bodies: readonly string[];
  site: 'statement' | 'expression';
  /** Replaces `function f() {}`; `''` when the body itself declares `f`. */
  header?: string;
  /** The call written at the site; `f()` unless the site is a member call. */
  call?: string;
}

const TEMPLATES: readonly Template[] = [
  { id: 1, site: 'statement', bodies: ['function run(f) { @ }'] },
  { id: 2, site: 'statement', bodies: ['function run({ f }) { @ }'] },
  { id: 3, site: 'statement', bodies: ['function run({ g: f }) { @ }'] },
  { id: 4, site: 'statement', bodies: ['function run([f]) { @ }'] },
  { id: 5, site: 'statement', bodies: ['function run({ f = 1 }) { @ }'] },
  { id: 6, site: 'statement', bodies: ['function run(f = 1) { @ }'] },
  { id: 7, site: 'statement', bodies: ['function run(...f) { @ }'] },
  { id: 8, site: 'statement', bodies: ['function run({ a: [f] }) { @ }'] },
  { id: 9, site: 'statement', bodies: ['function run([, ...[f]]) { @ }'] },
  { id: 10, site: 'statement', bodies: ['function run(f?: any) { @ }'] },
  { id: 11, site: 'statement', bodies: ['class K1 { constructor(private f: any) { @ } }'] },
  { id: 12, site: 'statement', bodies: ['const run = f => { @ };'] },
  { id: 13, site: 'statement', bodies: ['const run = (f) => { @ };'] },
  { id: 14, site: 'statement', bodies: ['const run = function (f) { @ };'] },
  // Wrapped in `run`: core makes no symbol for an anonymous generator expression, and a call with no enclosing symbol is skipped.
  { id: 15, site: 'statement', bodies: ['function run() { const g = function* (f) { @ }; }'] },
  { id: 16, site: 'statement', bodies: ['async function run(f) { @ }'] },
  { id: 17, site: 'statement', bodies: ['class K2 { m(f) { @ } }'] },
  { id: 18, site: 'statement', bodies: ['const o = { m(f) { @ } };'] },
  { id: 19, site: 'statement', bodies: ['class K3 { set v(f) { @ } }'] },
  { id: 20, site: 'expression', bodies: ['function run(f, a = %) {}'] },
  { id: 21, site: 'expression', bodies: ['const run = (f) => %;'] },
  { id: 22, site: 'expression', bodies: ['const run = (a) => (f) => %;'] },
  { id: 23, site: 'statement', bodies: ['const run = () => function g(f) { @ };'] },
  { id: 24, site: 'statement', bodies: ['function run() { try {} catch (f) { @ } }'] },
  { id: 25, site: 'statement', bodies: ['function run() { try {} catch ({ f }) { @ } }'] },
  { id: 26, site: 'statement', bodies: ['function run() { try {} catch (e) { @ } finally {} }'] },
  { id: 27, site: 'statement', bodies: ['function run(xs) { for (const f of xs) { @ } }'] },
  { id: 28, site: 'statement', bodies: ['function run(o) { for (let f in o) { @ } }'] },
  { id: 29, site: 'statement', bodies: ['function run() { for (let f = 0; f < 1; f++) { @ } }'] },
  { id: 30, site: 'statement', bodies: ['function run(xs) { for (var f of xs) {} @ }'] },
  { id: 31, site: 'statement', bodies: ['function run(xs) { for (let f of xs) {} @ }'] },
  { id: 32, site: 'statement', bodies: ['function run() { const f = 1; @ }'] },
  { id: 33, site: 'statement', bodies: ['function run() { let f; @ }'] },
  { id: 34, site: 'statement', bodies: ['function run() { { var f = 1; } @ }'] },
  { id: 35, site: 'statement', bodies: ['function run() { @ var f = 1; }'] },
  { id: 36, site: 'statement', bodies: ['function run() { @ let f = 1; }'] },
  { id: 37, site: 'statement', bodies: ['function run() { using f = null; @ }'] },
  { id: 38, site: 'statement', bodies: ['function run(o) { const { f } = o; @ }'] },
  { id: 39, site: 'statement', bodies: ['function run(a) { const [f] = a; @ }'] },
  { id: 40, site: 'statement', bodies: ['function run(o) { const { g: f } = o; @ }'] },
  { id: 41, site: 'statement', bodies: ['function run(o) { const { x = (f) => { @ } } = o; }'] },
  { id: 42, site: 'statement', bodies: ['function run(a) { const [x = (f) => { @ }] = a; }'] },
  { id: 43, site: 'statement', bodies: ['function run({ x = (f) => { @ } }) {}'] },
  { id: 44, site: 'statement', bodies: ['function run([x = (f) => { @ }]) {}'] },
  { id: 45, site: 'statement', bodies: ["function run(o) { const { [((f) => { @ return 'k'; })(1)]: y } = o; }"] },
  { id: 46, site: 'statement', bodies: ['function run(o) { const { a: { b = (f) => { @ } } } = o; }'] },
  { id: 47, site: 'statement', bodies: ['function run(x) { switch (x) { case 1: const f = 1; @ } }'] },
  { id: 48, site: 'statement', bodies: ['function run() { function f() {} @ }'] },
  { id: 49, site: 'statement', bodies: ['function run() { const f = () => {}; @ }'] },
  { id: 50, site: 'statement', bodies: ['function run() { let f = () => {}; @ }'] },
  { id: 51, site: 'statement', bodies: ['function run() { let f = () => {}; f = () => {}; @ }'] },
  { id: 52, site: 'statement', bodies: ['const g = function f() { @ };'] },
  { id: 53, site: 'statement', bodies: ['function run() { class f {} @ }'] },
  { id: 54, site: 'statement', bodies: ['const K4 = class f { m() { @ } };'] },
  { id: 55, site: 'statement', bodies: ['export {}; function run() { { function f() {} } @ }'] },
  { id: 56, site: 'statement', bodies: ['function run() { { function f() {} } @ }'] },
  { id: 57, site: 'statement', bodies: ['function run() { try {} catch (e) { function f() {} } @ }'] },
  { id: 58, site: 'statement', bodies: ['function run(f) { @ var f = () => {}; }'] },
  { id: 59, site: 'statement', bodies: ['function run() { (f as any) = () => {}; @ }'] },
  { id: 60, site: 'statement', bodies: ['function run() { enum f { A } @ }'] },
  { id: 61, site: 'statement', bodies: ['namespace f { export const x = 1; } function run() { @ }'] },
  { id: 62, site: 'statement', header: 'declare const f: () => void;\n', bodies: ['function run() { @ }'] },
  { id: 63, site: 'statement', header: "import f = require('./x');\n", bodies: ['function run() { @ }'] },
  { id: 64, site: 'statement', bodies: ['function run() { abstract class f {} @ }'] },
  { id: 65, site: 'statement', bodies: ['class K5 { static { var f = 1; @ } }', 'class K5 { static { var f = 1; } } function run() { @ }'] },
  { id: 66, site: 'statement', bodies: ['namespace N { var f = 1; export function run() { @ } }', 'export {}; namespace N { var f = 1; } function run() { @ }'] },
  { id: 67, site: 'statement', bodies: ['function run<f>() { @ }'] },
  { id: 68, site: 'statement', bodies: ['function run() { type f = number; @ }'] },
  { id: 69, site: 'statement', bodies: ['function run() { interface f {} @ }'] },
  { id: 70, site: 'statement', bodies: ['class K6 { f() {} m() { @ } }'] },
  { id: 71, site: 'statement', bodies: ['function run() { const o = { f: () => {} }; @ }'] },
  { id: 72, site: 'statement', bodies: ['function run() { f: for (;;) { @ break f; } }'] },
  { id: 73, site: 'statement', bodies: ['export { f as g }; function run() { @ }'] },
  { id: 74, site: 'statement', header: '', bodies: ["import { f } from './b'; function run() { @ }"] },
  { id: 75, site: 'statement', header: '', bodies: ["import { f } from './b'; function run(f) { @ }"] },
  { id: 76, site: 'statement', header: '', bodies: ["import { g as f } from './b'; function run() { @ }"] },
  { id: 77, site: 'statement', header: '', bodies: ["import f from './b'; function run() { @ }"] },
  { id: 78, site: 'statement', header: '', bodies: ["import type { f } from './b'; function run() { @ }"] },
  {
    id: 79,
    site: 'statement',
    header: '',
    call: 'ns.f()',
    bodies: ["import * as ns from './b'; function run() { @ }", "import * as ns from './b'; function run(ns) { @ }"],
  },
];

/** Templates JavaScript can run: `script`, `module`, both (strictness matters) or none (TS-only syntax). */
const JS_SCRIPT = new Set([...range(1, 9), ...range(12, 36), ...range(38, 54), 58, 70, 71, 72]);
const JS_BOTH = new Set([55, 56, 57]);
const JS_MODULE = new Set([73, 74, 75, 76, 77, 79]);

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

interface Wrapper {
  name: string;
  text: string;
}

/** The same call written at every statement position a function body can hold. */
const statementWrappers = (call: string): readonly Wrapper[] => [
  { name: 'S0', text: `${call};` },
  { name: 'S1', text: `{ ${call}; }` },
  { name: 'S2', text: `if (Math.random()) ${call};` },
  { name: 'S3', text: `(() => { ${call}; })();` },
  { name: 'S4', text: `function inner() { ${call}; }` },
  { name: 'S5', text: `function inner2(a = ${call}) {}` },
  { name: 'S6', text: `class Inner { m() { ${call}; } }` },
  { name: 'S7', text: `const o1 = { m() { ${call}; } };` },
  { name: 'S8', text: `const a1 = () => ${call};` },
  { name: 'S9', text: `try { ${call}; } catch {}` },
];

const expressionWrappers = (call: string): readonly Wrapper[] => [
  { name: 'E0', text: call },
  { name: 'E1', text: `(() => ${call})()` },
  { name: 'E2', text: `[0].map(() => ${call})` },
];

interface GeneratedCase {
  path: string;
  text: string;
  label: string;
  templateId: number;
}

/** Every template variant over every site wrapper, as `gN.ts`. */
function tsCases(): GeneratedCase[] {
  const cases: GeneratedCase[] = [];
  for (const template of TEMPLATES) {
    for (const [variant, body] of template.bodies.entries()) {
      const wrappers = template.site === 'statement' ? statementWrappers(template.call ?? 'f()') : expressionWrappers(template.call ?? 'f()');
      for (const wrapper of wrappers) {
        const label = `template ${template.id}${template.bodies.length > 1 ? ` variant ${variant + 1}` : ''} ${wrapper.name}`;
        cases.push({ path: `g${cases.length}.ts`, text: withSite(template, body, wrapper.text), label, templateId: template.id });
      }
    }
  }
  return cases;
}

/** The template's JS variants: a script, a module, or both where strictness decides Annex B. */
function jsCases(start: number): GeneratedCase[] {
  const cases: GeneratedCase[] = [];
  for (const template of TEMPLATES) {
    const both = JS_BOTH.has(template.id);
    const moduleOnly = JS_MODULE.has(template.id);
    if (!both && !moduleOnly && !JS_SCRIPT.has(template.id)) continue;
    for (const [variant, body] of template.bodies.entries()) {
      const modes: ('script' | 'module')[] = both ? ['script', 'module'] : [moduleOnly ? 'module' : 'script'];
      for (const mode of modes) {
        const wrappers = template.site === 'statement' ? statementWrappers(template.call ?? 'f()') : expressionWrappers(template.call ?? 'f()');
        for (const wrapper of wrappers) {
          const label = `template ${template.id} (js ${mode})${template.bodies.length > 1 ? ` variant ${variant + 1}` : ''} ${wrapper.name}`;
          cases.push({ path: `g${start + cases.length}.js`, text: withSite(template, jsBody(template, body, mode), wrapper.text), label, templateId: template.id });
        }
      }
    }
  }
  return cases;
}

/** The body in the requested module mode: a script drops `export {};`, a module appends it when the body has none. */
function jsBody(template: Template, body: string, mode: 'script' | 'module'): string {
  if (mode === 'script') return template.id === 55 ? body.replace(/^export \{\}; /, '') : body;
  return template.id === 55 || template.id >= 73 ? body : `${body}\nexport {};`;
}

function withSite(template: Template, body: string, wrapper: string): string {
  const marker = template.site === 'statement' ? '@' : '%';
  if (body.split(marker).length !== 2) throw new Error(`template ${template.id}: expected exactly one ${marker} in ${JSON.stringify(body)}`);
  return `${template.header ?? DEFAULT_HEADER}${body.replace(marker, wrapper)}\n`;
}

interface Harness {
  /** Generated files, one site each. */
  cases: number;
  /** `f` calls the link pass emitted over all generated files. */
  callsFound: number;
  /** Generated files whose one `f` call was found exactly once. */
  checked: number;
  /** TS lookups that did not find the call at core's position: a harness bug, not a binding. */
  notFound: string[];
  /** Resolved calls whose TS declaration is not the target symbol. */
  unsound: string[];
  /** Per template, name-only calls whose TS declaration is a function symbol core already has. */
  precision: Map<number, number>;
  nameOnly: number;
  resolved: number;
}

const describeDeclaration = (declaration: TsDeclaration | undefined): string =>
  declaration ? `${declaration.kind} ${declaration.name || '(anonymous)'} at ${declaration.file}:${declaration.line} (parent ${declaration.parentKind || 'none'})` : 'no declaration';

function describeCase(c: GeneratedCase, call: CallRef, target: CodeSymbol | undefined, declaration: TsDeclaration | undefined): string {
  return [
    `${c.label} (${c.path})`,
    ...c.text.trimEnd().split('\n').map((line) => `  | ${line}`),
    `  call at ${call.range.start.line}:${call.range.start.column}, core ${call.to ? `resolved to ${call.to}` : 'name-only'}`,
    `  target ${target ? `${target.id} lines ${target.range.start.line}-${target.range.end.line}` : 'not a symbol of the linked file'}`,
    `  ts ${describeDeclaration(declaration)}`,
  ].join('\n');
}

/** Whether a declaration's name position lies inside a core symbol's range, column included so a one-line file cannot pass. */
function withinRange(declaration: TsDeclaration, range: CodeSymbol['range']): boolean {
  const { start, end } = range;
  const afterStart = declaration.line > start.line || (declaration.line === start.line && declaration.column >= start.column);
  const beforeEnd = declaration.line < end.line || (declaration.line === end.line && declaration.column <= end.column);
  return afterStart && beforeEnd;
}

/** Whether the checker's declaration is the core symbol: same file, same name, its name position inside the symbol's range. */
function isTarget(declaration: TsDeclaration, target: CodeSymbol, name: string): boolean {
  return declaration.file === target.file && declaration.name === name && withinRange(declaration, target.range);
}

const FUNCTION_DECLARATIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunction']);

/** Whether a name-only call's declaration is a function symbol the link pass already has: precision core gave up. */
function precisionCost(repo: Repo, declaration: TsDeclaration): boolean {
  if (!FUNCTION_DECLARATIONS.has(declaration.kind)) return false;
  return (repo.files.get(declaration.file)?.symbols ?? []).some(
    (symbol) => (symbol.kind === 'function' || symbol.kind === 'method') && symbol.path.at(-1) === declaration.name && declaration.line >= symbol.range.start.line && declaration.line <= symbol.range.end.line,
  );
}

/** Templates whose file cannot share a program: ambient `const` declarations do not merge across scripts, so each keeps its own. */
const ISOLATED_TEMPLATES = new Set([62]);

async function run(): Promise<Harness> {
  const ts = tsCases();
  const js = jsCases(ts.length);
  const all = [...ts, ...js];
  const main = all.filter((c) => !ISOLATED_TEMPLATES.has(c.templateId));
  const isolated = all.filter((c) => ISOLATED_TEMPLATES.has(c.templateId));
  const harness: Harness = { cases: all.length, callsFound: 0, checked: 0, notFound: [], unsound: [], precision: new Map(), nameOnly: 0, resolved: 0 };
  await checkGroup(main, harness, { 'b.ts': B, 'x.ts': X });
  // Each isolated file gets its own program: an ambient const in one script file does not merge into another's symbol.
  for (const c of isolated) await checkGroup([c], harness, {});

  const cost = [...harness.precision.entries()].sort((a, b) => a[0] - b[0]).map(([id, count]) => `template ${id}: ${count}`).join(', ');
  console.info(
    `generated call sites: ${all.length} (${ts.length} TS, ${js.length} JS); checked ${harness.checked}; resolved ${harness.resolved}; name-only ${harness.nameOnly}`,
  );
  console.info(`precision cost (name-only although TS declares a function symbol core has): ${cost || 'none'}`);
  return harness;
}

/** Links one tree, builds its TS program and checks every case in it. */
async function checkGroup(cases: readonly GeneratedCase[], harness: Harness, extra: Tree): Promise<void> {
  const tree: Tree = { ...extra };
  for (const c of cases) tree[c.path] = c.text;
  const repo = await link(tree);
  for (const c of cases) {
    const calls = (repo.files.get(c.path)?.calls ?? []).filter((call) => call.name === 'f');
    harness.callsFound += calls.length;
    if (calls.length !== 1) {
      harness.notFound.push(`${c.label} (${c.path}): ${calls.length} calls named f in the linked file, expected 1\n${c.text.trimEnd()}`);
      continue;
    }
    const call = calls[0]!;
    const lookup = tsCallAt(tree, c.path, call.range.start.line, call.range.start.column, call.name);
    if (!lookup.found) {
      harness.notFound.push(`${c.label} (${c.path}): TS found no call at ${call.range.start.line}:${call.range.start.column}\n${c.text.trimEnd()}`);
      continue;
    }
    harness.checked++;
    const target = call.to ? repo.files.get(call.to.slice(0, call.to.indexOf('::')))?.symbols.find((symbol) => symbol.id === call.to) : undefined;
    if (call.to) {
      harness.resolved++;
      if (!target || !lookup.declaration || !isTarget(lookup.declaration, target, target.path.at(-1)!)) {
        harness.unsound.push(describeCase(c, call, target, lookup.declaration));
      }
    } else {
      harness.nameOnly++;
      if (lookup.declaration && precisionCost(repo, lookup.declaration)) {
        harness.precision.set(c.templateId, (harness.precision.get(c.templateId) ?? 0) + 1);
      }
    }
  }
}

let harness: Harness;

beforeAll(async () => {
  harness = await run();
}, 120_000);

describe('generated: every call to f is checked against the TS checker', () => {
  it('finds one f call at every generated site (non-vacuous)', () => {
    expect(harness.notFound, `sites the harness could not check:\n\n${harness.notFound.join('\n\n')}`).toEqual([]);
    expect(harness.callsFound, 'f calls found in the linked files, one per generated site').toBe(harness.cases);
    expect(harness.checked, 'generated sites whose call the TS oracle found').toBe(harness.cases);
  });

  it('resolves only where the checker’s declaration is the target symbol', () => {
    expect(harness.unsound, `resolved calls whose TS declaration is not the target:\n\n${harness.unsound.join('\n\n')}`).toEqual([]);
  });
});

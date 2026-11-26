import { describe, expect, it } from 'vitest';
import type { CallRef } from '../../src/code/model.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';
import { tsDeclarationAt, type TsDeclaration } from './ts-oracle.js';

/**
 * COD-59, plan scenarios 1–15: a call to a name that a parameter or local declaration binds never resolves to a
 * same-named top-level function.
 *
 * The TypeScript compiler API is the oracle for what the callee name means at its call site: every case asserts the
 * checker's declaration as well as core's outcome, so a core expectation cannot be derived from core's own rules.
 */

type Tree = Record<string, string>;

interface Repo {
  tree: Tree;
  files: Map<string, ParsedFile>;
}

/** Parses and links an in-memory repo, exactly as `calls.test.ts` does. */
async function link(tree: Tree): Promise<Repo> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  const linked = linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
  return { tree, files: new Map(linked.map((f) => [f.file.path, f])) };
}

const fileOf = (repo: Repo, path = 'a.ts'): ParsedFile => repo.files.get(path)!;

/** The one call named `name`, optionally made from the symbol `caller` (`run`, `run.inner`, `K.m`…). */
function callOf(repo: Repo, name: string, caller?: string, path = 'a.ts'): CallRef {
  const calls = fileOf(repo, path).calls.filter((c) => c.name === name && (!caller || c.from.startsWith(`${path}::${caller}::`)));
  expect(calls.length, `calls named ${name}${caller ? ` from ${caller}` : ''}`).toBe(1);
  return calls[0]!;
}

interface TsExpect {
  kind: string;
  parentKind?: string;
  file?: string;
}

/** The checker's declaration for the call's callee (aliases followed). */
const tsOf = (repo: Repo, call: CallRef): TsDeclaration | undefined => {
  const path = call.from.slice(0, call.from.indexOf('::'));
  return tsDeclarationAt(repo.tree, path, call.range.start.line, call.range.start.column, call.name);
};

function expectTs(actual: TsDeclaration | undefined, expected: TsExpect): TsDeclaration {
  expect(actual).toBeDefined();
  expect(actual).toMatchObject(expected);
  return actual!;
}

/** The call is name-only, and the checker binds its name as the plan says (a parameter, a binding element…). */
function nameOnly(repo: Repo, name: string, ts: TsExpect, caller?: string, path = 'a.ts'): CallRef {
  const call = callOf(repo, name, caller, path);
  expectTs(tsOf(repo, call), ts);
  expect(call).toMatchObject({ name, evidence: 'name-only' });
  expect(call).not.toHaveProperty('to');
  return call;
}

/** The call resolves to `to`, and the checker's declaration is that symbol's own name. */
function resolved(repo: Repo, name: string, to: string, ts: TsExpect, caller?: string, path = 'a.ts'): CallRef {
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

describe('a parameter or local binding shadows a same-named top-level function', () => {
  it('1. a parameter shadows the top-level function', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(f) { f(); }\n' });
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'run');
  });

  it.each([
    ['parenthesized', 'const run = (f) => { f(); };'],
    ['bare', 'const run = f => f();'],
  ])('2. an arrow function parameter (%s) shadows the top-level function', async (_form, body) => {
    const repo = await link({ 'a.ts': `function f() {}\n${body}\n` });
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'run');
  });

  it('3. an enclosing function’s parameter shadows the top-level function in a nested function', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(f) {\n  function inner() { f(); }\n}\n' });
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'run.inner');
  });

  it('4. a callback parameter shadows the top-level function inside the callback', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(xs) { xs.map((f) => f()); }\n' });
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'run');
  });

  it.each([
    ['{ f }', '{ f }', 'BindingElement'],
    ['{ g: f }', '{ g: f }', 'BindingElement'],
    ['[f]', '[f]', 'BindingElement'],
    ['{ f = d }', '{ f = d }', 'BindingElement'],
    ['...f', '...f', 'Parameter'],
    ['{ a: { f } }', '{ a: { f } }', 'BindingElement'],
    ['[, ...[f]]', '[, ...[f]]', 'BindingElement'],
  ])('5. a destructured parameter %s shadows the top-level function', async (_form, pattern, kind) => {
    const repo = await link({ 'a.ts': `function f() {}\nfunction run(${pattern}) { f(); }\n` });
    nameOnly(repo, 'f', { kind }, 'run');
  });

  it.each([
    ['an optional parameter', 'function run(f?: () => void) { f(); }', 'run'],
    ['a parameter with a default', 'function run(f: () => void = d) { f(); }', 'run'],
    ['a constructor parameter property', 'class K { constructor(private f: () => void) { f(); } }', 'K'],
  ])('6. a TypeScript parameter (%s) shadows the top-level function', async (_form, body, caller) => {
    const repo = await link({ 'a.ts': `function f() {}\n${body}\n` });
    nameOnly(repo, 'f', { kind: 'Parameter' }, caller);
  });

  it('6. a `this` parameter binds no name, so the top-level function still resolves', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(this: unknown) { f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it.each([
    ['const f = 1', 'const f = 1;'],
    ['let f', 'let f;'],
    ['var f', 'var f;'],
    ['var f in a nested block', '{ var f = 1; }'],
    ['var f declared after the call', 'f(); var f = 1;'],
    ['let f declared after the call', 'f(); let f = 1;'],
    ['using f', 'using f = null;'],
  ])('7. a value local (%s) shadows the top-level function', async (_form, body) => {
    const after = body.startsWith('f();') ? '' : ' f();';
    const repo = await link({ 'a.ts': `function f() {}\nfunction run() { ${body}${after} }\n` });
    nameOnly(repo, 'f', { kind: 'VariableDeclaration' }, 'run');
  });

  it('8. a block-scoped local does not shadow the call outside its block', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { { const f = 1; } f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it.each([
    ['an identifier', 'try {} catch (f) { f(); }', 'VariableDeclaration'],
    ['a destructuring pattern', 'try {} catch ({ f }) { f(); }', 'BindingElement'],
  ])('9. a catch parameter (%s) shadows the top-level function', async (_form, body, kind) => {
    const repo = await link({ 'a.ts': `function f() {}\nfunction run() { ${body} }\n` });
    nameOnly(repo, 'f', { kind }, 'run');
  });

  it('9. the name after a try/catch is the top-level function again', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { try {} catch (e) {} f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it.each([
    ['for-of', 'for (const f of xs) f();'],
    ['for-in', 'for (const f in o) f();'],
    ['classic for', 'for (let f = g; ;) f();'],
    ['var for-of and a call after the loop', 'for (var f of xs) {} f();'],
  ])('10. a loop binding (%s) shadows the top-level function', async (_form, body) => {
    const repo = await link({ 'a.ts': `function f() {}\nfunction run(xs, o, g) { ${body} }\n` });
    nameOnly(repo, 'f', { kind: 'VariableDeclaration' }, 'run');
  });

  it('10. a let loop binding does not shadow the name after the loop', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(xs) { for (let f of xs) {} f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it.each(['const { f } = o;', 'const [f] = a;', 'const { g: f } = o;'])('11. a destructuring declaration (%s) shadows the top-level function', async (declaration) => {
    const repo = await link({ 'a.ts': `function f() {}\nfunction run(o, a) { ${declaration} f(); }\n` });
    nameOnly(repo, 'f', { kind: 'BindingElement' }, 'run');
  });

  it.each([
    ['before the call', 'f(); function f() {}'],
    ['after the call', 'function f() {} f();'],
  ])('12. a function declaration in run (%s) resolves to itself', async (_form, body) => {
    const repo = await link({ 'a.ts': `function f() {}\nfunction run() { ${body} }\n` });
    resolved(repo, 'f', 'a.ts::run.f::function', { kind: 'FunctionDeclaration', parentKind: 'Block' }, 'run');
  });

  it('12. a function declaration nested in a sibling function leaves the top-level function', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { f(); }\nfunction other() { function f() {} }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' }, 'run');
  });
});

describe('13. Annex B and strictness decide whether a block function shadows outside its block', () => {
  it.each([
    ['a .ts module', 'a.ts', 'export {};\nfunction run() { { function f() {} } f(); }\nfunction f() {}\n'],
    ['a strict .ts script', 'a.ts', '"use strict";\nfunction run() { { function f() {} } f(); }\nfunction f() {}\n'],
    ['a .js module', 'a.js', 'export {};\nfunction run() { { function f() {} } f(); }\nfunction f() {}\n'],
  ])('%s does not hoist the block function, so the call is the top-level f', async (_form, path, body) => {
    const repo = await link({ [path]: body });
    resolved(repo, 'f', `${path}::f::function`, { kind: 'FunctionDeclaration', parentKind: 'SourceFile' }, 'run', path);
  });

  it.each([
    ['a .ts script', 'a.ts'],
    ['a .js script', 'a.js'],
  ])('%s hoists the block function (Annex B), so the call is name-only', async (_form, path) => {
    const repo = await link({ [path]: 'function run() { { function f() {} } f(); }\nfunction f() {}\n' });
    nameOnly(repo, 'f', { kind: 'FunctionDeclaration', parentKind: 'Block' }, 'run', path);
  });

  it.each([
    ['a .ts script whose function body starts with "use strict"', 'a.ts', 'function run() { "use strict"; { function f() {} } f(); }\nfunction f() {}\n', 'run'],
    ['a class body in a .ts script', 'a.ts', 'class K { m() { { function f() {} } f(); } }\nfunction f() {}\n', 'K.m'],
    ['an .mjs file, always a module', 'a.mjs', 'function run() { { function f() {} } f(); }\nfunction f() {}\n', 'run'],
  ])('%s is strict, so the block function stays in its block', async (_form, path, text, caller) => {
    const repo = await link({ [path]: text });
    resolved(repo, 'f', `${path}::f::function`, { kind: 'FunctionDeclaration', parentKind: 'SourceFile' }, caller, path);
  });

  it('in a module, a block function called inside its block resolves to it', async () => {
    const repo = await link({ 'a.ts': 'export {};\nfunction f() {}\nfunction run() { { function f() {} f(); } }\n' });
    resolved(repo, 'f', 'a.ts::run.f::function', { kind: 'FunctionDeclaration', parentKind: 'Block' }, 'run');
  });

  it('a function declared in an outer function resolves from an inner one', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() {\n  function f() {}\n  function inner() { f(); }\n}\n' });
    resolved(repo, 'f', 'a.ts::run.f::function', { kind: 'FunctionDeclaration', parentKind: 'Block' }, 'run.inner');
  });

  it('an ambient function declaration alone resolves to its symbol', async () => {
    const repo = await link({ 'a.ts': 'declare function f(): void;\nfunction run() { f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it('a class method named f binds no name, so the top-level function resolves', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nclass K { f() {} m() { f(); } }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' }, 'K.m');
  });
});

describe('14. local function values resolve to themselves unless the binding is reassigned', () => {
  it.each([
    ['an arrow function', 'const f = () => {};'],
    ['a function expression', 'const f = function () {};'],
  ])('a const local holding %s resolves to itself', async (_form, initializer) => {
    const repo = await link({ 'a.ts': `function f() {}\nfunction run() { ${initializer} f(); }\n` });
    resolved(repo, 'f', 'a.ts::run.f::function', { kind: 'VariableDeclaration' }, 'run');
  });

  it('a const local holding a generator expression shadows the top-level function, and has no symbol to resolve to', async () => {
    // The tags query records no symbol for a generator expression declarator, so the binding is proven but has no node.
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { const f = function* () {}; f(); }\n' });
    expect(fileOf(repo).symbols.map((s) => s.id)).not.toContain('a.ts::run.f::function');
    nameOnly(repo, 'f', { kind: 'VariableDeclaration', parentKind: 'VariableDeclarationList' }, 'run');
  });

  it('a write to another binding of the same name leaves the let local resolvable', async () => {
    // `other`'s own `let f` is the one written; `run`'s `f` is never assigned, so its call still reaches its arrow.
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { let f = () => {}; f(); }\nfunction other() { let f = 1; f = 2; }\n' });
    resolved(repo, 'f', 'a.ts::run.f::function', { kind: 'VariableDeclaration' }, 'run');
  });

  it.each([
    ['a compound assignment', 'f += 1;'],
    ['an increment', 'f++;'],
    ['a destructuring assignment', '[f] = [f];'],
    ['a for-of without a declaration', 'for (f of xs);'],
  ])('a let local written by %s stays name-only', async (_form, write) => {
    const repo = await link({ 'a.ts': `function f() {}\nfunction run(xs) { let f = () => {}; ${write} f(); }\n` });
    // TS reports the declarator; after the write the call reaches whatever was assigned (ECMA-262 assignment semantics).
    nameOnly(repo, 'f', { kind: 'VariableDeclaration' }, 'run');
  });

  it('a let local holding an arrow and never reassigned resolves to itself', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { let f = () => {}; f(); }\n' });
    resolved(repo, 'f', 'a.ts::run.f::function', { kind: 'VariableDeclaration' }, 'run');
  });

  it('a let local reassigned in its scope stays name-only', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { let f = () => {}; f = () => {}; f(); }\n' });
    nameOnly(repo, 'f', { kind: 'VariableDeclaration' }, 'run');
    // TS reports the declarator; core's truth rule needs a binding that is never assigned, so the call stays name-only.
    expect(repo.tree['a.ts']).toMatch(/[;{]\s*f = \(\) =>/);
  });

  it('a module let reassigned inside a function stays name-only', async () => {
    const repo = await link({ 'a.ts': 'let f = () => {};\nfunction run() { f = () => {}; f(); }\n' });
    nameOnly(repo, 'f', { kind: 'VariableDeclaration' }, 'run');
    expect(repo.tree['a.ts']).toMatch(/[;{]\s*f = \(\) =>/);
  });
});

describe('15. class and named function expression bindings shadow the top-level function', () => {
  it('a class declaration shadows the top-level function', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { class f {} f(); }\n' });
    nameOnly(repo, 'f', { kind: 'ClassDeclaration', parentKind: 'Block' }, 'run');
  });

  it('a named function expression’s own name calls the expression itself, not the top-level function', async () => {
    // TS binds `f` to the FunctionExpression; core's `g.f` symbol is that expression (it starts at `function f`).
    const repo = await link({ 'a.ts': 'function f() {}\nconst g = function f() { f(); };\n' });
    resolved(repo, 'f', 'a.ts::g.f::function', { kind: 'FunctionExpression', parentKind: 'VariableDeclaration' }, 'g.f');
  });

  it('a named class expression’s own name shadows the top-level function inside it', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nconst K = class f { m() { f(); } };\n' });
    nameOnly(repo, 'f', { kind: 'ClassExpression', parentKind: 'VariableDeclaration' }, 'f.m');
  });
});

describe('gate 2: functions as bodies, parameters re-declared, catch blocks and written declarations', () => {
  it.each([
    ['a curried arrow', 'export function next() {}\nexport const run = (store) => (next) => (action) => next(action);\n', 'next', 'ArrowFunction'],
    ['an arrow returning a function expression', 'export function f() {}\nexport const run = () => function g(f) { f(); };\n', 'f', 'FunctionExpression'],
  ])('a parameter of a function that is %s’s body shadows the top-level function', async (_form, text, name, parentKind) => {
    const repo = await link({ 'a.ts': text });
    nameOnly(repo, name, { kind: 'Parameter', parentKind });
  });

  it('an outer name called from a curried arrow still resolves', async () => {
    const repo = await link({ 'a.ts': 'export function f() {}\nexport const run = (a) => (b) => f(b);\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' });
  });

  it('a parameter re-declared by a var in the body stays the parameter', async () => {
    // A `var` of a parameter's name is the same binding (ECMA-262 FunctionDeclarationInstantiation): the call reaches
    // whatever was passed until the assignment runs.
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(f) { f(); var f = () => {}; }\n' });
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'run');
  });

  it.each([
    ['a .ts script', 'a.ts'],
    ['a .js script', 'a.js'],
  ])('in %s, a function declared in a catch block is hoisted to the function (Annex B)', async (_form, path) => {
    const repo = await link({ [path]: 'function f() {}\nfunction run() { try {} catch (e) { function f() { return 1; } } f(); }\n' });
    nameOnly(repo, 'f', { kind: 'FunctionDeclaration', parentKind: 'Block' }, 'run', path);
  });

  it('in a module, a function declared in a catch block stays in it', async () => {
    const repo = await link({ 'a.ts': 'export {};\nfunction f() {}\nfunction run() { try {} catch (e) { function f() { return 1; } } f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' }, 'run');
  });

  it.each([
    ['an as cast', 'export function f() {}\nexport function run() { (f as any) = () => {}; f(); }\n', 'f', 'FunctionDeclaration'],
    ['an angle-bracket cast', 'export function f() {}\nexport function run() { (<any>f) = () => {}; f(); }\n', 'f', 'FunctionDeclaration'],
    ['a satisfies expression', 'export function f() {}\nexport function run() { let g = () => {}; (g satisfies unknown) = () => {}; g(); }\n', 'g', 'VariableDeclaration'],
  ])('a binding written through %s stays name-only', async (_form, text, name, kind) => {
    // A cast on the left of `=` still assigns the binding (ECMA-262 assignment); TS reports the original declaration.
    const repo = await link({ 'a.ts': text });
    nameOnly(repo, name, { kind }, 'run');
  });

  it('a function declaration written elsewhere stays name-only', async () => {
    const repo = await link({ 'a.ts': 'export function f() {}\nexport function run() { f = () => {}; f(); }\n' });
    // TS reports the declaration; after the write the call reaches whatever was assigned (ECMA-262 assignment semantics).
    nameOnly(repo, 'f', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' }, 'run');
    expect(repo.tree['a.ts']).toMatch(/\{ f = \(\) =>/);
  });
});

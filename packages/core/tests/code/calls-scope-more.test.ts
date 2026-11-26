import { describe, expect, it } from 'vitest';
import { callOf, expectTs, fileOf, link, nameOnly, receiverOnly, resolved, tsOf, unbound } from './scope-helpers.js';

/**
 * COD-59, plan scenarios 16–30: imports and namespace members are shadowed by local bindings; names that bind no
 * value (property keys, labels, type-only declarations) do not shadow; `with`, globals and merged namespaces stay
 * conservative.
 *
 * As in `calls-scope.test.ts`, the TypeScript checker is the oracle: each case asserts the declaration it gives the
 * callee (or the receiver of a member call) next to core's outcome.
 */

describe('16. imports are shadowed only where a local binding wins', () => {
  const named = { 'b.ts': 'export function f() {}\n' };

  it.each([
    ['a parameter', 'export function run(f) { f(); }', 'Parameter'],
    ['a local const', 'export function run() { const f = 1; f(); }', 'VariableDeclaration'],
    ['a catch parameter', 'export function run() { try {} catch (f) { f(); } }', 'VariableDeclaration'],
    ['a destructured local', 'export function run(o) { const { f } = o; f(); }', 'BindingElement'],
  ])('a named import shadowed by %s is name-only', async (_form, body, kind) => {
    const repo = await link({ 'a.ts': `import { f } from './b';\n${body}\n`, ...named });
    nameOnly(repo, 'f', { kind }, 'run');
  });

  it('a default import shadowed by a parameter is name-only', async () => {
    const repo = await link({ 'a.ts': "import f from './b';\nexport function run(f) { f(); }\n", 'b.ts': 'export default function f() {}\n' });
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'run');
  });

  it('an aliased import shadowed by a parameter is name-only', async () => {
    const repo = await link({ 'a.ts': "import { g as f } from './b';\nexport function run(f) { f(); }\n", 'b.ts': 'export function g() {}\n' });
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'run');
  });

  it('a namespace import shadowed by a parameter is name-only', async () => {
    const repo = await link({ 'a.ts': "import * as ns from './b';\nexport function run(ns) { ns.f(); }\n", ...named });
    receiverOnly(repo, 'f', 'ns', { kind: 'Parameter' }, 'run');
  });

  it('a namespace import shadowed by a local const is name-only', async () => {
    const repo = await link({ 'a.ts': 'export function run() { const ns = {}; ns.f(); }\n' });
    receiverOnly(repo, 'f', 'ns', { kind: 'VariableDeclaration' }, 'run');
  });

  it('an unshadowed named import resolves', async () => {
    const repo = await link({ 'a.ts': "import { f } from './b';\nexport function run() { f(); }\n", ...named });
    resolved(repo, 'f', 'b.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it('an unshadowed default import resolves', async () => {
    const repo = await link({ 'a.ts': "import f from './b';\nexport function run() { f(); }\n", 'b.ts': 'export default function f() {}\n' });
    resolved(repo, 'f', 'b.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it('an unshadowed namespace import resolves its member', async () => {
    const repo = await link({ 'a.ts': "import * as ns from './b';\nexport function run() { ns.f(); }\n", ...named });
    const call = resolved(repo, 'f', 'b.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
    expect(call).toMatchObject({ via: 'member', receiver: 'ns' });
  });

  it('an import shadowed only in a sibling function still resolves in run', async () => {
    const repo = await link({
      'a.ts': "import { f } from './b';\nfunction setup(f) { f(); }\nexport function run() { f(); }\n",
      ...named,
    });
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'setup');
    resolved(repo, 'f', 'b.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });
});

describe('17. names that bind no value do not shadow', () => {
  it('a property arrow calling the name resolves the top-level function, not the property', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(s) { return { f: (x) => f(x) }; }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run.f');
  });

  it('a property value that calls the name resolves the top-level function', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { return { f: f() }; }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it('an object method calling its own name resolves the top-level function', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { return { f() { f(); } }; }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run.f');
  });

  it('a property arrow that calls a name with no binding stays name-only', async () => {
    const repo = await link({ 'a.ts': 'function run() { return { f: () => {}, g: () => f() }; }\n' });
    unbound(repo, 'f', 'run.g');
  });
});

describe('18. the issue’s shape', () => {
  const source = [
    'const schema = obj.refine((s, ctx) => {',
    '  const issue = (p) => ctx.add(p);',
    '  check(s, issue);',
    '});',
    'function check(s, issue) { issue("x"); }',
    'function other() { issue("y"); }',
  ].join('\n');

  it('a parameter named issue keeps the call in check name-only', async () => {
    const repo = await link({ 'a.ts': source });
    nameOnly(repo, 'issue', { kind: 'Parameter' }, 'check');
  });

  it('an unbound issue keeps the call in other name-only', async () => {
    const repo = await link({ 'a.ts': source });
    unbound(repo, 'issue', 'other');
  });
});

describe('19. overloads resolve to the merged symbol', () => {
  it.each([
    ['plain', 'function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown) {}\nfunction run() { f(); }'],
    ['exported', 'export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: unknown) {}\nexport function run() { f(); }'],
  ])('%s overloads resolve', async (_form, body) => {
    const repo = await link({ 'a.ts': `${body}\n` });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });
});

describe('20. a top-level function definition still resolves', () => {
  it.each([
    ['export function', 'export function f() {}', 'FunctionDeclaration'],
    ['export default function', 'export default function f() {}', 'FunctionDeclaration'],
    ['export const arrow', 'export const f = () => {};', 'VariableDeclaration'],
    ['several declarators', 'const a = 1, f = () => {};', 'VariableDeclaration'],
    ['async function', 'async function f() {}', 'FunctionDeclaration'],
    ['generator function', 'function* f() {}', 'FunctionDeclaration'],
    ['export async function', 'export async function f() {}', 'FunctionDeclaration'],
  ])('%s resolves', async (_form, declaration, kind) => {
    const repo = await link({ 'a.ts': `${declaration}\nfunction run() { f(); }\n` });
    resolved(repo, 'f', 'a.ts::f::function', { kind }, 'run');
  });

  it('an arrow caller resolves the top-level export', async () => {
    const repo = await link({ 'a.ts': 'export function f() {}\nconst run = () => { f(); };\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });
});

describe('21. a name bound twice has no provable target', () => {
  it('two function declarations of one name stay name-only', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction f() {}\nfunction run() { f(); }\n' });
    // TS resolves the name (to the first declaration); core cannot prove which declaration a call reaches.
    nameOnly(repo, 'f', { kind: 'FunctionDeclaration' }, 'run');
  });

  it('a var declaration merged with a function declaration stays name-only', async () => {
    const repo = await link({ 'a.ts': 'var f;\nfunction f() {}\nfunction run() { f(); }\n' });
    // TS merges the two into one symbol and resolves it; core's truth rule refuses a name bound twice in one scope.
    nameOnly(repo, 'f', { kind: 'FunctionDeclaration' }, 'run');
  });

  it('a function merged with a namespace stays name-only', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nnamespace f {}\nfunction run() { f(); }\n' });
    // TS merges the function and the namespace into one symbol and resolves the call; core refuses a name bound twice.
    nameOnly(repo, 'f', { kind: 'FunctionDeclaration' }, 'run');
  });
});

describe('22. TypeScript-only declarations', () => {
  it('an enum local shadows the top-level function', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { enum f {} f(); }\n' });
    nameOnly(repo, 'f', { kind: 'EnumDeclaration', parentKind: 'Block' }, 'run');
  });

  it('a namespace of the same name stays name-only', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nnamespace f {}\nfunction run() { f(); }\n' });
    // TS merges the function and the namespace into one symbol and resolves the call; core refuses a name bound twice.
    nameOnly(repo, 'f', { kind: 'FunctionDeclaration' }, 'run');
  });

  it('a namespace local stays name-only', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { namespace f {} f(); }\n' });
    // TS rejects a namespace declaration in a function body and reports the outer f; core binds the namespace name as other.
    nameOnly(repo, 'f', { kind: 'FunctionDeclaration' }, 'run');
  });

  it('an import-equals binding stays name-only', async () => {
    const repo = await link({ 'a.ts': "import f = require('./x');\nfunction run() { f(); }\n", 'x.ts': 'export function g() {}\n' });
    // TS binds f to the module object (declaration: the module's SourceFile); core treats `import f = …` as no value binding.
    nameOnly(repo, 'f', { kind: 'SourceFile' }, 'run');
  });

  it.each([
    ['a module declared const', 'declare const f: () => void;\nfunction run() { f(); }'],
    ['a local declared const', 'function f() {}\nfunction run() { declare const f: () => void; f(); }'],
  ])('%s stays name-only', async (_form, source) => {
    const repo = await link({ 'a.ts': `${source}\n` });
    nameOnly(repo, 'f', { kind: 'VariableDeclaration' }, 'run');
  });

  it.each([
    ['type alias', 'type f = string;'],
    ['interface', 'interface f {}'],
  ])('a local %s does not bind a value', async (_form, declaration) => {
    const repo = await link({ 'a.ts': `function f() {}\nfunction run() { ${declaration} f(); }\n` });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it('a type parameter does not bind a value', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run<f>() { f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });
});

describe('23–24. `with` and globals stay name-only', () => {
  it('a call inside a with body stays name-only', async () => {
    const repo = await link({ 'a.js': 'function f() {}\nfunction run(o) { with (o) { f(); } }\n' });
    const call = callOf(repo, 'f', 'run', 'a.js');
    expect(call).toMatchObject({ name: 'f', evidence: 'name-only' });
    expect(call).not.toHaveProperty('to');
    // ECMA-262 The `with` Statement: the body runs with an object Environment Record in front of the function's own,
    // so whether `f` is the top-level function depends on `o` at run time. TypeScript does not resolve `with` at all,
    // so it cannot be the oracle for this case.
  });

  it('a global with no binding stays name-only', async () => {
    const repo = await link({ 'a.ts': 'function run() { fetch(); }\n' });
    const call = callOf(repo, 'fetch', 'run');
    expect(call).toMatchObject({ name: 'fetch', evidence: 'name-only' });
    expect(call).not.toHaveProperty('to');
    // TS points into lib.dom.d.ts, which is not a repo symbol: core can prove no target from the code layer.
    const found = expectTs(tsOf(repo, call), { kind: 'FunctionDeclaration' });
    expect(found.file).toContain('lib.dom.d.ts');
  });
});

describe('25–26. scopes inside a switch, a method, a setter and a static block', () => {
  it('a const in a case clause shadows its case, not the call after the switch', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(x) { switch (x) { case 1: const f = 1; f(); } f(); }\n' });
    const calls = fileOf(repo, 'a.ts').calls.filter((c) => c.name === 'f');
    expect(calls).toHaveLength(2);
    expectTs(tsOf(repo, calls[0]!), { kind: 'VariableDeclaration' });
    expect(calls[0]).toMatchObject({ name: 'f', evidence: 'name-only' });
    expect(calls[0]).not.toHaveProperty('to');
    expectTs(tsOf(repo, calls[1]!), { kind: 'FunctionDeclaration', file: 'a.ts', line: 1 });
    expect(calls[1]).toMatchObject({ name: 'f', to: 'a.ts::f::function', evidence: 'resolved' });
  });

  it.each([
    ['a method parameter', 'class K { m(f) { f(); } }', 'K.m', 'Parameter', 'MethodDeclaration'],
    ['a setter parameter', 'class K { set v(f) { f(); } }', 'K.v', 'Parameter', 'SetAccessor'],
    ['an object method parameter', 'function run() { return { m(f) { f(); } }; }', 'run.m', 'Parameter', 'MethodDeclaration'],
    ['an async function parameter', 'async function run(f) { f(); }', 'run', 'Parameter', 'FunctionDeclaration'],
    ['a generator function parameter', 'function* run(f) { f(); }', 'run', 'Parameter', 'FunctionDeclaration'],
  ])('%s shadows the top-level function', async (_form, body, caller, kind, parentKind) => {
    const repo = await link({ 'a.ts': `function f() {}\n${body}\n` });
    nameOnly(repo, 'f', { kind, parentKind }, caller);
  });

  it('a class static block local shadows the top-level function', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nclass K { static { const f = 1; f(); } }\n' });
    nameOnly(repo, 'f', { kind: 'VariableDeclaration' }, 'K');
  });
});

describe('27–29. file kinds, labels and parameter defaults', () => {
  it.each([
    ['a .tsx file', 'a.tsx'],
    ['a .jsx file', 'a.jsx'],
  ])('a parameter in %s shadows the top-level function', async (_form, path) => {
    const repo = await link({ [path]: 'function f() {}\nfunction run(f) { f(); }\n' });
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'run', path);
  });

  it('a label does not bind a value, so the call resolves', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { f: for (;;) { break f; } f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it.each([
    ['a function parameter default', 'function run(a = f()) { var f = () => {}; }'],
    ['an arrow parameter default', 'const run = (a = f()) => { var f = () => {}; };'],
  ])('29. %s sees the outer scope, not the body', async (_form, body) => {
    const repo = await link({ 'a.ts': `function f() {}\n${body}\n` });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration' }, 'run');
  });

  it('29. a parameter default sees an earlier parameter', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(f, a = f()) {}\n' });
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'run');
  });

  it('29. an arrow in a parameter default sees the outer scope, not a body var', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(a = () => f()) { var f = 1; }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' }, 'run');
  });
});

describe('30. namespaces', () => {
  it('a merged namespace member wins, so the call is name-only', async () => {
    const repo = await link({
      'a.ts': 'export {};\nfunction f() {}\nnamespace N { export function f() {} }\nnamespace N { export function run() { f(); } }\n',
    });
    nameOnly(repo, 'f', { kind: 'FunctionDeclaration', parentKind: 'ModuleBlock' }, 'N.run');
  });

  it('a single namespace body is conservative and stays name-only', async () => {
    const repo = await link({ 'a.ts': 'export {};\nfunction f() {}\nnamespace N { export function run() { f(); } }\n' });
    // TS resolves the module-level f. Merged namespaces can export `f` from a declaration in another file, so core
    // cannot prove the body does not bind it.
    nameOnly(repo, 'f', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' }, 'N.run');
  });

  it('a namespace member the body itself binds resolves to it', async () => {
    const repo = await link({ 'a.ts': 'export {};\nnamespace N { function f() {} export function run() { f(); } }\n' });
    resolved(repo, 'f', 'a.ts::N.f::function', { kind: 'FunctionDeclaration', parentKind: 'ModuleBlock' }, 'N.run');
  });
});

describe('Greptile review', () => {
  it('a write to an import in one file leaves imports in other files resolvable', async () => {
    // Each parse owns its bindings: a write in w.ts says nothing about a.ts's import of the same module.
    await link({ 'w.ts': "import { f } from './b';\nexport function run() { (f as any) = () => {}; }\n", 'b.ts': 'export function f() {}\nexport function g() {}\n' });
    const repo = await link({ 'a.ts': "import { g } from './b';\nimport * as ns from './b';\nexport function run() { g(); ns.f(); }\n", 'b.ts': 'export function f() {}\nexport function g() {}\n' });
    resolved(repo, 'g', 'b.ts::g::function', { kind: 'FunctionDeclaration', file: 'b.ts' }, 'run');
    expect(callOf(repo, 'f', 'run')).toMatchObject({ via: 'member', receiver: 'ns', to: 'b.ts::f::function', evidence: 'resolved' });
  });

  it('a file parsed after one that writes an import resolves exactly as when parsed alone', async () => {
    const reader = "import { f } from './b';\nexport function run() { f(); }\n";
    const b = 'export function f() {}\n';
    const alone = fileOf(await link({ 'a.ts': reader, 'b.ts': b })).calls;
    await link({ 'w.ts': "import { f } from './b';\nexport function run() { (f as any) = () => {}; f(); }\n", 'b.ts': b });
    const after = fileOf(await link({ 'a.ts': reader, 'b.ts': b })).calls;
    expect(after).toEqual(alone);
    expect(alone[0]).toMatchObject({ to: 'b.ts::f::function', evidence: 'resolved' });
  });

  it.each([
    ['a class static block', 'class K { static { var f = () => {}; } }\nfunction f() {}\nfunction run() { f(); }\n'],
    ['a namespace body', 'export {};\nnamespace N { var f = () => {}; }\nfunction f() {}\nfunction run() { f(); }\n'],
  ])('a var in %s stays inside it', async (_form, text) => {
    const repo = await link({ 'a.ts': text });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' }, 'run');
  });

  it.each([
    ['a destructuring declaration', 'function f() {}\nfunction run(o) { const { x = (f) => f() } = o; }\n'],
    ['a destructured parameter', 'function f() {}\nfunction run({ x = (f) => f() }) {}\n'],
    ['an array destructuring declaration', 'function f() {}\nfunction run(a) { const [x = (f) => f()] = a; }\n'],
    ['an array destructured parameter', 'function f() {}\nfunction run([x = (f) => f()]) {}\n'],
    ['a nested destructuring declaration', 'function f() {}\nfunction run(o) { const { a: { b = (f) => f() } } = o; }\n'],
    ['a computed key', "function f() {}\nfunction run(o) { const { [((f) => f())(1)]: y } = o; }\n"],
  ])('a callback in a default of %s gets its own parameter scope', async (_form, text) => {
    const repo = await link({ 'a.ts': text });
    nameOnly(repo, 'f', { kind: 'Parameter', parentKind: 'ArrowFunction' }, 'run');
  });
});

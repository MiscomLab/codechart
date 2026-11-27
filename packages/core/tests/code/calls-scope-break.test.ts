import { describe, expect, it } from 'vitest';
import type { CallRef } from '../../src/code/model.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';
import { tsCallAt, type TsDeclaration } from './ts-oracle.js';
import { type Repo, type Tree, type TsExpect, callOf, expectTs, fileOf, link } from './scope-helpers.js';

/**
 * COD-59 second-reader pass (Gate 2, steps 6–7): constructs the new JS scope reader and the Python PEP 695 code do not
 * handle, plus a check that no parse leaks state into the next one.
 *
 * JS expectations come from the TypeScript checker (`ts-oracle.ts`); Python expectations from CPython 3.14's own
 * `symtable` and runtime, quoted at each case. Every Python case below was run with `python3 -I` (3.14.7): the
 * annotation scope, the type-parameter scope and the class type-parameter scope all bind the definition's type
 * parameters, so the callee is the type parameter (a `typing.TypeVar`, not callable), never the module `f`.
 */

const tsOf = (repo: Repo, call: CallRef): TsDeclaration | undefined => {
  const path = call.from.slice(0, call.from.indexOf('::'));
  const lookup = tsCallAt(repo.tree, path, call.range.start.line, call.range.start.column, call.name);
  return lookup.found ? lookup.declaration : undefined;
};

/** A call core leaves name-only, with the checker's declaration for its callee as the oracle. */
function nameOnly(repo: Repo, name: string, ts: TsExpect, caller?: string, path = 'a.ts'): CallRef {
  const call = callOf(repo, name, caller, path);
  expectTs(tsOf(repo, call), ts);
  expect(call).toMatchObject({ name, evidence: 'name-only' });
  expect(call).not.toHaveProperty('to');
  return call;
}

/** A call core resolves, with the checker's declaration checked against the target symbol. */
function resolved(repo: Repo, name: string, to: string, ts: TsExpect, caller?: string, path = 'a.ts'): CallRef {
  const call = callOf(repo, name, caller, path);
  const found = expectTs(tsOf(repo, call), ts);
  const target = fileOf(repo, to.slice(0, to.indexOf('::'))).symbols.find((symbol) => symbol.id === to);
  expect(target, `symbol ${to}`).toBeDefined();
  expect(found.file).toBe(target!.file);
  expect(found.line).toBeGreaterThanOrEqual(target!.range.start.line);
  expect(found.line).toBeLessThanOrEqual(target!.range.end.line);
  expect(call).toMatchObject({ name, to, evidence: 'resolved' });
  return call;
}

const MODULE = 'def f():\n    return object\n\n\n';

const pyFile = (repo: Repo, path = 'a.py') => fileOf(repo, path);

/** The calls named `f` in a Python file, with their outcome. */
const pyCalls = (repo: Repo, path = 'a.py') => pyFile(repo, path).calls.filter((c) => c.name === 'f');

/** The call is name-only: Python binds the name to something that is not the module `f` (here, a PEP 695 type parameter). */
function pyNameOnly(repo: Repo, path = 'a.py'): CallRef {
  const calls = pyCalls(repo, path);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.to, 'the call resolves to a function Python’s own scopes do not bind here').toBeUndefined();
  expect(calls[0]).toMatchObject({ name: 'f', evidence: 'name-only' });
  return calls[0]!;
}

function pyResolved(repo: Repo, to: string, path = 'a.py'): CallRef {
  const calls = pyCalls(repo, path);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: 'f', to, evidence: 'resolved' });
  return calls[0]!;
}

describe('step 6: PEP 695 type parameters are in scope in annotations, bounds, bases and alias values', () => {
  it.each([
    ['a parameter annotation', 'def run[f](x: f()):\n    pass\n'],
    ['a return annotation', 'def run[f]() -> f():\n    pass\n'],
  ])('%s of a generic function: the type parameter, not the module f', async (_form, body) => {
    // symtable: the annotation scope has `f: free|referenced`; its parent type-parameters scope has `f: local`.
    // Runtime 3.14, forcing annotation evaluation: TypeError: 'typing.TypeVar' object is not callable.
    pyNameOnly(await link({ 'a.py': MODULE + body }));
  });

  it('a type-parameter bound: the type parameter, not the module f', async () => {
    // symtable: the nested `type variable f` scope has `f: free|referenced`, bound by the type-parameters scope.
    // Runtime 3.14: `run.__type_params__[0].__bound__` -> TypeError: 'typing.TypeVar' object is not callable.
    pyNameOnly(await link({ 'a.py': MODULE + 'def run[f: f()]():\n    pass\n' }));
  });

  it('a generic class base: the type parameter, not the module f', async () => {
    // symtable: the class `K` scope has no `f`; `f` is resolved in the `type parameters K` scope (`f: local`).
    // Runtime 3.14: `class K[f](f())` -> TypeError: 'typing.TypeVar' object is not callable.
    pyNameOnly(await link({ 'a.py': MODULE + 'class K[f](f()):\n    pass\n' }));
  });

  it('a generic class base keyword: the type parameter, not the module f', async () => {
    // Runtime 3.14: `class K[f](metaclass=f())` -> TypeError: 'typing.TypeVar' object is not callable.
    pyNameOnly(await link({ 'a.py': MODULE + 'class K[f](metaclass=f()):\n    pass\n' }));
  });

  it('the annotation of a generic method: its own type parameter, not the module f', async () => {
    // Runtime 3.14: `K().m.__annotations__` -> TypeError: 'typing.TypeVar' object is not callable.
    pyNameOnly(await link({ 'a.py': MODULE + 'class K:\n    def m[f](self, x: f()):\n        pass\n' }));
  });

  it('the value of a generic type alias: the alias type parameter, not the module f', async () => {
    // Runtime 3.14: `type Alias[f] = f()`; `Alias.__value__` -> TypeError: 'typing.TypeVar' object is not callable.
    pyNameOnly(await link({ 'a.py': MODULE + 'def run():\n    type Alias[f] = f()\n' }));
  });

  // Controls: a fix must not shadow more than Python does.
  it.each([
    ['a non-generic annotation', 'def run(x: f()):\n    pass\n'],
    ['an annotation under a differently named type parameter', 'def run[T](x: f()):\n    pass\n'],
  ])('%s still resolves the module f', async (_form, body) => {
    // symtable: the annotation scope has `f: global`; there is no type parameter named f.
    pyResolved(await link({ 'a.py': MODULE + body }), 'a.py::f::function');
  });

  it('a base of a class whose type parameter has another name still resolves the module f', async () => {
    // Runtime 3.14: `class K[T](f())` calls the module f (it returns `object`; the class then fails on an MRO error,
    // which is only reached because f() was called). It is not the type parameter T.
    pyResolved(await link({ 'a.py': MODULE + 'class K[T](f()):\n    pass\n' }), 'a.py::f::function');
  });

  it('a generic type alias value with another type-parameter name still resolves the module f', async () => {
    // Runtime 3.14: `type Alias[T] = f()` then `Alias.__value__` -> <class 'object'>: the module f was called.
    pyResolved(await link({ 'a.py': MODULE + 'def run():\n    type Alias[T] = f()\n' }), 'a.py::f::function');
  });
});

describe('step 6: JS scopes the reader handles at their boundary', () => {
  it('a class field initializer sees the enclosing scope, not a sibling field name', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nclass K { f = () => {}; m = f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' });
  });

  it('a constructor parameter property is not in scope in a field initializer', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nclass K { constructor(private f: any) {} m = f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' });
  });

  it('a computed method name is evaluated in the class’s enclosing scope', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nclass K { [f()]() {} }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' });
  });

  it('an optional-chained namespace import still resolves its member', async () => {
    const repo = await link({ 'a.ts': "import * as ns from './b';\nexport function run() { ns?.f(); }\n", 'b.ts': 'export function f() {}\n' });
    const call = resolved(repo, 'f', 'b.ts::f::function', { kind: 'FunctionDeclaration', file: 'b.ts' }, 'run');
    expect(call).toMatchObject({ via: 'member', receiver: 'ns' });
  });

  it('a named function expression’s own name is in scope in its parameter defaults', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nconst g = function f(x = f()) {};\n' });
    resolved(repo, 'f', 'a.ts::g.f::function', { kind: 'FunctionExpression', parentKind: 'VariableDeclaration' }, 'g.f');
  });

  it('a named function expression’s own name is in scope in its body', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nconst g = function f() { f(); };\n' });
    resolved(repo, 'f', 'a.ts::g.f::function', { kind: 'FunctionExpression', parentKind: 'VariableDeclaration' }, 'g.f');
  });

  it('a function declaration as the body of an if statement resolves to that declaration', async () => {
    // Valid sloppy JavaScript; the checker binds the callee to the FunctionDeclaration whose parent is the IfStatement.
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(c) { if (c) function f() { return 1; } f(); }\n' });
    resolved(repo, 'f', 'a.ts::run.f::function', { kind: 'FunctionDeclaration', parentKind: 'IfStatement' }, 'run');
  });

  it('a call in an arrow inside a with body stays name-only', async () => {
    const repo = await link({ 'a.js': 'function f() {}\nfunction run(o) { with (o) { const g = () => f(); } }\n' });
    const call = callOf(repo, 'f', undefined, 'a.js');
    expect(call).toMatchObject({ name: 'f', evidence: 'name-only' });
    // ECMA-262 The `with` Statement: the object environment record sits in front of every scope the closure sees.
  });

  it('a destructured for-of target shadows the called name inside the loop', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(xs) { for (const { f } of xs) f(); }\n' });
    nameOnly(repo, 'f', { kind: 'BindingElement', parentKind: 'ObjectBindingPattern' }, 'run');
  });

  it('a for-of right-hand side sees the head binding, so the call stays name-only', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run(xs) { for (let f of f()) {} }\n' });
    // checker: the callee is the head's VariableDeclaration (TDZ at run time, ECMA-262 ForIn/OfHeadEvaluation).
    nameOnly(repo, 'f', { kind: 'VariableDeclaration' }, 'run');
  });

  it('a function declaration in a strict switch case stays in the switch, so a later call resolves the top-level f', async () => {
    const repo = await link({ 'a.ts': 'export {}\nfunction f() {}\nfunction run(x) { switch (x) { case 1: function f() { return 1; } } f(); }\n' });
    resolved(repo, 'f', 'a.ts::f::function', { kind: 'FunctionDeclaration', parentKind: 'SourceFile' }, 'run');
  });

  it('an imported function called in a class heritage resolves through the import', async () => {
    const repo = await link({ 'a.ts': "import { f } from './b';\nclass K extends f() {}\n", 'b.ts': 'export function f() {}\n' });
    resolved(repo, 'f', 'b.ts::f::function', { kind: 'FunctionDeclaration', file: 'b.ts' });
  });

  it('a var in a catch block still reaches the enclosing function scope', async () => {
    const repo = await link({ 'a.ts': 'function f() {}\nfunction run() { try {} catch (e) { var g = 1; } g(); }\n' });
    // The checker binds g to the var declarator; core cannot prove the var is the top-level name.
    const call = callOf(repo, 'g', 'run');
    expect(call).toMatchObject({ name: 'g', evidence: 'name-only' });
    expect(call).not.toHaveProperty('to');
  });
});

describe('step 6: calls and their scopes stay aligned when the tree has errors', () => {
  it('a call in a broken function is skipped and the surviving call keeps its own meaning', async () => {
    const text = 'function f() {}\nfunction run(f) { f(); }\nfunction broken( { f(); }\n';
    const tree = { 'a.ts': text };
    const parsed = (await parseCode('a.ts', text))!;
    expect(parsed.calls.length).toBe(parsed.scopes?.length ?? 0);
    const repo = await link(tree);
    // The only emitted call is run's; the one in the broken function is not read.
    expect(fileOf(repo).calls).toHaveLength(1);
    nameOnly(repo, 'f', { kind: 'Parameter' }, 'run');
  });

  it('a parse that keeps last-good symbols still aligns every emitted call with its scope', async () => {
    const good = (await parseCode('a.ts', 'function f() {}\nfunction run(f) { f(); }\n'))!;
    const broken = (await parseCode('a.ts', 'function f() {}\nfunction run(f) { f(); }\nfunction broken( { }\n', good))!;
    expect(broken.calls.length).toBe(broken.scopes?.length ?? 0);
    expect(broken.calls).toHaveLength(1);
    expect(broken.calls[0]).toMatchObject({ name: 'f', evidence: 'name-only' });
    expect(broken.calls[0]).not.toHaveProperty('to');
    expect(broken.scopes?.[0]).toMatchObject({ callee: { kind: 'other' } });
  });
});

describe('step 7: no state leaks from one file or parse into the next', () => {
  const JS_B = 'function f() {}\nfunction run(f) { f(); }\n';

  it('a JS file parsed after one that writes an import resolves exactly as when parsed alone', async () => {
    const before = fileOf(await link({ 'a.ts': JS_B }));
    const soleCalls = JSON.stringify(before.calls);
    const soleScopes = JSON.stringify(before.scopes);
    await link({
      'w.ts': "import { f } from './b';\nexport function run() { (f as any) = () => {}; f(); }\n",
      'b.ts': 'export function f() {}\n',
    });
    const after = fileOf(await link({ 'a.ts': JS_B }));
    expect(JSON.stringify(after.calls)).toBe(soleCalls);
    expect(JSON.stringify(after.scopes)).toBe(soleScopes);
  });

  it('parsing another file does not mutate the meanings an earlier file stored', async () => {
    const first = (await parseCode('a.ts', 'function f() {}\nconst run = (f) => f();\n'))!;
    const snapshot = JSON.stringify(first.scopes);
    await parseCode('b.py', 'def f():\n    pass\n\n\ndef run[f](x: f()):\n    pass\n');
    await parseCode('c.ts', 'function f() {}\nfunction run() { let f = () => {}; f = 1; f(); }\n');
    expect(JSON.stringify(first.scopes)).toBe(snapshot);
  });

  it('a Python file parsed after one with a type-parameter annotation resolves exactly as when parsed alone', async () => {
    const body = 'def run(x: f()):\n    pass\n';
    const before = JSON.stringify(pyFile(await link({ 'a.py': MODULE + body })).calls);
    await link({ 'w.py': MODULE + 'def run[f](x: f()):\n    pass\n' });
    const after = JSON.stringify(pyFile(await link({ 'a.py': MODULE + body })).calls);
    expect(after).toBe(before);
  });

  it('linking the same parsed files twice yields the same calls', async () => {
    const tree: Tree = { 'a.ts': "import { f } from './b';\nexport function run() { f(); }\n", 'b.ts': 'export function f() {}\n' };
    const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
    const resolver = () => createResolver(Object.keys(tree), (path) => tree[path]);
    const once = linkCode(parsed, resolver());
    const twice = linkCode(parsed, resolver());
    expect(twice.map((f) => f.calls)).toEqual(once.map((f) => f.calls));
  });
});

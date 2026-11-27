import type { Node } from 'web-tree-sitter';
import { aliasName, patternNames, unwrapExpression } from './js-scope-decl.js';
import type { Binding, Scope } from './js-scope-model.js';
import { exemptKinds, type ExemptKind } from './js-types.js';

/** The scope work that is not a handler: enum bodies, sloppy `eval` taints and literal receivers. */

const OTHER: Binding = { kind: 'other' };

/** What the scope builder offers these helpers; `Scopes` passes its own bound methods. */
export interface ScopeApi {
  make: (kind: Scope['kind'], node: Node, parent: Scope | undefined, strict: boolean) => Scope;
  add: (scope: Scope, name: string, binding: Binding) => void;
  children: (node: Node, scope: Scope, strict: boolean) => void;
  walk: (node: Node, scope: Scope, strict: boolean) => void;
  varScope: (scope: Scope) => Scope;
}

/** Whether a `const` initializer is an object literal, array literal or `Object.create(null)`, through any cast. */
function literalValue(value: Node | null | undefined): boolean {
  const node = unwrapExpression(value);
  if (!node) return false;
  if (node.type === 'object' || node.type === 'array') return true;
  if (node.type !== 'call_expression') return false;
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'member_expression' || fn.childForFieldName('object')?.text !== 'Object' || fn.childForFieldName('property')?.text !== 'create') return false;
  const args = node.childForFieldName('arguments')?.namedChildren ?? [];
  return args.length === 1 && args[0]?.type === 'null';
}

/**
 * What a variable declarator binds: a function value is a `def`, a literal stays its own, and a TypeScript type
 * annotation records the computed-write exemptions it gives.
 */
export function variableBinding(kind: 'const' | 'let' | 'var', node: Node, typescript: boolean, parameter: boolean, declared: ReadonlySet<string>): Binding {
  const value = node.childForFieldName('value');
  const alias = value && !parameter ? aliasName(value) : undefined;
  const literal = kind === 'const' && literalValue(value);
  const exempt = typescript && !literal ? exemptKinds(node.childForFieldName('type'), declared) : [];
  if (literal) return { kind: 'other', literal: true };
  if (alias) return { kind: 'other', alias, ...(exempt.length && { exempt }) };
  return exempt.length ? { kind: 'other', exempt } : OTHER;
}

/** An enum body: every member name is bound there for the initializers, and a member is no callable function. */
export function declareEnum(api: ScopeApi, node: Node, scope: Scope, strict: boolean): void {
  const name = node.childForFieldName('name');
  if (name) api.add(scope, name.text, OTHER);
  const body = node.childForFieldName('body');
  if (!body) return;
  const inner = api.make('block', body, scope, strict);
  for (const member of body.namedChildren) {
    if (!member) continue;
    const memberName = member.type === 'enum_assignment' ? member.childForFieldName('name') : member;
    if (memberName && (member.type === 'enum_assignment' || member.type === 'property_identifier' || member.type === 'identifier' || member.type === 'string')) {
      api.add(inner, memberName.text.replace(/^['"]|['"]$/g, ''), OTHER);
    }
  }
  api.children(body, inner, strict);
}

/** A namespace or ambient module body: its members are a scope, and an unbound name there is `other`. */
export function declareModule(api: ScopeApi, node: Node, scope: Scope, strict: boolean): void {
  const name = node.childForFieldName('name');
  if (name && name.type !== 'string') {
    const first = name.type === 'nested_identifier' ? name.namedChildren[0] : name;
    if (first) api.add(scope, first.text, OTHER);
  }
  const body = node.childForFieldName('body');
  if (body) namespaceBlock(api, body, scope, strict);
}

/** A namespace body: its members are a block scope whose `var` declarations stay inside it. */
export function namespaceBlock(api: ScopeApi, node: Node, scope: Scope, strict: boolean): void {
  const inner = api.make('block', node, scope, strict);
  inner.namespace = true;
  inner.varBoundary = true;
  api.children(node, inner, strict);
}

/** A `catch` clause: its parameter binds in a block scope around its body. */
export function walkCatch(api: ScopeApi, node: Node, scope: Scope, strict: boolean): void {
  const inner = api.make('block', node, scope, strict);
  const parameter = node.childForFieldName('parameter');
  for (const name of patternNames(parameter)) api.add(inner, name, OTHER);
  if (parameter) api.children(parameter, inner, strict);
  const body = node.childForFieldName('body');
  // The body is an ordinary nested block: a function declared in it is one for Annex B too.
  if (body) api.walk(body, inner, strict);
}

/** The head of a `for` is a block scope; `let`/`const` bind there, `var` in the enclosing function. */
export function walkFor(api: ScopeApi, node: Node, scope: Scope, strict: boolean): void {
  const inner = api.make('block', node, scope, strict);
  const left = node.childForFieldName('left');
  const kind = node.childForFieldName('kind');
  if (left && kind) {
    const target = kind.type === 'var' ? api.varScope(inner) : inner;
    for (const name of patternNames(left)) api.add(target, name, OTHER);
  }
  api.children(node, inner, strict);
}

/** Marks the variable scope of each sloppy direct `eval`, and every scope around it, so their names prove nothing. */
export function markEvals(root: Node, nearestScope: (node: Node) => Scope | undefined, varScope: (scope: Scope) => Scope): void {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    const fn = node.type === 'call_expression' ? node.childForFieldName('function') : undefined;
    if (fn?.type === 'identifier' && fn.text === 'eval') {
      const scope = nearestScope(node);
      if (scope && !scope.strict) for (let owner: Scope | undefined = varScope(scope); owner; owner = owner.parent) owner.evalTainted = true;
    }
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
}

/** Whether `name` at `node` is one `const` binding of an object literal, array literal or `Object.create(null)`. */
export function isLocalLiteral(node: Node, name: string, nearestScope: (node: Node) => Scope | undefined): boolean {
  for (let scope = nearestScope(node); scope; scope = scope.parent) {
    const entries = scope.decls.get(name);
    if (!entries) continue;
    return entries.length === 1 && !!entries[0]!.literal && !entries[0]!.written;
  }
  return false;
}

/** The exemption the one binding of `name` nearest `node` declares, when its TypeScript annotation gives one. */
export function exemptAt(node: Node, name: string, nearestScope: (node: Node) => Scope | undefined): readonly ExemptKind[] | undefined {
  for (let scope = nearestScope(node); scope; scope = scope.parent) {
    const entries = scope.decls.get(name);
    if (!entries) continue;
    return entries.length === 1 ? entries[0]!.exempt : undefined;
  }
  return undefined;
}

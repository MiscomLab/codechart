import type { Node } from 'web-tree-sitter';
import { aliasName, patternNames, unwrapExpression } from './js-scope-decl.js';
import type { Binding, Scope } from './js-scope-model.js';
import { literalKey } from './js-writes.js';

/** The scope work that is not a handler: enum bodies, namespaces, `catch` and `for` heads and constant keys. */

const OTHER: Binding = { kind: 'other' };

/** What the scope builder offers these helpers; `Scopes` passes its own bound methods. */
export interface ScopeApi {
  make: (kind: Scope['kind'], node: Node, parent: Scope | undefined, strict: boolean) => Scope;
  add: (scope: Scope, name: string, binding: Binding) => void;
  children: (node: Node, scope: Scope, strict: boolean) => void;
  walk: (node: Node, scope: Scope, strict: boolean) => void;
  varScope: (scope: Scope) => Scope;
}

/** The constant a `const` initializer proves: a string literal, or a `Symbol()` / `Symbol.for(…)` call. */
function constantOf(value: Node, declarator: Node): Binding['constant'] {
  const literal = literalKey(value);
  if (literal !== undefined) return { key: { kind: 'string', value: literal }, at: declarator };
  const call = unwrapExpression(value);
  const fn = call?.type === 'call_expression' ? call.childForFieldName('function') : undefined;
  const symbol = fn?.type === 'identifier' ? fn.text === 'Symbol' : fn?.type === 'member_expression' && fn.text === 'Symbol.for';
  return symbol ? { key: { kind: 'symbol' }, at: declarator } : undefined;
}

/** What a variable declarator binds: a name another binding holds, or a `const` string or symbol key. */
export function variableBinding(node: Node, parameter: boolean, constant: boolean): Binding {
  const value = node.childForFieldName('value');
  if (!value || parameter) return OTHER;
  const alias = aliasName(value);
  if (alias) return { kind: 'other', alias };
  const key = constant ? constantOf(value, node) : undefined;
  return key ? { kind: 'other', constant: key } : OTHER;
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

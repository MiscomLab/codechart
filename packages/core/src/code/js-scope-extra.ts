import type { Node } from 'web-tree-sitter';
import { aliasName, patternNames, unwrapExpression } from './js-scope-decl.js';
import type { Binding, FreshInit, Scope } from './js-scope-model.js';
import { exemptKinds, type ExemptKind } from './js-types.js';

/** The scope work that is not a handler: enum bodies, sloppy `eval` taints and fresh locals. */

const OTHER: Binding = { kind: 'other' };

/** What the scope builder offers these helpers; `Scopes` passes its own bound methods. */
export interface ScopeApi {
  make: (kind: Scope['kind'], node: Node, parent: Scope | undefined, strict: boolean) => Scope;
  add: (scope: Scope, name: string, binding: Binding) => void;
  children: (node: Node, scope: Scope, strict: boolean) => void;
  walk: (node: Node, scope: Scope, strict: boolean) => void;
  varScope: (scope: Scope) => Scope;
}

/** The builtins whose instances start with their own elements and no class in their prototype chain. */
const FRESH_CONSTRUCTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

/** A plain property key's name: the string a quoted key states, else the key's own text. */
const plainKey = (key: Node | null | undefined): string | undefined =>
  key?.type === 'string' ? (key.namedChildren.find((child) => child?.type === 'string_fragment')?.text ?? '') : key?.text;

/** Whether an object literal sets its own prototype through a plain `__proto__` key. */
const setsPrototype = (node: Node): boolean =>
  node.namedChildren.some((entry) => !!entry && entry.type === 'pair' && entry.childForFieldName('key')?.type !== 'computed_property_name' && plainKey(entry.childForFieldName('key')) === '__proto__');

/** Whether an object or array literal target gives a binding its own elements. */
const ownsElements = (node: Node | undefined): boolean => node?.type === 'array' || (node?.type === 'object' && !setsPrototype(node));

/** The fresh kind a `new Map`/`Set`/`WeakMap`/`WeakSet` initializer gives, or undefined. */
function freshNew(node: Node): { kind: FreshInit['kind']; globals: string[] } | undefined {
  const constructor = node.childForFieldName('constructor');
  return constructor?.type === 'identifier' && FRESH_CONSTRUCTORS.has(constructor.text) ? { kind: 'literal', globals: [constructor.text] } : undefined;
}

/** The fresh kind an `Object.create(null)` or `Object.assign(<fresh literal>, …)` call gives, or undefined. */
function freshCall(node: Node): { kind: FreshInit['kind']; globals: string[] } | undefined {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'member_expression' || fn.childForFieldName('object')?.text !== 'Object') return undefined;
  const args = node.childForFieldName('arguments')?.namedChildren ?? [];
  const property = fn.childForFieldName('property')?.text;
  if (property === 'create') return args.length === 1 && args[0]?.type === 'null' ? { kind: 'literal', globals: ['Object'] } : undefined;
  return property === 'assign' && ownsElements(unwrapExpression(args[0])) ? { kind: 'assign', globals: ['Object'] } : undefined;
}

/** The fresh kind and the builtin names an initializer names, or undefined when the binding may not own its elements. */
function freshInitializer(value: Node | null | undefined): { kind: FreshInit['kind']; globals: string[] } | undefined {
  const node = unwrapExpression(value);
  if (node?.type === 'object') return setsPrototype(node) ? undefined : { kind: 'literal', globals: [] };
  if (node?.type === 'array') return { kind: 'literal', globals: [] };
  if (node?.type === 'new_expression') return freshNew(node);
  return node?.type === 'call_expression' ? freshCall(node) : undefined;
}

/**
 * What a variable declarator binds: a function value is a `def`, a fresh initializer stays its own, and a TypeScript
 * type annotation records the computed-write exemptions it gives.
 */
export function variableBinding(node: Node, typescript: boolean, parameter: boolean, declared: ReadonlySet<string>): Binding {
  const value = node.childForFieldName('value');
  const fresh = parameter ? undefined : freshInitializer(value);
  const alias = !fresh && value && !parameter ? aliasName(value) : undefined;
  const exempt = typescript && !fresh ? exemptKinds(node.childForFieldName('type'), declared) : [];
  if (fresh) return { kind: 'other', fresh: { ...fresh, at: node } };
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

/** The fresh kind of the one unwritten binding of `name` nearest `node`, when no eval or declaration shadows its builtins. */
export function freshAt(node: Node, name: string, nearestScope: (node: Node) => Scope | undefined): FreshInit['kind'] | undefined {
  for (let scope = nearestScope(node); scope; scope = scope.parent) {
    const entries = scope.decls.get(name);
    if (!entries) continue;
    const fresh = entries.length === 1 && !entries[0]!.written ? entries[0]!.fresh : undefined;
    if (!fresh) return undefined;
    for (let owner = nearestScope(fresh.at); owner; owner = owner.parent) {
      // A sloppy direct eval may rebind the name or declare one of the builtins the initializer relies on.
      if (owner.evalTainted || fresh.globals.some((global) => owner.decls.has(global))) return undefined;
    }
    return fresh.kind;
  }
  return undefined;
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

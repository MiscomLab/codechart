import type { Node } from 'web-tree-sitter';
import type { JsScopeReader } from './js-scope.js';
import { thisFieldKinds, type ExemptKind } from './js-types.js';
import { augmentedSafe, builtinCall, inner, keyName, keySafe, ownProtoHazard, stringValue, valueSafe, WRAPPERS } from './js-writes.js';
import type { ClassInfo, CodeRange, CodeSymbol, Import } from './model.js';
import { nodeRange } from './tree.js';

/** Destructuring a write target may sit in: `[x.f] = …`, `({ a: x.f } = …)`. */
const TARGET_PATTERNS = new Set(['array_pattern', 'object_pattern', 'pair_pattern', 'rest_pattern', 'assignment_pattern', 'object_assignment_pattern']);

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression']);

/** Whether a member or subscript expression's receiver is `this`, through any cast. */
function onThis(node: Node): boolean {
  const object = node.type === 'member_expression' || node.type === 'subscript_expression' ? node.childForFieldName('object') : undefined;
  return inner(object)?.type === 'this';
}

/** The member name a write target names, `*` for a computed subscript, or undefined when it names no member. */
function writtenMember(target: Node | null | undefined): string | undefined {
  const node = inner(target);
  if (!node) return undefined;
  if (node.type === 'member_expression') return (node.childForFieldName('property')?.text ?? '*').replace(/^#/, '');
  if (node.type === 'subscript_expression') return stringValue(node.childForFieldName('index')) ?? '*';
  return undefined;
}

/** A binding initialized to a fresh object: `literal` for its own literal/container, `assign` for `Object.assign(…)`. */
export type FreshReceiver = (node: Node, name: string) => 'literal' | 'assign' | undefined;

/** The exemption a receiver's declared TypeScript type gives a computed write, when it cannot hold a class instance. */
export type TypedReceiver = (node: Node, name: string) => readonly ExemptKind[] | undefined;

/** The keys an object literal binds, or undefined when the value is not one; a spread may add any key. */
function objectKeys(node: Node | null | undefined): string[] | undefined {
  if (node?.type !== 'object') return undefined;
  const keys: string[] = [];
  for (const entry of node.namedChildren) {
    if (!entry) continue;
    if (entry.type === 'pair') keys.push(keyName(entry.childForFieldName('key')));
    else if (entry.type === 'method_definition') keys.push(keyName(entry.childForFieldName('name')));
    else if (entry.type === 'shorthand_property_identifier' || entry.type === 'shorthand_property_identifier_pattern') keys.push(entry.text);
    else if (entry.type === 'spread_element') keys.push('*');
  }
  return keys;
}

/** The member names `Object.assign` rebinds: a fresh-literal target owns its keys until the own-`__proto__` guard trips. */
function assignedNames(args: readonly Node[]): string[] {
  const target = inner(args[0]);
  return target?.type === 'object' || target?.type === 'array' ? ['*assign'] : args.slice(1).flatMap((arg) => objectKeys(arg) ?? ['*']);
}

/** The member names a call rebinds through `Object.defineProperty`/`assign`/`defineProperties` or a `Reflect` write. */
function reflectiveNames(node: Node): string[] {
  const parts = builtinCall(node);
  if (!parts) return [];
  const [builtin, fn] = parts;
  const args = node.childForFieldName('arguments')?.namedChildren.filter((c): c is Node => !!c) ?? [];
  const key = args[1] ? (stringValue(args[1]) ?? '*') : '*';
  if (builtin === 'Object' && fn === 'defineProperty') return [key];
  if (builtin === 'Object' && fn === 'defineProperties') return args[1] ? (objectKeys(args[1]) ?? ['*']) : ['*'];
  if (builtin === 'Object' && fn === 'assign') return assignedNames(args);
  if (builtin === 'Reflect' && (fn === 'defineProperty' || fn === 'set' || fn === 'deleteProperty')) return [key];
  return [];
}

/**
 * What a computed write's receiver proves: a fresh local's kind, the exemptions a declared type gives, or undefined
 * when the key may name a member.
 */
function computedReceiver(node: Node, fresh: FreshReceiver, typed: TypedReceiver | undefined, typescript: boolean, declared: ReadonlySet<string>): readonly ExemptKind[] | 'literal' | 'assign' | undefined {
  const object = inner(node.childForFieldName('object'));
  if (object?.type === 'identifier') return fresh(object, object.text) ?? typed?.(object, object.text);
  return object?.type === 'member_expression' && typescript ? thisFieldKinds(object, node, declared) : undefined;
}

/** One member-write walk: where names go, whether only `this` counts, and the receiver exemptions to read. */
interface WriteContext {
  names: string[];
  onlyThis: boolean;
  fresh: FreshReceiver;
  typed: TypedReceiver | undefined;
  typescript: boolean;
  declared: ReadonlySet<string>;
}

/** Records one write target; its value cannot carry a class prototype when `safe`. */
function addTarget(target: Node | null | undefined, safe: boolean, ctx: WriteContext): void {
  const node = inner(target);
  if (!node) return;
  if (TARGET_PATTERNS.has(node.type)) {
    for (const child of node.namedChildren) addTarget(child, false, ctx);
    return;
  }
  if (node.type === 'subscript_expression' && stringValue(node.childForFieldName('index')) === undefined) {
    const exempt = computedReceiver(node, ctx.fresh, ctx.typed, ctx.typescript, ctx.declared);
    const kind = exempt === 'literal' || exempt === 'assign' ? exempt : undefined;
    if (kind && (safe || keySafe(node.childForFieldName('index')))) {
      if (!ctx.onlyThis && kind === 'assign') ctx.names.push('*assign');
      return;
    }
    if (Array.isArray(exempt) && exempt.length) {
      if (!ctx.onlyThis) for (const exemptKind of exempt) ctx.names.push(`*${exemptKind}`);
      return;
    }
  }
  const name = writtenMember(node);
  if (name && (!ctx.onlyThis || onThis(node))) ctx.names.push(name);
}

/**
 * Every member name the file's writes rebind: `x.f =`, `x.f +=`, `x.f++`, `x['f'] =`, a computed subscript (`*`),
 * inside a destructuring pattern and through a cast; `delete x.f`, `delete x[k]`, and the reflective
 * `Object.defineProperty`/`assign`/`defineProperties` and `Reflect` writes. `onlyThis` keeps the ones written on `this`.
 * A computed subscript on a fresh local rebinds no class member only when its key cannot be `"__proto__"` or its value
 * cannot carry a class prototype; a write on an `Object.assign`-initialized one is a `*assign` marker, which dispatch
 * turns back into `*` only when its repo-wide guard trips. A declared TypeScript type that cannot hold a class instance
 * is a `*record`/`*container` marker, handled the same way.
 */
function writeNames(root: Node, onlyThis: boolean, fresh: FreshReceiver, typed: TypedReceiver | undefined, typescript: boolean, declared: ReadonlySet<string>): string[] {
  const ctx: WriteContext = { names: [], onlyThis, fresh, typed, typescript, declared };
  const visit = (node: Node): void => {
    if (node.type === 'assignment_expression') addTarget(node.childForFieldName('left'), valueSafe(node.childForFieldName('right')), ctx);
    else if (node.type === 'augmented_assignment_expression') addTarget(node.childForFieldName('left'), augmentedSafe(node), ctx);
    else if (node.type === 'update_expression') addTarget(node.namedChildren[0], true, ctx);
    else if (node.type === 'for_in_statement' && !node.childForFieldName('kind')) addTarget(node.childForFieldName('left'), node.childForFieldName('operator')?.text === 'in', ctx);
    else if (node.type === 'unary_expression' && node.children.some((child) => child?.type === 'delete')) addTarget(node.namedChildren[0], true, ctx);
    else if (node.type === 'call_expression') for (const name of reflectiveNames(node)) ctx.names.push(name);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return ctx.names;
}

/** Every member name any write of the file rebinds, through `this` or any other object. */
export function javascriptMemberWrites(root: Node, fresh: FreshReceiver, typed: TypedReceiver | undefined, typescript: boolean, declared: ReadonlySet<string>): string[] {
  const names = writeNames(root, false, fresh, typed, typescript, declared);
  return ownProtoHazard(root) ? [...names, '*ownproto'] : names;
}

/** The identifiers an `extends` expression names: a plain one through the scopes, the last one of `a.B`, all of `M(B)`. */
function baseNames(value: Node | null | undefined, resolve: (node: Node) => string): string[] {
  if (!value) return [];
  if (value.type === 'identifier' || value.type === 'type_identifier') return [resolve(value)];
  if (value.type === 'member_expression') return [value.childForFieldName('property')?.text ?? ''].filter(Boolean);
  if (WRAPPERS.has(value.type)) return baseNames(value.namedChildren.find((child) => child?.type !== 'type_arguments'), resolve);
  return value.namedChildren.flatMap((child) => (child ? baseNames(child, resolve) : []));
}

/** Whether an `extends` expression is not a (dotted) name: a call, subscript, conditional or other value is opaque. */
function opaqueBase(value: Node | null | undefined): boolean {
  if (!value) return false;
  const node = WRAPPERS.has(value.type) ? (value.namedChildren.find((child) => child?.type !== 'type_arguments') ?? value) : value;
  return node.type !== 'identifier' && node.type !== 'type_identifier' && node.type !== 'member_expression';
}

/**
 * The expression a class extends: TypeScript wraps it in an `extends_clause`, JavaScript does not. An `implements`
 * clause is erased at run time, so it is no base: `class K implements I` extends nothing, `extends X implements I` X.
 */
function heritage(node: Node): Node | undefined {
  const clause = node.namedChildren.find((child) => child?.type === 'class_heritage');
  if (!clause) return undefined;
  const first = clause.namedChildren[0];
  if (!first || first.type === 'implements_clause') return undefined;
  return first.type === 'extends_clause' ? (first.childForFieldName('value') ?? undefined) : first;
}

/** A base name followed through a value import or a local alias to the class it names, from the scopes at `at`. */
function canonicalBase(name: string, at: Node, scopes: JsScopeReader, imports: readonly Import[], seen = new Set<string>()): string {
  if (seen.has(name)) return name;
  seen.add(name);
  const meaning = scopes.meaningAt(at, name);
  if (meaning.kind === 'import') {
    const imported = imports.filter((imp) => imp.kind === 'import').flatMap((imp) => (imp.names ?? []).filter((bound) => bound.local === name && bound.imported !== '*'));
    return imported.length === 1 ? canonicalBase(imported[0]!.imported, at, scopes, imports, seen) : name;
  }
  return meaning.kind === 'alias' ? canonicalBase(meaning.name, at, scopes, imports, seen) : name;
}

/** A member's declared name; a computed name may be any, so it is `*`. */
function memberName(member: Node): string | undefined {
  const name = member.childForFieldName('name') ?? member.childForFieldName('property');
  if (!name) return undefined;
  return name.type === 'computed_property_name' ? '*' : name.text.replace(/^#/, '');
}

/** Whether a member declares a body `this.f()` can call: a getter's value or an abstract/signature is not one. */
function callableMember(member: Node): boolean {
  if (member.type === 'abstract_method_signature' || member.type === 'method_signature') return false;
  if (member.type === 'method_definition') return !member.children.some((child) => child?.type === 'get' || child?.type === 'set');
  if (member.type === 'public_field_definition' || member.type === 'field_definition') {
    const value = member.childForFieldName('value');
    return !!value && FUNCTION_VALUES.has(value.type);
  }
  return true;
}

const FIELD_TYPES = new Set(['public_field_definition', 'field_definition']);

const isStatic = (member: Node): boolean => member.children.some((child) => child?.type === 'static');

/** A member whose initializer runs with `this` bound to the constructor, where `this.name()` reaches a static one. */
const staticContext = (member: Node): boolean => member.type === 'class_static_block' || (FIELD_TYPES.has(member.type) && isStatic(member));

/** What a class body declares: the member names, its statics, the members without a callable body, and its static ranges. */
function classMembers(body: Node): Pick<ClassInfo, 'members' | 'statics' | 'nonCallable' | 'staticRanges' | 'indexSignature'> {
  const members: string[] = [];
  const statics: string[] = [];
  const nonCallable: string[] = [];
  const staticRanges: CodeRange[] = [];
  const indexSignature = body.namedChildren.some((member) => member?.type === 'index_signature');
  for (const member of body.namedChildren) {
    if (!member) continue;
    if (staticContext(member)) staticRanges.push(nodeRange(member));
    const name = memberName(member);
    if (!name) continue;
    members.push(name);
    if (isStatic(member)) statics.push(name);
    if (!callableMember(member)) nonCallable.push(name);
  }
  return { members, ...(statics.length && { statics }), ...(nonCallable.length && { nonCallable }), ...(staticRanges.length && { staticRanges }), ...(indexSignature && { indexSignature }) };
}

/** Whether a member access sits in call position (`X.m()`), where it calls rather than escapes as a value. */
function inCallPosition(node: Node): boolean {
  const parent = node.parent;
  return parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === node.id;
}

/** Whether a node sits in a write target, so a member in it is written rather than read as a value. */
function inWriteTarget(node: Node): boolean {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type === 'assignment_expression' || parent.type === 'augmented_assignment_expression') return parent.childForFieldName('left')?.id === child.id;
    if (parent.type === 'unary_expression' && parent.children.some((c) => c?.type === 'delete')) return true;
    if (parent.type === 'for_in_statement' && !parent.childForFieldName('kind')) return parent.childForFieldName('left')?.id === child.id;
  }
  return false;
}

/** The member name an expression names, through casts, when it is a member or string-keyed subscript. */
const memberNameOf = (node: Node | null | undefined): string | undefined => {
  const target = inner(node);
  if (target?.type === 'member_expression') return target.childForFieldName('property')?.text.replace(/^#/, '');
  return target?.type === 'subscript_expression' ? stringValue(target.childForFieldName('index')) : undefined;
};

/** The member name an access reads as a value, or undefined when it is called (`X.m()`) or written (`X.m = …`). */
function escapedMember(node: Node): string | undefined {
  if (node.type !== 'member_expression' || inCallPosition(node) || inWriteTarget(node)) return undefined;
  return node.childForFieldName('property')?.text.replace(/^#/, '');
}

/** Prototype hazards at a node: `*` for anything that changes an object's whole prototype chain. */
function prototypeHazards(node: Node): string[] {
  const out: string[] = [];
  if (node.type === 'pair' && keyName(node.childForFieldName('key')) === '__proto__') out.push('*');
  if (node.type === 'call_expression') {
    const parts = builtinCall(node);
    const args = node.childForFieldName('arguments')?.namedChildren.filter((c): c is Node => !!c) ?? [];
    const setPrototype = !!parts && parts[1] === 'setPrototypeOf' && (parts[0] === 'Object' || parts[0] === 'Reflect');
    const create = !!parts && parts[0] === 'Object' && parts[1] === 'create' && args[0]?.type !== 'null';
    if (setPrototype || create) out.push('*');
  }
  if ((node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') && memberNameOf(node.childForFieldName('left')) === '__proto__') out.push('*');
  return out;
}

/**
 * The member names whose function object is read as a value anywhere in the file: `X.m` outside call position,
 * `const g = K.prototype.m`. Such a method may run with another `this`, so `this.member()` inside it proves nothing.
 * `Object.setPrototypeOf`, `Reflect.setPrototypeOf`, `Object.create(<not null>)` and a `__proto__` key or write change
 * an object's whole prototype chain, which is `*`.
 */
export function javascriptEscapes(root: Node): string[] {
  const names: string[] = [];
  const visit = (node: Node): void => {
    const member = escapedMember(node);
    if (member) names.push(member);
    names.push(...prototypeHazards(node));
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return names;
}

/** Every class and class expression of a JavaScript or TypeScript file, with what it extends, declares and writes. */
export function javascriptClasses(root: Node, symbols: readonly CodeSymbol[], imports: readonly Import[], scopes: JsScopeReader): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    for (const child of node.namedChildren) if (child) stack.push(child);
    if (node.type !== 'class_declaration' && node.type !== 'class' && node.type !== 'abstract_class_declaration') continue;
    const body = node.childForFieldName('body');
    if (!body) continue;
    const declared = node.childForFieldName('name')?.text ?? (node.parent?.type === 'variable_declarator' ? node.parent.childForFieldName('name')?.text : undefined) ?? '';
    const range = nodeRange(node);
    const symbol = symbols
      .filter((s) => s.kind === 'class' && s.path.at(-1) === declared && s.range.start.line <= range.start.line && s.range.end.line >= range.end.line)
      .sort((x, y) => y.range.start.line - x.range.start.line)[0];
    const value = heritage(node);
    classes.push({
      ...(symbol && { id: symbol.id }),
      name: declared,
      bases: baseNames(value, (base) => (value ? canonicalBase(base.text, value, scopes, imports) : base.text)),
      ...classMembers(body),
      ...(value && opaqueBase(value) && { opaqueBase: true }),
      writes: writeNames(body, true, (at, name) => scopes.freshLocal(at, name), undefined, scopes.typescript, scopes.typeNames),
    });
  }
  return classes;
}

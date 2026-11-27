import type { Node } from 'web-tree-sitter';
import type { JsScopeReader } from './js-scope.js';
import { inner, literalKey, propertyKey, stringValue, WRAPPERS, writeSites } from './js-writes.js';
import type { ClassInfo, CodeRange, CodeSymbol, Import } from './model.js';
import { nodeRange } from './tree.js';

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression']);

/** The well-known symbols a computed class member can be keyed by: none of them is a string a call can name. */
const WELL_KNOWN_SYMBOLS = new Set([
  'asyncIterator', 'hasInstance', 'isConcatSpreadable', 'iterator', 'match', 'matchAll', 'replace', 'search', 'species', 'split', 'toPrimitive', 'toStringTag', 'unscopables', 'dispose', 'asyncDispose',
]);

/** The names a class body binds to `this` (`const self = this`, `self = this`), so a write on one is the class's own. */
function thisAliases(body: Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    const target = node.type === 'variable_declarator' ? node.childForFieldName('name') : node.type === 'assignment_expression' ? node.childForFieldName('left') : undefined;
    const value = node.type === 'variable_declarator' ? node.childForFieldName('value') : node.childForFieldName('right');
    if (target?.type === 'identifier' && inner(value)?.type === 'this') names.add(target.text);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(body);
  return names;
}

/**
 * The member names a class body writes on itself: through `this`, `super` or a local bound to `this`, in any method,
 * constructor, field initializer, static block or nested function, including the reflective `Object.defineProperty`,
 * `Object.assign` and `Reflect` writes with a literal name.
 */
function ownWrites(body: Node, scopes: JsScopeReader): string[] {
  const aliases = thisAliases(body);
  return writeSites(body, scopes)
    .filter(({ receiver }) => {
      const node = inner(receiver);
      return node?.type === 'this' || node?.type === 'super' || (node?.type === 'identifier' && aliases.has(node.text));
    })
    .map(({ name }) => name);
}

/** The identifiers an `extends` expression names: a plain one through the scopes, the last one of `a.B`, all of `M(B)`. */
function baseNames(value: Node | null | undefined, resolve: (node: Node) => string): string[] {
  if (!value) return [];
  if (value.type === 'identifier' || value.type === 'type_identifier') return [resolve(value)];
  if (value.type === 'member_expression') return [value.childForFieldName('property')?.text ?? ''].filter(Boolean);
  if (WRAPPERS.has(value.type)) return baseNames(value.namedChildren.find((child) => child?.type !== 'type_arguments'), resolve);
  return value.namedChildren.flatMap((child) => (child ? baseNames(child, resolve) : []));
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

/**
 * A computed member's recorded name: the string a key proves (a literal, a template without substitutions, a `const`
 * bound to one), nothing for a key proved a symbol (a well-known `Symbol.x`, a `const` bound to `Symbol()`), and `*`
 * for any other key, which may be any name.
 */
function computedName(key: Node | undefined, scopes: JsScopeReader): string | undefined {
  const expr = inner(key);
  if (!expr) return '*';
  const literal = literalKey(expr);
  if (literal !== undefined) return literal;
  if (expr.type === 'identifier') {
    const constant = scopes.constantAt(expr, expr.text);
    if (constant) return constant.kind === 'string' ? constant.value : undefined;
  }
  const global = expr.type === 'member_expression' && expr.childForFieldName('object')?.text === 'Symbol' && scopes.meaningAt(expr, 'Symbol').kind === 'none';
  return global && WELL_KNOWN_SYMBOLS.has(expr.childForFieldName('property')?.text ?? '') ? undefined : '*';
}

/**
 * A member's declared name: a quoted name unquoted with its escapes decoded (`*` when one cannot be), a private name
 * with its `#`; undefined for a computed key proved a symbol and for the constructor spelled as a string.
 */
function memberName(member: Node, scopes: JsScopeReader): string | undefined {
  const name = member.childForFieldName('name') ?? member.childForFieldName('property');
  if (!name) return undefined;
  if (name.type === 'computed_property_name') return computedName(name.namedChildren[0] ?? undefined, scopes);
  if (name.type !== 'string') return propertyKey(name);
  const value = stringValue(name);
  return value === 'constructor' && member.type === 'method_definition' && !isStatic(member) ? undefined : (value ?? '*');
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

/** A member that runs with `this` bound to the constructor, where `this.name()` reaches a static one. */
const staticContext = (member: Node): boolean => member.type === 'class_static_block' || ((FIELD_TYPES.has(member.type) || member.type === 'method_definition') && isStatic(member));

/** What a class body declares: the member names, its statics, the members without a callable body, and the ranges where `this` is the constructor. */
function classMembers(body: Node, scopes: JsScopeReader): Pick<ClassInfo, 'members' | 'statics' | 'nonCallable' | 'staticRanges'> {
  const members: string[] = [];
  const statics: string[] = [];
  const nonCallable: string[] = [];
  const staticRanges: CodeRange[] = [];
  for (const member of body.namedChildren) {
    if (!member) continue;
    if (staticContext(member)) staticRanges.push(nodeRange(member));
    const name = memberName(member, scopes);
    if (!name) continue;
    members.push(name);
    if (isStatic(member)) statics.push(name);
    if (!callableMember(member)) nonCallable.push(name);
  }
  return { members, ...(statics.length && { statics }), ...(nonCallable.length && { nonCallable }), ...(staticRanges.length && { staticRanges }) };
}

/** The member methods of a class body, each with the symbol the file's symbol table holds for it. */
function classMethods(body: Node, symbols: ReadonlyMap<string, CodeSymbol>, scopes: JsScopeReader): NonNullable<ClassInfo['methods']> {
  const out: NonNullable<ClassInfo['methods']> = [];
  for (const member of body.namedChildren) {
    const name = member ? memberName(member, scopes) : undefined;
    const start = member ? nodeRange(member).start : undefined;
    const symbol = start ? symbols.get(`${start.line}:${start.column}`) : undefined;
    if (member && name && name !== '*' && symbol) out.push({ name, id: symbol.id, ...(isStatic(member) && { static: true }) });
  }
  return out;
}

/** Every class and class expression of a JavaScript or TypeScript file, with what it extends, declares and writes. */
export function javascriptClasses(root: Node, symbols: readonly CodeSymbol[], imports: readonly Import[], scopes: JsScopeReader): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const methodSymbols = new Map(symbols.filter((s) => s.kind === 'method').map((s) => [`${s.range.start.line}:${s.range.start.column}`, s]));
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
      range,
      bases: baseNames(value, (base) => (value ? canonicalBase(base.text, value, scopes, imports) : base.text)),
      ...classMembers(body, scopes),
      writes: ownWrites(body, scopes),
      methods: classMethods(body, methodSymbols, scopes),
    });
  }
  return classes;
}

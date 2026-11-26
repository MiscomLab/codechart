import type { Node } from 'web-tree-sitter';
import type { JsScopeReader } from './js-scope.js';
import type { ClassInfo, CodeRange, CodeSymbol, Import } from './model.js';
import { nodeRange } from './tree.js';

/** Expressions a write target may sit behind: a cast or a parenthesized member is still that member. */
const WRAPPERS = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'type_assertion']);

/** Destructuring a write target may sit in: `[x.f] = …`, `({ a: x.f } = …)`. */
const TARGET_PATTERNS = new Set(['array_pattern', 'object_pattern', 'pair_pattern', 'rest_pattern', 'assignment_pattern', 'object_assignment_pattern']);

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression']);

/** A node with the casts and parentheses around it removed. */
function inner(node: Node | null | undefined): Node | undefined {
  if (!node) return undefined;
  return WRAPPERS.has(node.type) ? inner(node.namedChildren[0]) : node;
}

/** A plain string literal's text (`'f'` → `f`), or undefined for a key only the run time knows. */
function stringValue(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'string') return undefined;
  return node.namedChildren.find((child) => child?.type === 'string_fragment')?.text ?? node.text.replace(/^['"]|['"]$/g, '');
}

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

/**
 * Every member name the file's writes rebind: `x.f =`, `x.f +=`, `x.f++`, `x['f'] =`, a computed subscript (`*`),
 * inside a destructuring pattern and through a cast. `onlyThis` keeps the ones written on `this`.
 */
function writeNames(root: Node, onlyThis: boolean): string[] {
  const names: string[] = [];
  const add = (target: Node | null | undefined): void => {
    const node = inner(target);
    if (!node) return;
    if (TARGET_PATTERNS.has(node.type)) {
      for (const child of node.namedChildren) add(child);
      return;
    }
    const name = writtenMember(node);
    if (name && (!onlyThis || onThis(node))) names.push(name);
  };
  const visit = (node: Node): void => {
    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') add(node.childForFieldName('left'));
    else if (node.type === 'update_expression') add(node.namedChildren[0]);
    else if (node.type === 'for_in_statement' && !node.childForFieldName('kind')) add(node.childForFieldName('left'));
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return names;
}

/** Every member name any write of the file rebinds, through `this` or any other object. */
export function javascriptMemberWrites(root: Node): string[] {
  return writeNames(root, false);
}

/** The identifiers an `extends` expression names: a plain one through the scopes, the last one of `a.B`, all of `M(B)`. */
function baseNames(value: Node | null | undefined, resolve: (node: Node) => string): string[] {
  if (!value) return [];
  if (value.type === 'identifier' || value.type === 'type_identifier') return [resolve(value)];
  if (value.type === 'member_expression') return [value.childForFieldName('property')?.text ?? ''].filter(Boolean);
  return value.namedChildren.flatMap((child) => (child ? baseNames(child, resolve) : []));
}

/** The expression a class extends: TypeScript wraps it in an `extends_clause`, JavaScript does not. */
function heritage(node: Node): Node | undefined {
  const clause = node.namedChildren.find((child) => child?.type === 'class_heritage');
  if (!clause) return undefined;
  const first = clause.namedChildren[0];
  return first?.type === 'extends_clause' ? (first.childForFieldName('value') ?? undefined) : (first ?? undefined);
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
function classMembers(body: Node): Pick<ClassInfo, 'members' | 'statics' | 'nonCallable' | 'staticRanges'> {
  const members: string[] = [];
  const statics: string[] = [];
  const nonCallable: string[] = [];
  const staticRanges: CodeRange[] = [];
  for (const member of body.namedChildren) {
    if (!member) continue;
    if (staticContext(member)) staticRanges.push(nodeRange(member));
    const name = memberName(member);
    if (!name) continue;
    members.push(name);
    if (isStatic(member)) statics.push(name);
    if (!callableMember(member)) nonCallable.push(name);
  }
  return { members, ...(statics.length && { statics }), ...(nonCallable.length && { nonCallable }), ...(staticRanges.length && { staticRanges }) };
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
      writes: writeNames(body, true),
    });
  }
  return classes;
}

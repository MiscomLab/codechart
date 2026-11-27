import type { Node } from 'web-tree-sitter';

/**
 * The member writes a JS/TS file states by name (COD-59 compiler line): a computed write (`x[k] = v`) names no member,
 * so it records nothing; every other write is a name and the expression it is written on.
 */

/** Expressions a write target may sit behind: a cast or a parenthesized member is still that member. */
export const WRAPPERS = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'type_assertion']);

/** Destructuring a write target may sit in: `[x.f] = …`, `({ a: x.f } = …)`. */
const TARGET_PATTERNS = new Set(['array_pattern', 'object_pattern', 'pair_pattern', 'rest_pattern', 'assignment_pattern', 'object_assignment_pattern']);

/** A node with the casts and parentheses around it removed. */
export function inner(node: Node | null | undefined): Node | undefined {
  if (!node) return undefined;
  if (!WRAPPERS.has(node.type)) return node;
  // A `<T>x` assertion lists its type arguments before the expression.
  return inner(node.type === 'type_assertion' ? node.namedChildren.find((child) => child?.type !== 'type_arguments') : node.namedChildren[0]);
}

/** A plain string literal's text (`'f'` → `f`), or undefined for a key only the run time knows. */
function stringValue(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'string') return undefined;
  return node.namedChildren.find((child) => child?.type === 'string_fragment')?.text ?? node.text.replace(/^['"]|['"]$/g, '');
}

/** The key a string literal or a template without substitutions states, through casts. */
export function literalKey(node: Node | null | undefined): string | undefined {
  const key = inner(node);
  if (key?.type === 'string') return stringValue(key);
  return key?.type === 'template_string' && !key.namedChildren.some((child) => child?.type === 'template_substitution') ? key.text.slice(1, -1) : undefined;
}

/** The `Object.fn`/`Reflect.fn` a call applies, when the receiver is one of the two builtins. */
export function builtinCall(node: Node): [string, string] | undefined {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'member_expression') return undefined;
  const object = fn.childForFieldName('object');
  const property = fn.childForFieldName('property')?.text;
  if (object?.type !== 'identifier' || (object.text !== 'Object' && object.text !== 'Reflect') || !property) return undefined;
  return [object.text, property];
}

/** A property key's name when it is stated: a plain or literal-computed key; undefined for any other computed key. */
export function propertyKey(key: Node | null | undefined): string | undefined {
  if (!key) return undefined;
  if (key.type === 'computed_property_name') return literalKey(key.namedChildren[0]);
  return stringValue(key) ?? key.text.replace(/^#/, '');
}

/** The keys an object literal states; a spread or a computed key names none. */
function objectKeys(node: Node | null | undefined): string[] {
  const literal = inner(node);
  if (literal?.type !== 'object') return [];
  const keys: (string | undefined)[] = [];
  for (const entry of literal.namedChildren) {
    if (entry?.type === 'pair') keys.push(propertyKey(entry.childForFieldName('key')));
    else if (entry?.type === 'method_definition') keys.push(propertyKey(entry.childForFieldName('name')));
    else if (entry?.type === 'shorthand_property_identifier') keys.push(entry.text);
  }
  return keys.filter((key): key is string => key !== undefined);
}

/** One named write: the member it rebinds and the expression it is written on. */
export interface WriteSite {
  name: string;
  receiver: Node;
}

/** Records the named member a write target stands for, inside destructuring and through casts. */
function addTarget(target: Node | null | undefined, out: WriteSite[]): void {
  const node = inner(target);
  if (!node) return;
  if (TARGET_PATTERNS.has(node.type)) {
    for (const child of node.namedChildren) addTarget(child, out);
    return;
  }
  const receiver = node.type === 'member_expression' || node.type === 'subscript_expression' ? node.childForFieldName('object') : undefined;
  if (!receiver) return;
  const name = node.type === 'member_expression' ? node.childForFieldName('property')?.text.replace(/^#/, '') : literalKey(node.childForFieldName('index'));
  if (name !== undefined) out.push({ name, receiver });
}

/** The member names `Object.defineProperty`/`defineProperties`/`assign` and the `Reflect` writes rebind, on their first argument. */
function addReflective(node: Node, out: WriteSite[]): void {
  const parts = builtinCall(node);
  const args = node.childForFieldName('arguments')?.namedChildren.filter((c): c is Node => !!c) ?? [];
  if (!parts || !args[0]) return;
  const [builtin, fn] = parts;
  let names: (string | undefined)[] = [];
  if (fn === 'defineProperty' || (builtin === 'Reflect' && (fn === 'set' || fn === 'deleteProperty'))) names = [literalKey(args[1])];
  else if (builtin === 'Object' && fn === 'defineProperties') names = objectKeys(args[1]);
  else if (builtin === 'Object' && fn === 'assign') names = args.slice(1).flatMap((arg) => objectKeys(arg));
  for (const name of names) if (name !== undefined) out.push({ name, receiver: args[0] });
}

/**
 * Every named member write of a tree: `x.f =`, `x.f +=`, `x.f++`, `x['f'] =`, inside a destructuring pattern and
 * through a cast; `delete x.f`; and the reflective `Object.defineProperty`/`assign`/`defineProperties` and `Reflect`
 * writes with a literal name (`assign` and `defineProperties` only name the keys of a literal-object source).
 */
export function writeSites(root: Node): WriteSite[] {
  const out: WriteSite[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') addTarget(node.childForFieldName('left'), out);
    else if (node.type === 'update_expression') addTarget(node.namedChildren[0], out);
    else if (node.type === 'for_in_statement' && !node.childForFieldName('kind')) addTarget(node.childForFieldName('left'), out);
    else if (node.type === 'unary_expression' && node.children.some((child) => child?.type === 'delete')) addTarget(node.namedChildren[0], out);
    else if (node.type === 'call_expression') addReflective(node, out);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return out;
}

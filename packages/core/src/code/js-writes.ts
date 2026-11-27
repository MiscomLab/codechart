import type { Node } from 'web-tree-sitter';

/**
 * What one written key or value can be, for the member-write walk: a computed key that cannot be `"__proto__"`, a
 * value that cannot carry a class prototype, and the own-`__proto__` property a file can give an object.
 */

/** Expressions a write target may sit behind: a cast or a parenthesized member is still that member. */
export const WRAPPERS = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'type_assertion']);

/** Binary operators whose result is always a primitive, and the compound assignments that end in one. */
const PRIMITIVE_BINARY = new Set(['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', '+']);
const PRIMITIVE_ASSIGN = new Set(['+=', '-=', '*=', '/=', '%=', '**=', '|=', '&=', '^=', '<<=', '>>=', '>>>=']);
const PREFIX_SAFE_UNARY = new Set(['-', '+', '~']);
const VALUE_SAFE_TYPES = new Set(['number', 'string', 'template_string', 'regex', 'true', 'false', 'null', 'unary_expression', 'arrow_function', 'function_expression']);

/** A node with the casts and parentheses around it removed. */
export function inner(node: Node | null | undefined): Node | undefined {
  if (!node) return undefined;
  return WRAPPERS.has(node.type) ? inner(node.namedChildren[0]) : node;
}

/** A plain string literal's text (`'f'` → `f`), or undefined for a key only the run time knows. */
export function stringValue(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'string') return undefined;
  return node.namedChildren.find((child) => child?.type === 'string_fragment')?.text ?? node.text.replace(/^['"]|['"]$/g, '');
}

/** The key a property names, `*` when only the run time knows it. */
export function keyName(node: Node | null | undefined): string {
  if (!node) return '*';
  if (node.type === 'computed_property_name') return '*';
  return stringValue(node) ?? node.text.replace(/^#/, '');
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

/** Whether a computed key cannot be `"__proto__"`: a number, another string, a prefixed template or arithmetic. */
export function keySafe(key: Node | null | undefined): boolean {
  const node = inner(key);
  if (!node) return false;
  if (node.type === 'number') return true;
  if (node.type === 'string') return stringValue(node) !== '__proto__';
  if (node.type === 'template_string') {
    const first = node.namedChildren[0];
    return first?.type === 'string_fragment' && !!first.text && !'__proto__'.startsWith(first.text);
  }
  if (node.type === 'unary_expression') return PREFIX_SAFE_UNARY.has(node.childForFieldName('operator')?.text ?? '');
  if (node.type !== 'binary_expression' || node.childForFieldName('operator')?.text === '+') return false;
  return PRIMITIVE_BINARY.has(node.childForFieldName('operator')?.text ?? '');
}

/** Whether an object literal has no `__proto__` key, spread or computed key, so every value it holds is own data. */
function plainObject(node: Node): boolean {
  for (const entry of node.namedChildren) {
    if (!entry || entry.type === 'spread_element') return false;
    if (entry.type === 'pair' || entry.type === 'method_definition') {
      const key = entry.childForFieldName('key') ?? entry.childForFieldName('name');
      if (!key || key.type === 'computed_property_name' || keyName(key) === '__proto__') return false;
    } else if (entry.type.startsWith('shorthand_property_identifier') && entry.text === '__proto__') return false;
  }
  return true;
}

/** Whether a written value cannot carry a class prototype: a primitive, a plain object/array, a function or arithmetic. */
export function valueSafe(value: Node | null | undefined): boolean {
  const node = inner(value);
  if (!node) return false;
  if (node.type === 'object') return plainObject(node);
  if (node.type === 'array') return !node.namedChildren.some((child) => child?.type === 'spread_element');
  if (node.type === 'binary_expression') return !['&&', '||', '??'].includes(node.childForFieldName('operator')?.text ?? '');
  return VALUE_SAFE_TYPES.has(node.type);
}

/** Whether an augmented write's implied value cannot carry a class prototype. */
export function augmentedSafe(node: Node): boolean {
  const op = node.childForFieldName('operator')?.text ?? '';
  if (PRIMITIVE_ASSIGN.has(op)) return true;
  return (op === '??=' || op === '||=' || op === '&&=') && valueSafe(node.childForFieldName('right'));
}

/** Whether an object literal declares a `__proto__` key, plain or computed to that literal string. */
function hasProtoKey(node: Node): boolean {
  return node.namedChildren.some((entry) => {
    if (!entry || entry.type !== 'pair') return false;
    const key = entry.childForFieldName('key');
    return key?.type === 'computed_property_name' ? stringValue(key.namedChildren[0]) === '__proto__' : keyName(key) === '__proto__';
  });
}

/** Whether a node can give some object an own `__proto__` property, which `Object.assign` copies with [[Set]]. */
function protoHazard(node: Node): boolean {
  if (node.type === 'pair') {
    const key = node.childForFieldName('key');
    return key?.type === 'computed_property_name' && !keySafe(key.namedChildren[0]) && !valueSafe(node.childForFieldName('value'));
  }
  if (node.type !== 'call_expression') return false;
  const parts = builtinCall(node);
  if (!parts) return false;
  const [builtin, fn] = parts;
  const args = node.childForFieldName('arguments')?.namedChildren.filter((child): child is Node => !!child) ?? [];
  if (builtin === 'Object' && fn === 'fromEntries') return true;
  if ((builtin === 'Object' || builtin === 'Reflect') && fn === 'defineProperty') return stringValue(args[1]) === '__proto__';
  if (builtin !== 'Object' || fn !== 'defineProperties') return false;
  const descriptors = inner(args[1]);
  return descriptors?.type === 'object' && hasProtoKey(descriptors);
}

/** Whether the file anywhere gives an object an own `__proto__` property. */
export function ownProtoHazard(root: Node): boolean {
  if (protoHazard(root)) return true;
  return root.namedChildren.some((child) => !!child && ownProtoHazard(child));
}

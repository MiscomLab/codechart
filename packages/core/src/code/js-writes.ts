import type { Node } from 'web-tree-sitter';
import type { JsScopeReader } from './js-scope.js';

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

const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

const HEX_DIGITS = { x: 2, u: 4 } as const;
const LINE_BREAKS = new Set(['\n', '\r', '\u2028', '\u2029']);

/** Decodes `\xHH`, `\uHHHH` or `\u{H…}` after the backslash at `i`: the character and where the text goes on. */
function decodeHex(body: string, i: number): [string, number] | undefined {
  const braced = body[i + 1] === 'u' && body[i + 2] === '{' ? /^\{([0-9a-fA-F]{1,6})\}/.exec(body.slice(i + 2)) : undefined;
  const length = HEX_DIGITS[body[i + 1] as 'x' | 'u'];
  const digits = braced ? braced[1]! : body.slice(i + 2, i + 2 + length);
  if (!braced && !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) return undefined;
  const code = parseInt(digits, 16);
  return code > 0x10ffff ? undefined : [String.fromCodePoint(code), i + 2 + (braced ? braced[0].length : digits.length)];
}

/** Decodes one escape after its backslash at `i`: the character it stands for and where the text goes on, or undefined. */
function decodeEscape(body: string, i: number): [string, number] | undefined {
  const next = body[i + 1];
  if (next === undefined || /[1-9]/.test(next)) return undefined;
  if (next === 'x' || next === 'u') return decodeHex(body, i);
  if (next === '\r' && body[i + 2] === '\n') return ['', i + 3];
  if (LINE_BREAKS.has(next)) return ['', i + 2];
  if (next === '0') return /[0-9]/.test(body[i + 2] ?? '') ? undefined : ['\0', i + 2];
  return [SIMPLE_ESCAPES[next] ?? next, i + 2];
}

/** The text a quoted string literal stands for, escapes decoded; undefined when an escape cannot be decoded (a legacy octal). */
export function decodeString(literal: string): string | undefined {
  const body = literal.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; ) {
    if (body[i] !== '\\') out += body[i++];
    else {
      const decoded = decodeEscape(body, i);
      if (!decoded) return undefined;
      out += decoded[0];
      i = decoded[1];
    }
  }
  return out;
}

/** A plain string literal's text (`'f'` → `f`), or undefined for a key only the run time knows. */
export function stringValue(node: Node | null | undefined): string | undefined {
  return node?.type === 'string' ? decodeString(node.text) : undefined;
}

/** The key a string literal or a template without substitutions states, through casts. */
export function literalKey(node: Node | null | undefined): string | undefined {
  const key = inner(node);
  if (key?.type === 'string') return stringValue(key);
  return key?.type === 'template_string' && !key.namedChildren.some((child) => child?.type === 'template_substitution') ? key.text.slice(1, -1) : undefined;
}

/** The `Object.fn`/`Reflect.fn` a call applies, when the receiver is one of the two builtins. */
export function builtinCall(node: Node, scopes: JsScopeReader): [string, string] | undefined {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'member_expression') return undefined;
  const object = inner(fn.childForFieldName('object'));
  const property = fn.childForFieldName('property')?.text;
  const viaGlobal = object?.type === 'member_expression' && inner(object.childForFieldName('object'))?.text === 'globalThis';
  // A local `globalThis` is not the global object.
  const builtin = viaGlobal ? (scopes.meaningAt(object, 'globalThis').kind === 'none' ? object.childForFieldName('property') : undefined) : object;
  const name = builtin?.type === 'identifier' || builtin?.type === 'property_identifier' ? builtin.text : undefined;
  if ((name !== 'Object' && name !== 'Reflect') || !property) return undefined;
  return [name, property];
}

/** A property key's name when it is stated: a plain or literal-computed key; undefined for any other computed key. */
export function propertyKey(key: Node | null | undefined): string | undefined {
  if (!key) return undefined;
  if (key.type === 'computed_property_name') return literalKey(key.namedChildren[0]);
  return key.type === 'string' ? stringValue(key) : key.text;
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
  const name = node.type === 'member_expression' ? node.childForFieldName('property')?.text : literalKey(node.childForFieldName('index'));
  if (name !== undefined) out.push({ name, receiver });
}

/** The member names `Object.defineProperty`/`defineProperties`/`assign` and the `Reflect` writes rebind, on their first argument. */
function addReflective(node: Node, out: WriteSite[], scopes: JsScopeReader): void {
  const parts = builtinCall(node, scopes);
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
export function writeSites(root: Node, scopes: JsScopeReader): WriteSite[] {
  const out: WriteSite[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') addTarget(node.childForFieldName('left'), out);
    else if (node.type === 'update_expression') addTarget(node.namedChildren[0], out);
    else if (node.type === 'for_in_statement' && !node.childForFieldName('kind')) addTarget(node.childForFieldName('left'), out);
    else if (node.type === 'unary_expression' && node.children.some((child) => child?.type === 'delete')) addTarget(node.namedChildren[0], out);
    else if (node.type === 'call_expression') addReflective(node, out, scopes);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return out;
}

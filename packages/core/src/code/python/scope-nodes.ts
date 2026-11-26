import type { Node } from 'web-tree-sitter';
import type { CodeRange } from '../model.js';
import { nodeRange } from '../tree.js';

/** Pure readers of Python syntax nodes: write targets, parameters, annotations, type parameters and deferred ranges. */

const PATTERNS = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'list_splat_pattern', 'as_pattern_target', 'parenthesized_expression']);

const PARAMETERS = new Set(['default_parameter', 'typed_parameter', 'typed_default_parameter', 'list_splat_pattern', 'dictionary_splat_pattern']);

/** Identifiers a write target binds: `a`, `a, b`, `(a, [b, *c])`. Attributes and subscripts bind no name. */
export function targets(node: Node | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'identifier') return [node.text];
  if (PATTERNS.has(node.type)) return node.namedChildren.flatMap((c) => targets(c));
  return [];
}

export function parameterNames(params: Node | null): string[] {
  return (params?.namedChildren ?? []).flatMap((p) => {
    if (!p) return [];
    if (p.type === 'identifier') return [p.text];
    if (PARAMETERS.has(p.type)) return targets(p.childForFieldName('name') ?? p.namedChildren.find((c) => c?.type === 'identifier'));
    return [];
  });
}

/** The name each PEP 695 type parameter in a `type_parameter` node binds: `[T: int, *Ts, **P]` binds `T`, `Ts` and `P`. */
export function typeParameterNames(list: Node | null | undefined): string[] {
  return (list?.namedChildren ?? []).flatMap((parameter) => {
    const name = parameter ? identifiers(parameter)[0] : undefined;
    return name ? [name] : [];
  });
}

/** The `type_parameter` node a type expression holds (`Alias[T]` in a type alias's left side). */
export function typeParametersIn(node: Node | null | undefined): Node | undefined {
  if (!node) return undefined;
  if (node.type === 'type_parameter') return node;
  for (const child of node.namedChildren) {
    const found = typeParametersIn(child);
    if (found) return found;
  }
  return undefined;
}

/** A definition's parameter default expressions, which run in the scope enclosing the definition. */
export function defaultValues(parameters: Node | null): Node[] {
  return (parameters?.namedChildren ?? []).flatMap((parameter) => {
    const value = parameter?.childForFieldName('value');
    return value ? [value] : [];
  });
}

/** A function's parameter and return annotations, evaluated in its header's annotation scope, never in its body. */
export function annotationExpressions(def: Node, parameters: Node | null): Node[] {
  const nodes = [...(parameters?.namedChildren ?? []).map((p) => p?.childForFieldName('type')), def.childForFieldName('return_type')];
  return nodes.filter((n): n is Node => !!n);
}

/** A definition's parameter default values: its own type parameters are not in scope there (PEP 695). */
export function defaultRanges(parameters: Node | null): CodeRange[] {
  return defaultValues(parameters).map(nodeRange);
}

const COMPREHENSIONS = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);

/**
 * Ranges evaluated in a nested scope that does not see a class body in between: a lambda body, a comprehension's
 * element and conditions, its iterables after the first `for`, and a generator expression's element.
 */
export function deferredRanges(node: Node): CodeRange[] {
  if (node.type === 'lambda') {
    const body = node.childForFieldName('body');
    return body ? [nodeRange(body)] : [];
  }
  if (!COMPREHENSIONS.has(node.type)) return [];
  const out: CodeRange[] = [];
  const body = node.childForFieldName('body');
  if (body) out.push(nodeRange(body));
  let first = true;
  for (const child of node.namedChildren) {
    if (child?.type === 'for_in_clause') {
      const right = child.childForFieldName('right');
      if (right && !first) out.push(nodeRange(right));
      first = false;
    } else if (child?.type === 'if_clause') {
      for (const condition of child.namedChildren) if (condition) out.push(nodeRange(condition));
    }
  }
  return out;
}

export function identifiers(node: Node): string[] {
  if (node.type === 'identifier') return [node.text];
  return node.namedChildren.flatMap((c) => (c ? identifiers(c) : []));
}

/** Names a function body declares with `global` or `nonlocal`, so its writes to them land in another scope. */
export function declared(body: Node, statement: 'global_statement' | 'nonlocal_statement'): string[] {
  const names: string[] = [];
  const stack: Node[] = [body];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === statement) for (const c of node.namedChildren) if (c?.type === 'identifier') names.push(c.text);
    for (const c of node.namedChildren) if (c && c.type !== 'function_definition' && c.type !== 'class_definition') stack.push(c);
  }
  return names;
}

/**
 * The attribute names written through `owner` (`self.f = …`, `cls.f += …`, `del self.f`, `for self.f in …`), or through
 * any object when `owner` is null. A method with no first parameter (`undefined`) writes none.
 */
export function attributeWrites(body: Node, owner: string | null | undefined): string[] {
  const names: string[] = [];
  if (owner === undefined || owner === '') return names;
  const collect = (target: Node | null | undefined): void => {
    if (!target) return;
    if (target.type === 'attribute') {
      const object = target.childForFieldName('object');
      const attribute = target.childForFieldName('attribute');
      if (attribute && (owner === null || (object?.type === 'identifier' && object.text === owner))) names.push(attribute.text);
    } else if (PATTERNS.has(target.type)) for (const child of target.namedChildren) collect(child);
  };
  const stack: Node[] = [body];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'delete_statement') for (const child of node.namedChildren) collect(child);
    else if (node.type === 'as_pattern') collect(node.childForFieldName('alias'));
    else if (WRITE_FIELDS[node.type]) collect(node.childForFieldName(WRITE_FIELDS[node.type]!));
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
  return names;
}

const WRITE_FIELDS: Record<string, string> = { assignment: 'left', augmented_assignment: 'left', for_statement: 'left', for_in_clause: 'left' };

/**
 * `if not TYPE_CHECKING:` (or `not typing.TYPE_CHECKING`) with no other branch: the text of the guard. It always runs only
 * if the name is typing's constant, which a whole-file view of the bindings decides.
 */
export function typeCheckingGuard(node: Node): string | undefined {
  if (node.type !== 'if_statement' || node.childForFieldName('alternative')) return undefined;
  const test = node.childForFieldName('condition');
  const argument = test?.type === 'not_operator' ? test.childForFieldName('argument') : undefined;
  if (argument?.type === 'identifier' && argument.text === 'TYPE_CHECKING') return 'TYPE_CHECKING';
  const object = argument?.type === 'attribute' ? argument.childForFieldName('object') : undefined;
  return object?.type === 'identifier' && argument?.childForFieldName('attribute')?.text === 'TYPE_CHECKING' ? `${object.text}.TYPE_CHECKING` : undefined;
}

/** The names a class's base list extends: the last identifier of each base, every identifier of a call. Keywords are skipped. */
export function baseNames(superclasses: Node | null): string[] {
  const names = (node: Node): string[] => {
    if (node.type === 'identifier') return [node.text];
    if (node.type === 'attribute') return [node.childForFieldName('attribute')?.text ?? ''].filter(Boolean);
    if (node.type === 'subscript') return names(node.childForFieldName('value')!);
    return node.namedChildren.flatMap((c) => (c ? names(c) : []));
  };
  return (superclasses?.namedChildren ?? []).flatMap((base) => (base && base.type !== 'keyword_argument' ? names(base) : []));
}

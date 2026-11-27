import type { PyNode } from './py-tree.js';
import type { ClassInfo, CodeRange } from '../model.js';
import { nodeRange } from '../tree.js';
import { argsOf, stringConstant } from './write-nodes.js';

/** Pure readers of Python syntax nodes: write targets, parameters, annotations, type parameters and deferred ranges. */

const PATTERNS = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'list_splat_pattern', 'as_pattern_target', 'parenthesized_expression']);

const PARAMETERS = new Set(['default_parameter', 'typed_parameter', 'typed_default_parameter', 'list_splat_pattern', 'dictionary_splat_pattern']);

/** Identifiers a write target binds: `a`, `a, b`, `(a, [b, *c])`. Attributes and subscripts bind no name. */
export function targets(node: PyNode | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'identifier') return [node.text];
  if (PATTERNS.has(node.type)) return node.namedChildren.flatMap((c) => targets(c));
  return [];
}

export function parameterNames(params: PyNode | null): string[] {
  return (params?.namedChildren ?? []).flatMap((p) => {
    if (!p) return [];
    if (p.type === 'identifier') return [p.text];
    if (PARAMETERS.has(p.type)) return targets(p.childForFieldName('name') ?? p.namedChildren.find((c) => c?.type === 'identifier'));
    return [];
  });
}

/** The name each PEP 695 type parameter in a `type_parameter` node binds: `[T: int, *Ts, **P]` binds `T`, `Ts` and `P`. */
export function typeParameterNames(list: PyNode | null | undefined): string[] {
  return (list?.namedChildren ?? []).flatMap((parameter) => {
    const name = parameter ? identifiers(parameter)[0] : undefined;
    return name ? [name] : [];
  });
}

/** The `type_parameter` node a type expression holds (`Alias[T]` in a type alias's left side). */
export function typeParametersIn(node: PyNode | null | undefined): PyNode | undefined {
  if (!node) return undefined;
  if (node.type === 'type_parameter') return node;
  for (const child of node.namedChildren) {
    const found = typeParametersIn(child);
    if (found) return found;
  }
  return undefined;
}

/** A definition's parameter default expressions, which run in the scope enclosing the definition. */
export function defaultValues(parameters: PyNode | null): PyNode[] {
  return (parameters?.namedChildren ?? []).flatMap((parameter) => {
    const value = parameter?.childForFieldName('value');
    return value ? [value] : [];
  });
}

/** A function's parameter and return annotations, evaluated in its header's annotation scope, never in its body. */
export function annotationExpressions(def: PyNode, parameters: PyNode | null): PyNode[] {
  const nodes = [...(parameters?.namedChildren ?? []).map((p) => p?.childForFieldName('type')), def.childForFieldName('return_type')];
  return nodes.filter((n): n is PyNode => !!n);
}

/** A definition's parameter default values: its own type parameters are not in scope there (PEP 695). */
export function defaultRanges(parameters: PyNode | null): CodeRange[] {
  return defaultValues(parameters).map(nodeRange);
}

const COMPREHENSIONS = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);

/**
 * Ranges evaluated in a nested scope that does not see a class body in between: a lambda body, a comprehension's
 * element and conditions, its iterables after the first `for`, and a generator expression's element.
 */
export function deferredRanges(node: PyNode): CodeRange[] {
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

export function identifiers(node: PyNode): string[] {
  if (node.type === 'identifier') return [node.text];
  return node.namedChildren.flatMap((c) => (c ? identifiers(c) : []));
}

/** Names a function body declares with `global` or `nonlocal`, so its writes to them land in another scope. */
export function declared(body: PyNode, statement: 'global_statement' | 'nonlocal_statement'): string[] {
  const names: string[] = [];
  const stack: PyNode[] = [body];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === statement) for (const c of node.namedChildren) if (c?.type === 'identifier') names.push(c.text);
    for (const c of node.namedChildren) if (c && c.type !== 'function_definition' && c.type !== 'class_definition') stack.push(c);
  }
  return names;
}

/**
 * `if not TYPE_CHECKING:` (or `not typing.TYPE_CHECKING`) with no other branch: the text of the guard. It always runs only
 * if the name is typing's constant, which a whole-file view of the bindings decides.
 */
export function typeCheckingGuard(node: PyNode): string | undefined {
  if (node.type !== 'if_statement' || node.childForFieldName('alternative')) return undefined;
  const test = node.childForFieldName('condition');
  const argument = test?.type === 'not_operator' ? test.childForFieldName('argument') : undefined;
  if (argument?.type === 'identifier' && argument.text === 'TYPE_CHECKING') return 'TYPE_CHECKING';
  const object = argument?.type === 'attribute' ? argument.childForFieldName('object') : undefined;
  return object?.type === 'identifier' && argument?.childForFieldName('attribute')?.text === 'TYPE_CHECKING' ? `${object.text}.TYPE_CHECKING` : undefined;
}

/** The names a class's base list extends: the last identifier of each base, every identifier of a call. Keywords are skipped. */
export function baseNames(superclasses: PyNode | null): string[] {
  const names = (node: PyNode): string[] => {
    if (node.type === 'identifier') return [node.text];
    if (node.type === 'attribute') return [node.childForFieldName('attribute')?.text ?? ''].filter(Boolean);
    if (node.type === 'subscript') return names(node.childForFieldName('value')!);
    return node.namedChildren.flatMap((c) => (c ? names(c) : []));
  };
  return (superclasses?.namedChildren ?? []).flatMap((base) => (base && base.type !== 'keyword_argument' ? names(base) : []));
}

/** The node of a base expression with parentheses removed. */
const unparenthesized = (node: PyNode): PyNode => (node.type === 'parenthesized_expression' && node.namedChildren[0] ? unparenthesized(node.namedChildren[0]!) : node);

/**
 * Whether a class's bases include one the syntax cannot read as a (dotted) name: a subscript, call, starred expression or
 * keyword splat may evaluate to any class, so the class's real ancestors — and every name it binds — are unprovable.
 */
export function opaqueBase(superclasses: PyNode | null): boolean {
  return (superclasses?.namedChildren ?? []).some((base) => {
    if (!base || base.type === 'keyword_argument') return false;
    const node = unparenthesized(base);
    return node.type !== 'identifier' && node.type !== 'attribute';
  });
}

/** The keys a class-creation dict binds: its constant string keys, `*` for one the parse cannot name. */
function dictKeys(dict: PyNode): string[] {
  return dict.namedChildren.flatMap((entry) => (entry?.type === 'pair' ? [stringConstant(entry.childForFieldName('key')) ?? '*'] : entry?.type === 'dictionary_splat' ? ['*'] : []));
}

/**
 * The classes a three-argument `type(name, bases, ns)` call creates: it binds the dict's literal keys, and its bases are
 * opaque, so nothing about its ancestors is provable. A namespace that is not a literal dict binds `*`.
 */
export function typeClasses(root: PyNode): ClassInfo[] {
  const out: ClassInfo[] = [];
  const visit = (node: PyNode): void => {
    if (node.type === 'call' && node.childForFieldName('function')?.type === 'identifier' && node.childForFieldName('function')?.text === 'type') {
      const args = argsOf(node);
      if (args.length === 3) {
        const ns = args[2]!;
        out.push({ name: stringConstant(args[0]) ?? '', bases: [], members: ns.type === 'dictionary' ? dictKeys(ns) : ['*'], writes: [], opaqueBase: true });
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return out;
}

/** Whether a node sits in a write target, so an attribute in it is written rather than read as a value. */
function inWriteTarget(node: PyNode): boolean {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type === 'assignment' || parent.type === 'augmented_assignment') return parent.childForFieldName('left')?.id === child.id;
    if (parent.type === 'delete_statement' || parent.type === 'for_statement' || parent.type === 'for_in_clause') return parent.namedChildren.some((c) => c?.id === child.id);
    if (parent.type === 'named_expression') return parent.childForFieldName('name')?.id === child.id;
  }
  return false;
}

/**
 * The attribute names whose function object is read as a value anywhere in the file: `X.m` outside call position, a
 * class body's `m = K.m`. Such a method may run with another `self`, so calls through `self` inside it prove nothing.
 * Reading a class's namespace (`vars(K)`, `K.__dict__`) may take any method object, which is `*`.
 */
export function escapedAttributes(root: PyNode): string[] {
  const names: string[] = [];
  const visit = (node: PyNode): void => {
    if (node.type === 'attribute' && node.parent?.type !== 'call' && !inWriteTarget(node)) {
      const attribute = node.childForFieldName('attribute')?.text;
      if (attribute === '__dict__') names.push('*');
      else if (attribute) names.push(attribute);
    }
    if (node.type === 'call' && !inWriteTarget(node) && node.childForFieldName('function')?.type === 'identifier' && node.childForFieldName('function')?.text === 'vars' && argsOf(node).length) {
      names.push('*');
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return names;
}

/** Whether a class header passes a `metaclass=` keyword: its `__call__` may build a receiver that is not this class. */
export function hasMetaclass(superclasses: PyNode | null): boolean {
  return (superclasses?.namedChildren ?? []).some((base) => base?.type === 'keyword_argument' && base.childForFieldName('name')?.text === 'metaclass');
}

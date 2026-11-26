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
 * The attribute names written through `owner` (`self.f = …`, `cls.f += …`, `del self.f`, `for self.f in …`,
 * `setattr(self, 'f', …)`, `self.__dict__['f'] = …`), or through any object when `owner` is null. A name that is not a
 * constant string is `*`, since it may be any attribute. A method with no first parameter (`undefined`) writes none.
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
    } else if (target.type === 'subscript') {
      const name = dictName(target, owner);
      if (name) names.push(name);
    } else if (PATTERNS.has(target.type)) for (const child of target.namedChildren) collect(child);
  };
  const stack: Node[] = [body];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'delete_statement') for (const child of node.namedChildren) collect(child);
    else if (node.type === 'as_pattern') collect(node.childForFieldName('alias'));
    else if (WRITE_FIELDS[node.type]) collect(node.childForFieldName(WRITE_FIELDS[node.type]!));
    else if (node.type === 'call') {
      const name = setattrName(node, owner);
      if (name) names.push(name);
    }
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
  return names;
}

const WRITE_FIELDS: Record<string, string> = { assignment: 'left', augmented_assignment: 'left', for_statement: 'left', for_in_clause: 'left' };

/** The text of a plain string literal, or undefined for a computed one (an f-string, a name, a call). */
function stringConstant(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'string' || node.namedChildren.some((child) => child?.type === 'interpolation')) return undefined;
  return node.namedChildren.find((child) => child?.type === 'string_content')?.text ?? '';
}

const argsOf = (call: Node): Node[] => (call.childForFieldName('arguments')?.namedChildren ?? []).filter((a): a is Node => !!a);

/** The name a `setattr(x, 'f', …)` or `object.__setattr__(x, 'f', …)` call writes on `owner`; `*` when not constant. */
function setattrName(node: Node, owner: string | null): string | undefined {
  const fn = node.childForFieldName('function');
  const attribute = fn?.type === 'attribute' ? fn : undefined;
  const setattr = fn?.type === 'identifier' && fn.text === 'setattr';
  const objectSetattr = attribute?.childForFieldName('object')?.text === 'object' && attribute.childForFieldName('attribute')?.text === '__setattr__';
  if (!setattr && !objectSetattr) return undefined;
  const args = argsOf(node);
  const target = args[0];
  if (!target || (owner !== null && (target.type !== 'identifier' || target.text !== owner))) return undefined;
  return args[1] ? (stringConstant(args[1]) ?? '*') : '*';
}

/** The name `x.__dict__['f'] = …` or `vars(x)['f'] = …` writes on `owner`; `*` when the key is not a constant string. */
function dictName(node: Node, owner: string | null): string | undefined {
  const value = node.childForFieldName('value');
  const key = node.childForFieldName('subscript');
  if (!key) return undefined;
  const attribute = value?.type === 'attribute' ? value : undefined;
  const dict = attribute?.childForFieldName('attribute')?.text === '__dict__' ? attribute.childForFieldName('object') : undefined;
  const vars = value?.type === 'call' && value.childForFieldName('function')?.text === 'vars' && value.childForFieldName('function')?.type === 'identifier' ? argsOf(value)[0] : undefined;
  const target = dict ?? vars;
  if (target?.type !== 'identifier' || (owner !== null && target.text !== owner)) return undefined;
  return stringConstant(key) ?? '*';
}

/** A call to the builtin `name` with no arguments. */
const emptyCall = (node: Node | null | undefined, name: string): boolean =>
  node?.type === 'call' && node.childForFieldName('function')?.type === 'identifier' && node.childForFieldName('function')?.text === name && argsOf(node).length === 0;

/** `sys.modules[__name__]`: the module's own namespace, which `setattr` and an attribute write rebind. */
function sysModule(node: Node | null | undefined): boolean {
  if (node?.type !== 'subscript') return false;
  const modules = node.childForFieldName('value');
  const self = node.childForFieldName('subscript');
  return (
    modules?.type === 'attribute' &&
    modules.childForFieldName('object')?.type === 'identifier' &&
    modules.childForFieldName('object')?.text === 'sys' &&
    modules.childForFieldName('attribute')?.text === 'modules' &&
    self?.type === 'identifier' &&
    self.text === '__name__'
  );
}

/** The name a `globals()['f'] = …`-style target rebinds in the module, `*` for a computed key, or undefined. */
function moduleTargetNames(target: Node, nested: boolean): string[] | undefined {
  const key = target.type === 'subscript' ? target.childForFieldName('subscript') : undefined;
  const value = target.type === 'subscript' ? target.childForFieldName('value') : undefined;
  if (target.type === 'attribute' && sysModule(target.childForFieldName('object'))) {
    const attribute = target.childForFieldName('attribute')?.text;
    return attribute ? [attribute] : undefined;
  }
  if (!key) return undefined;
  // `vars()` reads the module namespace only at module level; inside a function it is the function's locals.
  if (!emptyCall(value, 'globals') && (nested || !emptyCall(value, 'vars'))) return undefined;
  return [stringConstant(key) ?? '*'];
}

/** The names `globals().update(f=…)` rebinds: its keyword names, or `*` when it takes a mapping or expands a dict. */
function updateNames(node: Node): string[] | undefined {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'attribute' || fn.childForFieldName('attribute')?.text !== 'update' || !emptyCall(fn.childForFieldName('object'), 'globals')) return undefined;
  const names = argsOf(node).map((arg) => (arg.type === 'keyword_argument' ? arg.childForFieldName('name')?.text : undefined));
  return names.some((name) => !name) ? ['*'] : (names as string[]);
}

/** The name `setattr(sys.modules[__name__], 'f', …)` rebinds, `*` when the name is not a constant, or undefined. */
function moduleSetattrName(node: Node): string[] | undefined {
  if (!(node.childForFieldName('function')?.type === 'identifier' && node.childForFieldName('function')?.text === 'setattr')) return undefined;
  const args = argsOf(node);
  if (!args[0] || !sysModule(args[0])) return undefined;
  return [args[1] ? (stringConstant(args[1]) ?? '*') : '*'];
}

function dynamicNames(node: Node, nested: boolean): string[] | undefined {
  if (node.type === 'assignment' || node.type === 'augmented_assignment') {
    const target = node.childForFieldName('left');
    return target ? moduleTargetNames(target, nested) : undefined;
  }
  if (node.type !== 'call') return undefined;
  if (node.childForFieldName('function')?.type === 'identifier' && node.childForFieldName('function')?.text === 'exec') return ['*'];
  return updateNames(node) ?? moduleSetattrName(node);
}

const FUNCTION_SCOPES = new Set(['function_definition', 'lambda', 'class_definition']);

/**
 * The module names statements rebind at run time, wherever they sit: `globals()[…]`, `globals().update(…)`,
 * `sys.modules[__name__]`, module-level `vars()` and any `exec(…)`. The resolver then finds two bindings (or a `*`)
 * and refuses to prove a target, which the syntax alone cannot show.
 */
export function dynamicModuleBindings(root: Node): { name: string; start: CodeRange['start'] }[] {
  const out: { name: string; start: CodeRange['start'] }[] = [];
  const visit = (node: Node, nested: boolean): void => {
    const names = dynamicNames(node, nested);
    if (names) {
      const start = nodeRange(node).start;
      for (const name of names) out.push({ name, start });
    }
    const inside = nested || FUNCTION_SCOPES.has(node.type);
    for (const child of node.namedChildren) if (child) visit(child, inside);
  };
  visit(root, false);
  return out;
}

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

/** Whether a class header passes a `metaclass=` keyword: its `__call__` may build a receiver that is not this class. */
export function hasMetaclass(superclasses: Node | null): boolean {
  return (superclasses?.namedChildren ?? []).some((base) => base?.type === 'keyword_argument' && base.childForFieldName('name')?.text === 'metaclass');
}

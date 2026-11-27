import type { PyNode } from './py-tree.js';
import type { CodeRange } from '../model.js';
import { nodeRange } from '../tree.js';

/** Pure readers of Python writes: attribute targets, `setattr`/`delattr` calls and the module names they rebind. */

/** Destructuring a write target may sit in: `a, b = …`, `[a, *b] = …`. */
const PATTERNS = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'list_splat_pattern', 'as_pattern_target', 'parenthesized_expression']);

const WRITE_FIELDS: Record<string, string> = { assignment: 'left', augmented_assignment: 'left', for_statement: 'left', for_in_clause: 'left' };

/**
 * The attribute names written through `owner` (`self.f = …`, `cls.f += …`, `del self.f`, `for self.f in …`,
 * `setattr(self, 'f', …)`, `self.__dict__['f'] = …`), or through any object when `owner` is null. A name that is not a
 * constant string is `*`, since it may be any attribute. A method with no first parameter (`undefined`) writes none.
 */
export function attributeWrites(body: PyNode, owner: string | null | undefined): string[] {
  const names: string[] = [];
  if (owner === undefined || owner === '') return names;
  const collect = (target: PyNode | null | undefined): void => {
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
  const stack: PyNode[] = [body];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'delete_statement') for (const child of node.namedChildren) collect(child);
    else if (node.type === 'as_pattern') collect(node.childForFieldName('alias'));
    else if (WRITE_FIELDS[node.type]) collect(node.childForFieldName(WRITE_FIELDS[node.type]!));
    else if (node.type === 'call') {
      const name = setattrName(node, owner) ?? delattrName(node, owner);
      if (name) names.push(name);
    }
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
  return names;
}

/** The text of a plain string literal, or undefined for a computed one (an f-string, a name, a call). */
export function stringConstant(node: PyNode | null | undefined): string | undefined {
  if (node?.type !== 'string' || node.namedChildren.some((child) => child?.type === 'interpolation')) return undefined;
  return node.namedChildren.find((child) => child?.type === 'string_content')?.text ?? '';
}

const argsOf = (call: PyNode): PyNode[] => (call.childForFieldName('arguments')?.namedChildren ?? []).filter((a): a is PyNode => !!a);
export { argsOf };

/** The name a `setattr(x, 'f', …)` or `object.__setattr__(x, 'f', …)` call writes on `owner`; `*` when not constant. */
function setattrName(node: PyNode, owner: string | null): string | undefined {
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

/** The name a `delattr(x, 'f')` call deletes on `owner`: an attribute write like `del x.f`; `*` when not constant. */
function delattrName(node: PyNode, owner: string | null): string | undefined {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'identifier' || fn.text !== 'delattr') return undefined;
  const args = argsOf(node);
  const target = args[0];
  if (!target || (owner !== null && (target.type !== 'identifier' || target.text !== owner))) return undefined;
  return args[1] ? (stringConstant(args[1]) ?? '*') : '*';
}

/** The name `x.__dict__['f'] = …` or `vars(x)['f'] = …` writes on `owner`; `*` when the key is not a constant string. */
function dictName(node: PyNode, owner: string | null): string | undefined {
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
const emptyCall = (node: PyNode | null | undefined, name: string): boolean =>
  node?.type === 'call' && node.childForFieldName('function')?.type === 'identifier' && node.childForFieldName('function')?.text === name && argsOf(node).length === 0;

/** `sys.modules[__name__]`: the module's own namespace, which `setattr` and an attribute write rebind. */
function sysModule(node: PyNode | null | undefined): boolean {
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
function moduleTargetNames(target: PyNode, nested: boolean): string[] | undefined {
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
function updateNames(node: PyNode): string[] | undefined {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'attribute' || fn.childForFieldName('attribute')?.text !== 'update' || !emptyCall(fn.childForFieldName('object'), 'globals')) return undefined;
  const names = argsOf(node).map((arg) => (arg.type === 'keyword_argument' ? arg.childForFieldName('name')?.text : undefined));
  return names.some((name) => !name) ? ['*'] : (names as string[]);
}

/** The name `globals().pop('f')` rebinds, `*` when the key is not a constant, or undefined. */
function popName(node: PyNode): string[] | undefined {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'attribute' || fn.childForFieldName('attribute')?.text !== 'pop' || !emptyCall(fn.childForFieldName('object'), 'globals')) return undefined;
  const args = argsOf(node);
  return [args[0] ? (stringConstant(args[0]) ?? '*') : '*'];
}

/** The name `setattr(sys.modules[__name__], 'f', …)` or `delattr(sys.modules[__name__], 'f')` rebinds, or undefined. */
function moduleSetattrName(node: PyNode): string[] | undefined {
  const fn = node.childForFieldName('function');
  if (!(fn?.type === 'identifier' && (fn.text === 'setattr' || fn.text === 'delattr'))) return undefined;
  const args = argsOf(node);
  if (!args[0] || !sysModule(args[0])) return undefined;
  return [args[1] ? (stringConstant(args[1]) ?? '*') : '*'];
}

/** Whether a call hands a live view of some module's namespace (`globals()`, `vars()`, `sys.modules[__name__]`) to code. */
const escapesNamespace = (node: PyNode): boolean => argsOf(node).some((arg) => sysModule(arg) || emptyCall(arg, 'globals') || emptyCall(arg, 'vars'));

function dynamicNames(node: PyNode, nested: boolean): string[] | undefined {
  if (node.type === 'assignment' || node.type === 'augmented_assignment') {
    const target = node.childForFieldName('left');
    return target ? moduleTargetNames(target, nested) : undefined;
  }
  if (node.type === 'delete_statement') {
    const names = node.namedChildren.flatMap((child) => (child ? (moduleTargetNames(child, nested) ?? []) : []));
    return names.length ? names : undefined;
  }
  if (node.type !== 'call') return undefined;
  if (node.childForFieldName('function')?.type === 'identifier' && node.childForFieldName('function')?.text === 'exec') return ['*'];
  const named = updateNames(node) ?? popName(node) ?? moduleSetattrName(node);
  if (named) return named;
  // The namespace handed to another function may be written through its dict, rebinding any module name.
  return escapesNamespace(node) ? ['*'] : undefined;
}

const FUNCTION_SCOPES = new Set(['function_definition', 'lambda', 'class_definition']);

/**
 * The module names statements rebind at run time, wherever they sit: `globals()[…]`, `globals().update(…)`,
 * `globals().pop(…)`, `sys.modules[__name__]`, module-level `vars()`, `delattr`/`setattr` on the module and any
 * `exec(…)`; also a namespace handed to another function, which may write any name. The resolver then finds two
 * bindings (or a `*`) and refuses to prove a target, which the syntax alone cannot show.
 */
export function dynamicModuleBindings(root: PyNode): { name: string; start: CodeRange['start'] }[] {
  const out: { name: string; start: CodeRange['start'] }[] = [];
  const visit = (node: PyNode, nested: boolean): void => {
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

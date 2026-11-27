import type { Node } from 'web-tree-sitter';
import type { CodeSymbol } from '../model.js';
import type { ImportIndex, PyBinding } from './module-scope.js';
import { type Context, type ModuleValue, TARGET_PATTERNS, dynamicSysModules, inImportStatement, inTarget, isImportFunction, isSetattrCall, outerParent, resolveValues, scopesOf, targetName, targetValues, unwrap } from './module-values.js';
import { argsOf, stringConstant } from './write-nodes.js';

/**
 * A write an escaping module value can make: any attribute of the module an import names. `import` is the file's import
 * the value is bound by, which dispatch resolves to the module; absent when the parse cannot name the module at all.
 * `chain` names the submodules an attribute chain reaches below the root binding; `module` a `sys.modules` literal key;
 * `current` the file's own module (`sys.modules[__name__]`).
 */
export interface ModuleEscape {
  receiver: string;
  name: string;
  import?: number;
  /** `import a.b` binds the package `a`, which the resolved submodule path still locates. */
  dotted?: boolean;
  /** The attribute components below the root: `pkg.sub` names the module `sub` of `pkg`. */
  chain?: string[];
  /** A module named by a literal `sys.modules[<name>]` key, resolved like an absolute import. */
  module?: string;
  /** The file's own module, named by `sys.modules[__name__]`. */
  current?: boolean;
}

/** Module attributes whose access reaches the module's namespace itself. */
const NAMESPACE = new Set(['__setattr__', '__delattr__', '__dict__']);

/** Whether a node is the first argument of a `setattr`/`delattr` call, which writes rather than escaping. */
function setattrOperand(node: Node): boolean {
  const parent = outerParent(node);
  return parent?.type === 'call' && isSetattrCall(parent) && unwrap(argsOf(parent)[0])?.id === node.id;
}

/** Whether a node sits in a `X.__dict__[<literal>] = …` / `vars(X)[<literal>] = …` write, handled by the write pass. */
function namespaceWrite(node: Node): boolean {
  const parent = outerParent(node);
  return parent?.type === 'subscript' && parent.childForFieldName('value')?.id === node.id && inTarget(parent);
}

/** Whether an import call's result is handed on: not a plain `name = …` (that name is itself an import binding) nor a write. */
function escapesCall(node: Node): boolean {
  const parent = outerParent(node);
  return !(parent?.type === 'assignment' && unwrap(parent.childForFieldName('right'))?.id === node.id && parent.childForFieldName('left')?.type === 'identifier');
}

/** Whether a node is used as a value: not a write target, an attribute's object or name, a subscripted value, or an import. */
function readAsValue(node: Node): boolean {
  if (inTarget(node)) return false;
  const parent = outerParent(node);
  if (parent?.type === 'attribute') return false;
  // `X[k]`'s key is read; the subscripted value is the object an attribute chain continues from.
  if (parent?.type === 'subscript' && parent.childForFieldName('value')?.id === node.id) return false;
  if (parent?.type === 'keyword_argument' && parent.childForFieldName('name')?.id === node.id) return false;
  return !inImportStatement(node);
}

/** Records one module write from a module value; a value naming no module counts for the whole any-module set. */
function addEscape(out: Map<string, ModuleEscape>, value: ModuleValue, name: string): void {
  const escape: ModuleEscape = { receiver: value.receiver, name };
  if (!value.any) {
    if (value.module !== undefined) escape.module = value.module;
    else if (value.current) escape.current = true;
    else if (value.import !== undefined) {
      escape.import = value.import;
      if (value.dotted) escape.dotted = true;
      if (value.chain?.length) escape.chain = value.chain;
    } else return;
  }
  out.set(`${escape.import ?? ''}\0${escape.module ?? ''}\0${escape.current ? '1' : ''}\0${escape.receiver}\0${escape.chain?.join('.') ?? ''}\0${name}`, escape);
}

/** Records the module writes one write target makes: `X.f = …`, `X.__dict__['f'] = …`, through a destructuring pattern. */
function writeTarget(target: Node | null | undefined, context: Context, out: Map<string, ModuleEscape>): void {
  const node = unwrap(target);
  if (!node) return;
  if (TARGET_PATTERNS.has(node.type)) return node.namedChildren.forEach((child) => writeTarget(child, context, out));
  const name = targetName(node);
  if (name) for (const value of targetValues(node, context)) addEscape(out, value, name);
}

/** Every direct module write of the file: attribute targets, deletes, `for` targets and `setattr`/`delattr` calls. */
function collectWrites(root: Node, context: Context, out: Map<string, ModuleEscape>): void {
  const visit = (node: Node): void => {
    if (node.type === 'call' && isSetattrCall(node)) {
      const args = argsOf(node);
      const name = args[1] ? (stringConstant(args[1]) ?? '*') : '*';
      if (args[0]) for (const value of resolveValues(args[0], context)) addEscape(out, value, name);
    } else if (node.type === 'assignment' || node.type === 'augmented_assignment') writeTarget(node.childForFieldName('left'), context, out);
    else if (node.type === 'delete_statement') node.namedChildren.forEach((child) => writeTarget(child, context, out));
    else if (node.type === 'for_statement' || node.type === 'for_in_clause') writeTarget(node.childForFieldName('left'), context, out);
    else if (node.type === 'as_pattern') writeTarget(node.childForFieldName('alias'), context, out);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
}

/** The escapes a namespace access makes: `a.__setattr__`, `a.__dict__.update`, `d = a.__dict__`, `vars(a)`. */
function namespaceEscape(node: Node, context: Context, out: Map<string, ModuleEscape>): void {
  // `sys.modules[<computed>]` can name any module, so any module may be written through it.
  if (dynamicSysModules(node, context)) addEscape(out, { receiver: '', any: true }, '*');
  const attribute = node.type === 'attribute' ? node.childForFieldName('attribute')?.text : undefined;
  if (attribute && NAMESPACE.has(attribute) && !namespaceWrite(node)) {
    for (const value of resolveValues(node.childForFieldName('object'), context)) addEscape(out, value, '*');
  }
  const fn = node.type === 'call' ? node.childForFieldName('function') : undefined;
  if (fn?.type === 'identifier' && fn.text === 'vars' && argsOf(node).length === 1 && !namespaceWrite(node)) {
    for (const value of resolveValues(argsOf(node)[0], context)) addEscape(out, value, '*');
  }
}

/** The escape one value use makes: a module value handed on, other than a plain `name = import_module(…)`. */
function valueEscape(node: Node, context: Context, out: Map<string, ModuleEscape>): void {
  const boundImport = node.type === 'call' && isImportFunction(node.childForFieldName('function'), context) && !escapesCall(node);
  if (boundImport || !readAsValue(node) || setattrOperand(node)) return;
  for (const value of resolveValues(node, context)) addEscape(out, value, '*');
}

/** Every module value of the file that escapes as a value: bindings, attribute chains, `sys.modules` entries, calls. */
function collectEscapes(root: Node, context: Context, out: Map<string, ModuleEscape>): void {
  const visit = (node: Node): void => {
    namespaceEscape(node, context, out);
    valueEscape(node, context, out);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
}

/**
 * The module writes an escaping module value makes (COD-59 round 3): an import binding (or every one the scope holds of
 * the name) used as a value, an attribute chain that names a repo submodule and is handed on, a `sys.modules` entry, and
 * a callee resolving to `importlib.import_module`/`__import__` whose result is not a plain name assignment. Direct
 * writes and namespace accesses (`setattr`, `__dict__`, `vars`) name the attribute they write; every other use is `*`.
 */
export function moduleEscapes(root: Node, symbols: readonly CodeSymbol[], bindings: readonly PyBinding[], index: ImportIndex, imports: Context['imports']): ModuleEscape[] {
  const context: Context = { symbols, bindings, index, imports, scopesAt: scopesOf(symbols) };
  const out = new Map<string, ModuleEscape>();
  collectWrites(root, context, out);
  collectEscapes(root, context, out);
  return [...out.values()];
}

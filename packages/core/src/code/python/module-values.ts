import type { Node } from 'web-tree-sitter';
import type { CodeRange, CodeSymbol, Import } from '../model.js';
import type { ImportIndex, PyBinding } from './module-scope.js';
import { argsOf, stringConstant } from './write-nodes.js';

/** The stated imports a callee is resolved through; resolution has not run yet, so only the spec and names are read. */
type StatedImport = Pick<Import, 'spec' | 'names' | 'kind'>;

/** A module value the file holds: an import binding, a `sys.modules` entry, or an import call's result. */
export interface ModuleValue {
  receiver: string;
  import?: number;
  dotted?: boolean;
  chain?: string[];
  module?: string;
  current?: boolean;
  /** A `from`-import of a function: its module is the module it is imported from, or the submodule its name binds. */
  binding?: boolean;
  /** The call's module name is not a literal: any module. */
  any?: boolean;
}

/** Everything the escape reader resolves a name through: the file's scopes, import index and stated imports. */
export interface Context {
  symbols: readonly CodeSymbol[];
  bindings: readonly PyBinding[];
  index: ImportIndex;
  imports: readonly StatedImport[];
  /** The scope ids a name at this position is looked up in. */
  scopesAt: (at: CodeRange['start']) => string[];
  /** Names some scope binds from `from sys import modules`, checked before the per-position scope walk. */
  sysModuleNames: ReadonlySet<string>;
  /** Names some scope binds from `from importlib import import_module|__import__`, checked before the per-position scope walk. */
  importFunctionNames: ReadonlySet<string>;
}

const IMPORT_STATEMENTS = new Set(['import_statement', 'import_from_statement', 'future_import_statement']);

/** Whether a node type is an import statement, whose bindings are declared rather than read as values. */
export const inImport = (type: string): boolean => IMPORT_STATEMENTS.has(type);

/** Destructuring a write target may sit in: `a, b = …`, `[a, *b] = …`. */
export const TARGET_PATTERNS = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'list_splat_pattern', 'as_pattern_target', 'parenthesized_expression']);

const before = (a: CodeRange['start'], b: CodeRange['start']): boolean => a.line < b.line || (a.line === b.line && a.column < b.column);
const inside = (at: CodeRange['start'], range: CodeRange): boolean => !before(at, range.start) && before(at, range.end);

/** A node's start point, for a scope lookup: its row and column, which need no walk of the tree. */
export const startOf = (node: Node): CodeRange['start'] => ({ line: node.startPosition.row + 1, column: node.startPosition.column });

/** A node with the parentheses around it removed. */
export function unwrap(node: Node | null | undefined): Node | undefined {
  let current = node ?? undefined;
  while (current?.type === 'parenthesized_expression') current = current.namedChildren[0] ?? undefined;
  return current;
}

/** The parent of `node`, after any parentheses around it. */
export function outerParent(node: Node): Node | undefined {
  let parent = node.parent;
  while (parent?.type === 'parenthesized_expression') parent = parent.parent;
  return parent ?? undefined;
}

/** Whether a node is a write target rather than a read: `x = …`, `for x in …`, `del x`, `x := …`. */
export function inTarget(node: Node): boolean {
  let child: Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type === 'assignment' || parent.type === 'augmented_assignment') return parent.childForFieldName('left')?.id === child.id;
    if (parent.type === 'delete_statement') return true;
    // Only the left of a `for` (statement or comprehension) is a write target; its iterable is a read.
    if (parent.type === 'for_statement' || parent.type === 'for_in_clause') return parent.childForFieldName('left')?.id === child.id;
    if (parent.type === 'named_expression') return parent.childForFieldName('name')?.id === child.id;
    if (!TARGET_PATTERNS.has(parent.type)) return false;
  }
  return false;
}

/** The scopes a name is looked up in at `at`, innermost first, from symbols sorted longest path first; a class body is skipped. */
function scopesAtIn(symbols: readonly CodeSymbol[], at: CodeRange['start']): string[] {
  const holders = symbols.filter((symbol) => inside(at, symbol.range));
  return [...holders.flatMap((holder, index) => (index === 0 || holder.kind !== 'class' ? [holder.id] : [])), ''];
}

/** Every binding of `name` in the nearest scope that binds it: several may exist (`import a` twice, a fallback assignment). */
export function scopeBindings(bindings: readonly PyBinding[], scopes: readonly string[], name: string): readonly PyBinding[] | undefined {
  for (const scope of scopes) {
    const scoped = bindings.filter((binding) => binding.scope === scope && binding.name === name && !binding.attr && !binding.alias && !binding.inherited);
    if (scoped.length) return scoped;
  }
  return undefined;
}

/** Every import binding of `name` in the scope the name resolves in; a write or escape counts for each of them. */
function importBindingsAt(context: Context, at: CodeRange['start'], name: string): readonly PyBinding[] {
  const scoped = scopeBindings(context.bindings, context.scopesAt(at), name);
  return (scoped ?? []).filter((binding) => binding.kind === 'import' && binding.import !== undefined);
}

/** Whether any binding of `name` in scope is an import of the module `spec`: a repeated import or a try/except fallback still names it. */
function importedAs(context: Context, at: CodeRange['start'], name: string, spec: string, dottedRoot = false): boolean {
  return !!scopeBindings(context.bindings, context.scopesAt(at), name)?.some((binding) => {
    if (binding.kind !== 'import' || binding.import === undefined) return false;
    const imp = context.imports[binding.import];
    return !!imp && (dottedRoot ? imp.spec.split('.')[0] === spec : imp.spec === spec);
  });
}

/** The `a.b.c` chain a node is: its root identifier and the attribute names below it. */
function chainOf(node: Node): { root: Node; parts: string[] } | undefined {
  const parts: string[] = [];
  let current: Node | undefined = node;
  while (current?.type === 'attribute') {
    const attribute = current.childForFieldName('attribute');
    if (!attribute) return undefined;
    parts.unshift(attribute.text);
    current = current.childForFieldName('object') ?? undefined;
  }
  return current?.type === 'identifier' ? { root: current, parts } : undefined;
}

/** Whether `name` is bound by a `from sys import modules [as name]` binding at `at`. */
function fromSysModules(context: Context, at: CodeRange['start'], name: string): boolean {
  if (!context.sysModuleNames.has(name)) return false;
  return !!scopeBindings(context.bindings, context.scopesAt(at), name)?.some((binding) => {
    if (binding.kind !== 'import' || binding.import === undefined) return false;
    const imp = context.imports[binding.import];
    return !!imp && imp.spec === 'sys' && (imp.names ?? []).some((n) => n.local === name && n.imported === 'modules');
  });
}

/** Whether a node is `sys.modules`, under any binding of `sys`, or a name `from sys import modules` binds. */
export function isSysModules(node: Node | null | undefined, context: Context): boolean {
  if (!node) return false;
  if (node.type === 'identifier') return fromSysModules(context, startOf(node), node.text);
  if (node.type !== 'attribute') return false;
  const object = node.childForFieldName('object');
  return object?.type === 'identifier' && node.childForFieldName('attribute')?.text === 'modules' && importedAs(context, startOf(object), object.text, 'sys');
}

/** Whether `name` is bound by a `from importlib import import_module|__import__ [as name]` binding at `at`. */
function fromImportlib(context: Context, at: CodeRange['start'], name: string): boolean {
  if (!context.importFunctionNames.has(name)) return false;
  return !!scopeBindings(context.bindings, context.scopesAt(at), name)?.some((binding) => {
    if (binding.kind !== 'import' || binding.import === undefined) return false;
    const imp = context.imports[binding.import];
    return !!imp && imp.spec === 'importlib' && (imp.names ?? []).some((n) => n.local === name && (n.imported === 'import_module' || n.imported === '__import__'));
  });
}

/** Whether a call is the builtin `__import__` or resolves to `importlib.import_module`/`importlib.__import__`, through aliases and from-imports. */
export function isImportFunction(fn: Node | null | undefined, context: Context): boolean {
  if (!fn) return false;
  const at = startOf(fn);
  if (fn.type === 'identifier') {
    // A name the scopes bind is not the builtin `__import__`; a from-import names the importlib one.
    if (fn.text === '__import__') return !scopeBindings(context.bindings, context.scopesAt(at), fn.text)?.length;
    return fromImportlib(context, at, fn.text);
  }
  if (fn.type !== 'attribute') return false;
  const attribute = fn.childForFieldName('attribute')?.text;
  if (attribute !== 'import_module' && attribute !== '__import__') return false;
  const object = fn.childForFieldName('object');
  return object?.type === 'identifier' && importedAs(context, at, object.text, 'importlib', true);
}

/** Whether a node is the unshadowed builtin `name`: no scope binds that name where it is written. */
export function isBuiltin(context: Context, node: Node | null | undefined, name: string): boolean {
  const target = unwrap(node);
  return target?.type === 'identifier' && target.text === name && !scopeBindings(context.bindings, context.scopesAt(startOf(target)), name)?.length;
}

/** Whether a call names a module at run time: a stated literal name, or a computed one no parse can resolve. */
function importCallValue(node: Node, context: Context): ModuleValue | undefined {
  if (node.type !== 'call' || !isImportFunction(node.childForFieldName('function'), context)) return undefined;
  const args = argsOf(node);
  const literal = args[0] ? stringConstant(args[0]) : undefined;
  const at = context.index.get(node.id)?.at;
  return at !== undefined && literal !== undefined ? { receiver: '', import: at } : { receiver: '', any: true };
}

/** A module value named by a literal `sys.modules[...]` subscript; a computed key or bare `sys.modules` is any module. */
function sysModulesValue(node: Node, context: Context): ModuleValue | undefined {
  if (node.type === 'subscript') {
    if (!isSysModules(node.childForFieldName('value'), context)) return undefined;
    const key = node.childForFieldName('subscript');
    if (key?.type === 'identifier' && key.text === '__name__') return { receiver: '', current: true };
    const name = stringConstant(key);
    return { receiver: '', ...(name ? { module: name } : { any: true }) };
  }
  if (isSysModules(node, context)) return { receiver: '', any: true };
  return undefined;
}

/** The module values an expression names: an import binding, an attribute chain below it, a `sys.modules` entry, or a call. */
export function resolveValues(node: Node | null | undefined, context: Context): ModuleValue[] {
  const target = unwrap(node);
  if (!target) return [];
  // `sys.modules` is read before the attribute branch: it is a module value, not an attribute of the external `sys` import.
  const named = sysModulesValue(target, context) ?? importCallValue(target, context);
  if (named) return [named];
  if (target.type === 'identifier') {
    return importBindingsAt(context, startOf(target), target.text).map((binding) => ({
      receiver: binding.name,
      import: binding.import!,
      ...(binding.dotted && { dotted: true }),
    }));
  }
  if (target.type === 'attribute') {
    const chain = chainOf(target);
    if (!chain?.parts.length) return [];
    return importBindingsAt(context, startOf(chain.root), chain.root.text).map((binding) => ({
      receiver: binding.name,
      import: binding.import!,
      ...(binding.dotted && { dotted: true }),
      chain: chain.parts,
    }));
  }
  return [];
}

/** Whether a subscript is `sys.modules[<computed>]`: it can name any module, so the whole any-module set is written. */
export function dynamicSysModules(node: Node, context: Context): boolean {
  if (node.type !== 'subscript' || !isSysModules(node.childForFieldName('value'), context)) return false;
  const key = node.childForFieldName('subscript');
  return !(key?.type === 'identifier' && key.text === '__name__') && stringConstant(key) === undefined;
}

/** The module values a namespace expression names: `X.__dict__` or `vars(X)` where X is a module. */
function namespaceValues(node: Node | null | undefined, context: Context): ModuleValue[] {
  const target = unwrap(node);
  if (!target) return [];
  if (target.type === 'attribute' && target.childForFieldName('attribute')?.text === '__dict__') return resolveValues(target.childForFieldName('object'), context);
  if (target.type === 'call') {
    const fn = target.childForFieldName('function');
    const args = argsOf(target);
    if (fn?.type === 'identifier' && fn.text === 'vars' && args.length === 1) return resolveValues(args[0], context);
  }
  return [];
}

/** The module values a write target writes on: `X.f = …` writes X's `f`, `X.__dict__['f'] = …` the module's dict. */
export function targetValues(node: Node | null | undefined, context: Context): ModuleValue[] {
  const target = unwrap(node);
  if (!target) return [];
  if (TARGET_PATTERNS.has(target.type)) return target.namedChildren.flatMap((child) => (child ? targetValues(child, context) : []));
  if (target.type === 'attribute') return resolveValues(target.childForFieldName('object'), context);
  if (target.type === 'subscript') return namespaceValues(target.childForFieldName('value'), context);
  return [];
}

/** The attribute name a write target names, or the key `X.__dict__[key]` / `vars(X)[key]` writes: `*` when not a constant. */
export function targetName(node: Node | null | undefined): string | undefined {
  const target = unwrap(node);
  if (!target) return undefined;
  if (target.type === 'attribute') return target.childForFieldName('attribute')?.text;
  if (target.type === 'subscript') return stringConstant(target.childForFieldName('subscript')) ?? '*';
  return undefined;
}

/** A call to the builtin `setattr`/`delattr`, whose first argument names the object it writes. */
export function isSetattrCall(node: Node): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  return fn?.type === 'identifier' && (fn.text === 'setattr' || fn.text === 'delattr');
}

/** The scope lookup of a file's names, as `moduleEscapes` reads them; the symbols stay sorted once, longest path first. */
export const scopesOf = (symbols: readonly CodeSymbol[]): Context['scopesAt'] => {
  const sorted = [...symbols].sort((a, b) => b.path.length - a.path.length);
  return (at) => scopesAtIn(sorted, at);
};

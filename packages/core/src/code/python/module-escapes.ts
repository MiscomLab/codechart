import type { PyNode } from './py-tree.js';
import type { CodeSymbol } from '../model.js';
import type { ImportIndex, PyBinding } from './module-scope.js';
import { type Context, type ModuleValue, TARGET_PATTERNS, dynamicSysModules, inImport, inTarget, isBuiltin, isImportFunction, isSetattrCall, isSysModules, outerParent, resolveValues, scopeBindings, scopesOf, startOf, targetName, targetValues, unwrap } from './module-values.js';
import { argsOf, stringConstant } from './write-nodes.js';

/**
 * A write an escaping module value can make: any attribute of the module an import names. `import` is the file's import
 * the value is bound by, which dispatch resolves to the module; absent when the parse cannot name the module at all.
 * `chain` names the submodules an attribute chain reaches below the root binding; `module` a `sys.modules` literal key;
 * `current` the file's own module (`sys.modules[__name__]`); `binding` the module a from-import comes from.
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
  /** A `from`-import: the write lands on the module it imports from, or on the submodule the name binds. */
  binding?: boolean;
  /** The value escapes as a whole, so every module it reaches is written too. */
  escaped?: boolean;
}

/** Module attributes whose access reaches the module's namespace itself. */
const NAMESPACE = new Set(['__setattr__', '__delattr__', '__dict__']);

/** Whether a node is the first argument of a `setattr`/`delattr` call, which writes rather than escaping. */
function setattrOperand(node: PyNode, parent: PyNode | undefined): boolean {
  return parent?.type === 'call' && isSetattrCall(parent) && unwrap(argsOf(parent)[0])?.id === node.id;
}

/** Whether a node sits in a `X.__dict__[<literal>] = …` / `vars(X)[<literal>] = …` write, handled by the write pass. */
function namespaceWrite(node: PyNode): boolean {
  const parent = outerParent(node);
  return parent?.type === 'subscript' && parent.childForFieldName('value')?.id === node.id && inTarget(parent);
}

/** Whether an import call's result is handed on: not a plain `name = …` (that name is itself an import binding) nor a write. */
function escapesCall(node: PyNode, parent: PyNode | undefined): boolean {
  return !(parent?.type === 'assignment' && unwrap(parent.childForFieldName('right'))?.id === node.id && parent.childForFieldName('left')?.type === 'identifier');
}

/** Node types a module value can be read from: an import binding, an attribute chain, a subscript or a call. */
const VALUE_TYPES = new Set(['identifier', 'attribute', 'subscript', 'call']);

/** Whether a node is used as a value: not a write target, an attribute's object or name, a subscripted value, or an import. */
function readAsValue(node: PyNode, parent: PyNode | undefined, insideImport: boolean): boolean {
  // The parent checks come first: they skip the write-target walk for an attribute's object, the commonest node.
  if (insideImport || parent?.type === 'attribute') return false;
  // `X[k]`'s key is read; the subscripted value is the object an attribute chain continues from.
  if (parent?.type === 'subscript' && parent.childForFieldName('value')?.id === node.id) return false;
  if (parent?.type === 'keyword_argument' && parent.childForFieldName('name')?.id === node.id) return false;
  return !inTarget(node);
}

/** Records one module write from a module value; a value naming no module counts for the whole any-module set. */
function addEscape(out: Map<string, ModuleEscape>, value: ModuleValue, name: string, escaped = false): void {
  const escape: ModuleEscape = { receiver: value.receiver, name, ...(escaped && { escaped: true }) };
  if (!value.any) {
    if (value.module !== undefined) escape.module = value.module;
    else if (value.current) escape.current = true;
    else if (value.import !== undefined) {
      escape.import = value.import;
      if (value.dotted) escape.dotted = true;
      if (value.chain?.length) escape.chain = value.chain;
      if (value.binding) escape.binding = true;
    } else return;
  }
  out.set(`${escape.import ?? ''}\0${escape.module ?? ''}\0${escape.current ? '1' : ''}\0${escape.binding ? '1' : ''}\0${escape.receiver}\0${escape.chain?.join('.') ?? ''}\0${name}\0${escaped ? '1' : ''}`, escape);
}

/** Records the module writes one write target makes: `X.f = …`, `X.__dict__['f'] = …`, through a destructuring pattern. */
function writeTarget(target: PyNode | null | undefined, context: Context, out: Map<string, ModuleEscape>): void {
  const node = unwrap(target);
  if (!node) return;
  if (TARGET_PATTERNS.has(node.type)) return node.namedChildren.forEach((child) => writeTarget(child, context, out));
  const name = targetName(node);
  if (name) for (const value of targetValues(node, context)) addEscape(out, value, name);
}

/** Every direct module write of the file: attribute targets, deletes, `for` targets and `setattr`/`delattr` calls. */
function collectWrites(root: PyNode, context: Context, out: Map<string, ModuleEscape>): void {
  const visit = (node: PyNode): void => {
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
function namespaceEscape(node: PyNode, type: string, context: Context, out: Map<string, ModuleEscape>): void {
  // `sys.modules[<computed>]` can name any module, so any module may be written through it.
  if (type === 'subscript' && dynamicSysModules(node, context)) addEscape(out, { receiver: '', any: true }, '*', true);
  const attribute = type === 'attribute' ? node.childForFieldName('attribute')?.text : undefined;
  if (attribute && NAMESPACE.has(attribute) && !namespaceWrite(node)) {
    for (const value of resolveValues(node.childForFieldName('object'), context)) addEscape(out, value, '*', true);
  }
  const fn = type === 'call' ? node.childForFieldName('function') : undefined;
  if (fn?.type === 'identifier' && fn.text === 'vars' && argsOf(node).length === 1 && !namespaceWrite(node)) {
    for (const value of resolveValues(argsOf(node)[0], context)) addEscape(out, value, '*', true);
  }
}

/** The escape one value use makes: a module value handed on, other than a plain `name = import_module(…)`. */
function valueEscape(node: PyNode, type: string, context: Context, out: Map<string, ModuleEscape>, insideImport: boolean): void {
  const parent = outerParent(node);
  const boundImport = type === 'call' && isImportFunction(node.childForFieldName('function'), context) && !escapesCall(node, parent);
  if (boundImport || !readAsValue(node, parent, insideImport) || setattrOperand(node, parent)) return;
  for (const value of resolveValues(node, context)) addEscape(out, value, '*', true);
}

/** The module values every module-scope import binding of the file names, as a use of its identifier would. */
function moduleScopeImports(context: Context): ModuleValue[] {
  return context.bindings
    .filter((binding) => binding.scope === '' && binding.kind === 'import' && binding.import !== undefined)
    .map((binding) => ({ receiver: binding.name, import: binding.import!, ...(binding.dotted && { dotted: true }) }));
}

/** Whether a `globals()`/`vars()` call's namespace is used only by a write form `write-nodes.ts` already reads. */
function namespaceWriteForm(call: PyNode, globals: boolean): boolean {
  const parent = outerParent(call);
  if (parent?.type === 'subscript' && unwrap(parent.childForFieldName('value'))?.id === call.id && inTarget(parent)) return true;
  const attribute = parent?.type === 'attribute' ? parent.childForFieldName('attribute')?.text : undefined;
  if (!globals || (attribute !== 'update' && attribute !== 'pop')) return false;
  const outer = outerParent(parent!);
  return outer?.type === 'call' && outer.childForFieldName('function')?.id === parent!.id;
}

/** Whether a call reads the file's own namespace in a way the write pass does not already read. */
function escapesGlobals(call: PyNode, context: Context): boolean {
  const fn = call.childForFieldName('function');
  const globals = isBuiltin(context, fn, 'globals');
  if (!globals) {
    // `vars()` with no arguments reads the module namespace only at module level; in a function it is the locals.
    if (!isBuiltin(context, fn, 'vars') || argsOf(call).length || context.scopesAt(startOf(call)).some((scope) => scope !== '')) return false;
  }
  return !namespaceWriteForm(call, globals);
}

/** Whether an identifier names a `def` of this file in its scope, so its `__globals__` is this module's namespace. */
function definedHere(context: Context, node: PyNode): boolean {
  return !!scopeBindings(context.bindings, context.scopesAt(startOf(node)), node.text)?.some((binding) => binding.kind === 'def');
}

/** The module a function value's `__globals__` names: the module its from-import comes from, or a submodule of an attribute chain. */
function functionModule(value: ModuleValue, context: Context): ModuleEscape | undefined {
  if (value.any || value.current || value.module !== undefined) return undefined;
  if (value.chain?.length) {
    const chain = value.chain.slice(0, -1);
    return { receiver: value.receiver, name: '*', ...(value.import !== undefined && { import: value.import }), ...(value.dotted && { dotted: true }), ...(chain.length && { chain }) };
  }
  if (value.import === undefined) return undefined;
  const imp = context.imports[value.import];
  const fromValue = imp?.names?.some((name) => name.local === value.receiver && name.imported !== '*');
  return fromValue ? { receiver: value.receiver, name: '*', import: value.import, binding: true } : undefined;
}

/** `X.__globals__` names a function's module; `X.f_globals` a frame's. An unknown receiver can reach any module. */
function globalsRead(node: PyNode, context: Context, out: Map<string, ModuleEscape>): void {
  if (node.type !== 'attribute') return;
  const attribute = node.childForFieldName('attribute')?.text;
  if (attribute === 'f_globals') return addEscape(out, { receiver: '', any: true }, '*', true);
  if (attribute !== '__globals__') return;
  const object = unwrap(node.childForFieldName('object'));
  const values = object ? resolveValues(object, context) : [];
  const modules = values.map((value) => functionModule(value, context));
  if (modules.length && modules.every((module) => !!module)) for (const module of modules) addEscape(out, module!, '*', true);
  else if (object?.type === 'identifier' && definedHere(context, object)) addEscape(out, { receiver: '', current: true }, '*', true);
  else addEscape(out, { receiver: '', any: true }, '*', true);
}

/** A resolved `sys.modules` read outside a literal-key subscript can hand out any module's namespace. */
function sysModulesRead(node: PyNode, context: Context, out: Map<string, ModuleEscape>): void {
  if (!isSysModules(node, context)) return;
  const parent = outerParent(node);
  if (parent?.type === 'subscript' && unwrap(parent.childForFieldName('value'))?.id === node.id) {
    const key = parent.childForFieldName('subscript');
    if ((key?.type === 'identifier' && key.text === '__name__') || stringConstant(key) !== undefined) return;
  }
  addEscape(out, { receiver: '', any: true }, '*', true);
}

/** An import function used other than as a callee can import and hand back any module. */
function importFunctionUse(node: PyNode, context: Context, out: Map<string, ModuleEscape>): void {
  if (!isImportFunction(node, context)) return;
  const parent = outerParent(node);
  if (parent?.type === 'call' && parent.childForFieldName('function')?.id === node.id) return;
  addEscape(out, { receiver: '', any: true }, '*', true);
}

/** `exec`/`eval` can import and rebind any module; the executing file's own bindings are read by the write pass. */
function executableCall(node: PyNode, context: Context, out: Map<string, ModuleEscape>): void {
  const fn = node.childForFieldName('function');
  if (isBuiltin(context, fn, 'exec') || isBuiltin(context, fn, 'eval')) addEscape(out, { receiver: '', any: true }, '*', true);
}

/** Every module value of the file that escapes as a value: bindings, attribute chains, `sys.modules` entries, calls. */
function collectEscapes(root: PyNode, context: Context, out: Map<string, ModuleEscape>): void {
  const visit = (node: PyNode, insideImport: boolean): void => {
    const type = node.type;
    if (type === 'attribute' || type === 'subscript' || type === 'call') namespaceEscape(node, type, context, out);
    if (type === 'call') {
      executableCall(node, context, out);
      if (!insideImport && escapesGlobals(node, context)) for (const value of moduleScopeImports(context)) addEscape(out, value, '*', true);
    }
    if (!insideImport && (type === 'identifier' || type === 'attribute')) {
      sysModulesRead(node, context, out);
      importFunctionUse(node, context, out);
      globalsRead(node, context, out);
    }
    if (VALUE_TYPES.has(type)) valueEscape(node, type, context, out, insideImport);
    const nested = insideImport || inImport(type);
    for (const child of node.namedChildren) if (child) visit(child, nested);
  };
  visit(root, false);
}

/** The names the file's import bindings may bind from `spec`, importing one of `names`, in any scope. */
function importBoundNames(bindings: readonly PyBinding[], imports: Context['imports'], spec: string, names: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const binding of bindings) {
    if (binding.kind !== 'import' || binding.import === undefined) continue;
    const imp = imports[binding.import];
    if (imp?.spec !== spec) continue;
    if ((imp.names ?? []).some((name) => name.local === binding.name && names.includes(name.imported))) out.add(binding.name);
  }
  return out;
}

/**
 * The module writes an escaping module value makes (COD-59 round 3): an import binding (or every one the scope holds of
 * the name) used as a value, an attribute chain that names a repo submodule and is handed on, a `sys.modules` entry, and
 * a callee resolving to `importlib.import_module`/`__import__` whose result is not a plain name assignment. Direct
 * writes and namespace accesses (`setattr`, `__dict__`, `vars`) name the attribute they write; every other use is `*`.
 */
export function moduleEscapes(root: PyNode, symbols: readonly CodeSymbol[], bindings: readonly PyBinding[], index: ImportIndex, imports: Context['imports']): ModuleEscape[] {
  const context: Context = {
    symbols,
    bindings,
    index,
    imports,
    scopesAt: scopesOf(symbols),
    sysModuleNames: importBoundNames(bindings, imports, 'sys', ['modules']),
    importFunctionNames: importBoundNames(bindings, imports, 'importlib', ['import_module', '__import__']),
  };
  const out = new Map<string, ModuleEscape>();
  collectWrites(root, context, out);
  collectEscapes(root, context, out);
  return [...out.values()];
}

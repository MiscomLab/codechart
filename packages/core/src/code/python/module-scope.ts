import type { Node } from 'web-tree-sitter';
import type { ModuleExports } from '../imports.js';
import type { CodeRange, CodeSymbol } from '../model.js';
import { nodeRange } from '../tree.js';
import { annotationExpressions, declared, defaultRanges, defaultValues, deferredRanges, identifiers, parameterNames, targets, typeParameterNames, typeParametersIn } from './scope-nodes.js';

/**
 * One name a Python scope binds. `scope` is the id of the function or class whose body binds it, `''` for the module.
 * `import` points at the file's import by index; `def` is a `def` or `class`; `other` is any other write (assignment,
 * parameter, loop or `with` target, `del`, `global` write), with `built` set for `name = Name(…)`.
 */
export interface PyBinding {
  scope: string;
  name: string;
  kind: 'import' | 'def' | 'other';
  import?: number;
  /** For `import a.b` without an alias: binds `a`, and `a.b` stays reachable through it. */
  dotted?: boolean;
  built?: string;
  /** Ranges the binding is not yet in scope for: a generic definition's parameter default values. */
  except?: CodeRange[];
  /** When set, the binding is in scope only inside these ranges: a type alias's own type parameters. */
  within?: CodeRange[];
  /** A type alias's own type parameter: local to the alias value, never an export. */
  alias?: boolean;
  /** A class-body binding made inside an `if`, `try`, loop, `with` or `match` of that body: it may never have run. */
  conditional?: boolean;
  /** Where the binding is written; a class body's binding is only visible to later calls in its headers and body. */
  start?: CodeRange['start'];
}

/** The import index of each import or import call node, by node id; the extractor fills it. */
export type ImportIndex = ReadonlyMap<number, { locals: { name: string; dotted: boolean; index: number }[]; typeOnly: boolean; wildcard: boolean }>;

/** A Python definition's scope id and where its body starts: calls before it sit in the header (defaults, annotations). */
export interface PyDefinition {
  id: string;
  body: CodeRange['start'];
}

/** The id of a definition's PEP 695 type-parameter scope, which encloses its annotations but not its defaults. */
const typeParamsScope = (scope: string): string => `${scope}#typeparams`;

/**
 * Every name every scope of a Python file binds, by Python's scoping rules: a function's parameters and writes are its
 * own; a class body is a scope its methods do not see; comprehensions and lambdas have their own scope. Scope ids are
 * the symbols `extractSymbols` found for each `def` and `class`.
 */
export function collectBindings(root: Node, symbols: readonly CodeSymbol[], imports: ImportIndex): { bindings: PyBinding[]; defs: PyDefinition[]; deferred: CodeRange[] } {
  const out: PyBinding[] = [];
  const defs: PyDefinition[] = [];
  const deferred: CodeRange[] = [];
  const idAt = new Map(symbols.map((s) => [`${s.range.start.line}:${s.range.start.column}`, s.id]));
  const walker: Walker = { out, defs, deferred, imports, scopeOf: (def) => idAt.get(`${def.startPosition.row + 1}:${def.startPosition.column}`) ?? `?${def.id}` };
  walk(walker, root, { scope: '', isFunction: false, outer: [], globals: new Set(), nonlocals: new Set() });
  return { bindings: out, defs, deferred };
}

interface Walker {
  out: PyBinding[];
  defs: PyDefinition[];
  deferred: CodeRange[];
  imports: ImportIndex;
  scopeOf: (def: Node) => string;
}

/** Where writes land: the current scope, the enclosing function scopes, and names redirected by `global` / `nonlocal`. */
interface Scope {
  scope: string;
  isFunction: boolean;
  /** The function scopes around this one, innermost first; class bodies are not among them. */
  outer: readonly string[];
  globals: ReadonlySet<string>;
  nonlocals: ReadonlySet<string>;
  /** PEP 695 type parameters in scope here: this body's own and every enclosing generic definition's. */
  typeParams?: readonly string[];
  /** Inside a compound statement of this body: a binding made here may or may not have run. */
  conditional?: boolean;
  /** After a `raise`, `break` or `continue` in the same block: nothing here runs, so a class body binds nothing here. */
  dead?: boolean;
}

const JUMPS = new Set(['raise_statement', 'break_statement', 'continue_statement']);
const COMPOUND = new Set(['if_statement', 'try_statement', 'for_statement', 'while_statement', 'with_statement', 'match_statement']);

type Bind = (name: string, kind: PyBinding['kind'], extra?: Partial<PyBinding>) => void;

function binder(w: Walker, at: Scope): Bind {
  return (name, kind, extra = {}) => {
    // Only a class body looks names up by running: in a function a name assigned anywhere is local, run or not.
    if (at.dead && !at.isFunction && at.scope) return;
    if (at.globals.has(name)) w.out.push({ scope: '', name, kind, ...extra });
    // `nonlocal f` writes an enclosing function's f; which one is not tracked, so every enclosing scope loses its proof.
    else if (at.nonlocals.has(name)) for (const outer of at.outer) w.out.push({ scope: outer, name, kind: 'other' });
    else w.out.push({ scope: at.scope, name, kind, ...(at.conditional && !at.isFunction && at.scope && { conditional: true }), ...extra });
  };
}

/** The scope a statement runs in: inside a compound statement or after a jump, its bindings are conditional or dead. */
function childScope(scope: Scope, child: Node, dead: boolean): Scope {
  if (COMPOUND.has(child.type) && !scope.conditional) return { ...scope, conditional: true, dead };
  return dead === !!scope.dead ? scope : { ...scope, dead };
}

/** Binds the names an import node brings in; false when the node is not an import. */
function bindImports(w: Walker, node: Node, bind: Bind): boolean {
  const imported = w.imports.get(node.id);
  if (!imported) return false;
  const start = nodeRange(node).start;
  if (imported.wildcard) bind('*', 'other', { start });
  if (!imported.typeOnly) for (const l of imported.locals) bind(l.name, 'import', { import: l.index, start, ...(l.dotted && { dotted: true }) });
  return true;
}

function walk(w: Walker, node: Node, scope: Scope): void {
  // A lambda may itself be the expression walked (a parameter default): its own parameters bind where it is written.
  if (node.type === 'lambda') for (const p of parameterNames(node.childForFieldName('parameters'))) binder(w, scope)(p, 'other', { start: nodeRange(node).start });
  for (const range of deferredRanges(node)) w.deferred.push(range);
  let dead = !!scope.dead;
  for (const child of node.namedChildren) {
    if (!child) continue;
    // The target of a `for`, a `with` or an `except` is bound only if the compound statement runs that far.
    const at = childScope(scope, child, dead);
    if (JUMPS.has(child.type)) dead = true;
    const bind = binder(w, at);
    const inner = child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
    if (inner?.type === 'function_definition' || inner?.type === 'class_definition') {
      walkDecorators(w, child, at);
      enterDefinition(w, inner, bind, at);
      continue;
    }
    if (child.type === 'type_alias_statement') {
      bindTypeAlias(w, child, bind, at);
      continue;
    }
    if (bindImports(w, child, bind)) continue;
    // A comprehension, lambda or `case` pattern binds names a call inside it sees instead of the enclosing ones. Calls are
    // attributed to the enclosing function, so those names count as writes there: the call is then not proven.
    if (child.type === 'case_pattern') for (const name of identifiers(child)) bind(name, 'other', { start: nodeRange(child).start });
    bindWrites(w, child, bind);
    walk(w, child, at);
  }
}

/** Decorator expressions run in the scope enclosing the definition they decorate. */
function walkDecorators(w: Walker, node: Node, at: Scope): void {
  for (const child of node.namedChildren) if (child?.type === 'decorator') walk(w, child, at);
}

/** A type alias binds its name here; its own type parameters live in its value only, never in the enclosing scope. */
function bindTypeAlias(w: Walker, node: Node, bind: Bind, at: Scope): void {
  const left = node.childForFieldName('left');
  const value = node.childForFieldName('right');
  // The value and the bounds evaluate lazily, but a lambda or comprehension in them is a scope like in an annotation.
  if (value) walk(w, value, at);
  const bounds = typeParametersIn(left);
  if (bounds) walk(w, bounds, at);
  const name = left ? identifiers(left)[0] : undefined;
  const start = nodeRange(node).start;
  if (name) bind(name, 'other', { start });
  const within = [nodeRange(node)];
  for (const typeParam of typeParameterNames(typeParametersIn(left))) bind(typeParam, 'other', { within, alias: true, start });
}

/**
 * Binds a definition's own and inherited type parameters in its scope and in the header's synthetic type-parameter
 * scope (annotations and class headers see them; defaults are excluded by `except`).
 */
function bindTypeParameters(w: Walker, own: string, inherited: readonly string[], typeParams: readonly string[], except: CodeRange[]): void {
  const annotationScope = typeParamsScope(own);
  for (const typeParam of inherited) {
    w.out.push({ scope: own, name: typeParam, kind: 'other' });
    w.out.push({ scope: annotationScope, name: typeParam, kind: 'other' });
  }
  for (const typeParam of typeParams) {
    w.out.push({ scope: own, name: typeParam, kind: 'other', ...(except.length && { except }) });
    w.out.push({ scope: annotationScope, name: typeParam, kind: 'other', ...(except.length && { except }) });
  }
}

/** A `def` or `class` binds its name here; its parameters and body bind in its own scope. */
function enterDefinition(w: Walker, def: Node, bind: Bind, at: Scope): void {
  const name = def.childForFieldName('name')?.text;
  if (name) bind(name, 'def', { start: nodeRange(def).start });
  const own = w.scopeOf(def);
  const fn = def.type === 'function_definition';
  const typeParams = typeParameterNames(def.childForFieldName('type_parameters'));
  const inherited = at.typeParams ?? [];
  const body = def.childForFieldName('body');
  const parameters = def.childForFieldName('parameters');
  // Defaults and class bases/keywords run in the enclosing scope, before the definition exists.
  if (fn) for (const value of defaultValues(parameters)) walk(w, value, at);
  if (fn) for (const annotation of annotationExpressions(def, parameters)) walk(w, annotation, at);
  const typeParameterList = def.childForFieldName('type_parameters');
  if (typeParameterList) walk(w, typeParameterList, at);
  const bases = fn ? undefined : def.childForFieldName('superclasses');
  if (bases) walk(w, bases, at);
  // Enclosing type parameters are live throughout nested definitions; a definition's own are not live in its defaults.
  const except = fn ? defaultRanges(parameters) : [];
  bindTypeParameters(w, own, inherited, typeParams, except);
  if (fn) for (const p of parameterNames(parameters)) w.out.push({ scope: own, name: p, kind: 'other' });
  if (body) w.defs.push({ id: own, body: nodeRange(body).start });
  if (!body) return;
  // `global f` / `nonlocal f` in a class body sends its writes elsewhere while reads still reach the class: unprovable.
  if (!fn) for (const name of [...declared(body, 'global_statement'), ...declared(body, 'nonlocal_statement')]) w.out.push({ scope: own, name, kind: 'other' });
  const outer = at.isFunction ? [at.scope, ...at.outer] : at.outer;
  walk(w, body, {
    scope: own,
    isFunction: fn,
    outer,
    globals: new Set(declared(body, 'global_statement')),
    nonlocals: new Set(declared(body, 'nonlocal_statement')),
    typeParams: [...inherited, ...typeParams],
  });
}

/** The names that writes in `node` bind in the current scope. */
function bindWrites(w: Walker, node: Node, bind: Bind): void {
  const start = nodeRange(node).start;
  if (node.type === 'assignment') {
    const right = node.childForFieldName('right');
    // `m = importlib.import_module('x')` binds `m` through the import itself.
    if (right && w.imports.get(right.id)?.locals.length) return;
    const callee = right?.type === 'call' ? right.childForFieldName('function') : undefined;
    const left = node.childForFieldName('left');
    const built = left?.type === 'identifier' && callee?.type === 'identifier' ? { built: callee.text } : {};
    for (const name of targets(left)) bind(name, 'other', { ...built, start });
    return;
  }
  const field = WRITES[node.type];
  // A walrus can sit behind a short-circuit, so it is never an unconditional binding.
  if (field) for (const name of targets(node.childForFieldName(field))) bind(name, 'other', { start, ...(node.type === 'named_expression' && { conditional: true }) });
  else if (node.type === 'delete_statement') for (const name of node.namedChildren.flatMap((c) => targets(c))) bind(name, 'other', { start });
}

/** Statements that write a name, and the field holding the target. */
const WRITES: Record<string, string> = {
  augmented_assignment: 'left',
  for_statement: 'left',
  for_in_clause: 'left',
  as_pattern: 'alias',
  named_expression: 'name',
};

/**
 * The names a module exports: each name bound once at module scope. A name bound more than once (two branches, an
 * import and a definition, a reassignment) has no provable binding, so it is left out and the list is not complete.
 * A wildcard import or a module `__getattr__` can add names nobody lists.
 */
export function moduleExports(bindings: readonly PyBinding[], wildcard: boolean): ModuleExports {
  const byName = new Map<string, PyBinding[]>();
  // A star import can rebind any module name after the line that defines it: no name is provable.
  if (wildcard) return { names: [], complete: false };
  for (const b of bindings) if (b.scope === '' && !b.alias) byName.set(b.name, [...(byName.get(b.name) ?? []), b]);
  const names: ModuleExports['names'] = [];
  let complete = !byName.has('__getattr__');
  for (const [name, list] of byName) {
    if (list.length > 1 && !list.every((b) => b.dotted)) {
      complete = false;
      continue;
    }
    // An import binding names its own local, which the tracer follows through the import that binds it.
    names.push(list[0]!.kind === 'import' && !list[0]!.dotted ? { name, local: name } : { name });
  }
  return { names, complete };
}

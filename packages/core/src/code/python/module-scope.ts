import type { PyNode } from './py-tree.js';
import type { ClassInfo, CodeRange, CodeSymbol } from '../model.js';
import { nodeRange } from '../tree.js';
import { annotationExpressions, baseNames, declared, defaultRanges, defaultValues, deferredRanges, hasMetaclass, identifiers, opaqueBase, parameterNames, targets, typeClasses, typeParameterNames, typeCheckingGuard, typeParametersIn } from './scope-nodes.js';
import { attributeWrites, dynamicModuleBindings } from './write-nodes.js';

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
  /** A class- or function-body binding made inside an `if`, `try`, loop, `with` or `match`, or after a jump: it may never have run. */
  conditional?: boolean;
  /** A binding under a statement that provably never runs (`if False:`), so it does not exist at runtime. */
  never?: boolean;
  /** The `if not TYPE_CHECKING` guards this binding sits under; they run only if the name is typing's constant. */
  guards?: string[];
  /** A write `self.name = …` in a method of the class this scope is: the class attribute may be replaced per instance. */
  attr?: boolean;
  /** For `name = other`: the name whose value this binding takes, followed when comparing a base with its aliases. */
  aliasedTo?: string;
  /** A class's PEP 695 type parameter seen inside a method body: the method's own binding of the name wins. */
  inherited?: boolean;
  /** Where the binding is written; a class body's binding is only visible to later calls in its headers and body. */
  start?: CodeRange['start'];
}

/** The import index of each import or import call node, by node id; the extractor fills it, `at` being its first import. */
export type ImportIndex = ReadonlyMap<number, { locals: { name: string; dotted: boolean; index: number }[]; typeOnly: boolean; wildcard: boolean; at: number }>;

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
export function collectBindings(root: PyNode, symbols: readonly CodeSymbol[], imports: ImportIndex): { bindings: PyBinding[]; defs: PyDefinition[]; deferred: CodeRange[]; lambdas: CodeRange[]; classes: ClassInfo[] } {
  const out: PyBinding[] = [];
  const defs: PyDefinition[] = [];
  const deferred: CodeRange[] = [];
  const lambdas: CodeRange[] = [];
  const classes: ClassInfo[] = [];
  const idAt = new Map(symbols.map((s) => [`${s.range.start.line}:${s.range.start.column}`, s.id]));
  const walker: Walker = { out, defs, deferred, lambdas, classes, imports, scopeOf: (def) => idAt.get(`${def.startPosition.row + 1}:${def.startPosition.column}`) ?? `?${def.id}` };
  walk(walker, root, { scope: '', isFunction: false, outer: [], globals: new Set(), nonlocals: new Set() });
  // A write through `globals()`, `vars()`, `sys.modules[__name__]` or `exec` rebinds a module name at run time.
  for (const { name, start } of dynamicModuleBindings(root)) out.push({ scope: '', name, kind: 'other', start });
  for (const info of classes) {
    info.members = out.filter((b) => b.scope === info.id && !b.attr).map((b) => b.name);
    info.writes = out.filter((b) => b.scope === info.id && b.attr).map((b) => b.name);
  }
  // `type("L", (K,), {"f": …})` creates a class the class statements do not; its dict keys are what it binds.
  classes.push(...typeClasses(root));
  return { bindings: out, defs, deferred, lambdas, classes };
}

interface Walker {
  out: PyBinding[];
  defs: PyDefinition[];
  deferred: CodeRange[];
  lambdas: CodeRange[];
  classes: ClassInfo[];
  imports: ImportIndex;
  scopeOf: (def: PyNode) => string;
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
  /** After a `raise`, `break`, `continue` or `return` in the same block: nothing here runs, so a class body binds nothing here. */
  dead?: boolean;
  /** The `if not TYPE_CHECKING:` guards around this statement, which count as running if each guard is provably typing's. */
  guards?: readonly string[];
  /** Inside a statement that never runs (`if False:`): a binding here does not exist at runtime. */
  never?: boolean;
}

const JUMPS = new Set(['raise_statement', 'break_statement', 'continue_statement', 'return_statement']);
const COMPOUND = new Set(['if_statement', 'try_statement', 'for_statement', 'while_statement', 'with_statement', 'match_statement']);

type Bind = (name: string, kind: PyBinding['kind'], extra?: Partial<PyBinding>) => void;

function binder(w: Walker, at: Scope): Bind {
  return (name, kind, extra = {}) => {
    // Only a class body looks names up by running: in a function a name assigned anywhere is local, run or not.
    if (at.dead && !at.isFunction && at.scope) return;
    // A function, or the module, where a binding may not have run still binds the name but proves no target.
    const unsure = at.conditional || at.dead;
    if (at.globals.has(name)) w.out.push({ scope: '', name, kind, ...extra });
    // `nonlocal f` writes an enclosing function's f; which one is not tracked, so every enclosing scope loses its proof.
    else if (at.nonlocals.has(name)) for (const outer of at.outer) w.out.push({ scope: outer, name, kind: 'other' });
    else w.out.push({ scope: at.scope, name, kind, ...(unsure && { conditional: true }), ...(unsure && at.never && { never: true }), ...(!unsure && at.guards && { guards: [...at.guards] }), ...extra });
  };
}

/** Whether a compound statement's test is a literal that is always falsy: its body never runs. */
function neverRuns(node: PyNode): boolean {
  if (node.type !== 'if_statement' && node.type !== 'while_statement') return false;
  const test = node.childForFieldName('condition');
  return test?.type === 'false' || test?.type === 'none' || (test?.type === 'integer' && test.text === '0');
}

/** The scope a statement runs in: inside a compound statement or after a jump, its bindings are conditional or dead. */
function childScope(scope: Scope, child: PyNode, dead: boolean): Scope {
  const guard = COMPOUND.has(child.type) && !scope.conditional ? typeCheckingGuard(child) : undefined;
  if (guard) return { ...scope, guards: [...(scope.guards ?? []), guard], dead };
  if (COMPOUND.has(child.type) && !scope.conditional) return { ...scope, conditional: true, dead, ...(neverRuns(child) && { never: true }) };
  return dead === !!scope.dead ? scope : { ...scope, dead };
}

/** Binds the names an import node brings in; false when the node is not an import. */
function bindImports(w: Walker, node: PyNode, bind: Bind): boolean {
  const imported = w.imports.get(node.id);
  if (!imported) return false;
  const start = nodeRange(node).start;
  if (imported.wildcard) bind('*', 'other', { start });
  if (!imported.typeOnly) for (const l of imported.locals) bind(l.name, 'import', { import: l.index, start, ...(l.dotted && { dotted: true }) });
  return true;
}

function walk(w: Walker, node: PyNode, scope: Scope): void {
  // A lambda may itself be the expression walked (a parameter default): its own parameters bind where it is written.
  if (node.type === 'lambda') for (const p of parameterNames(node.childForFieldName('parameters'))) binder(w, scope)(p, 'other', { start: nodeRange(node).start });
  for (const range of deferredRanges(node)) w.deferred.push(range);
  if (node.type === 'lambda' && node.childForFieldName('body')) w.lambdas.push(nodeRange(node.childForFieldName('body')!));
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
function walkDecorators(w: Walker, node: PyNode, at: Scope): void {
  for (const child of node.namedChildren) if (child?.type === 'decorator') walk(w, child, at);
}

/** A type alias binds its name here; its own type parameters live in its value only, never in the enclosing scope. */
function bindTypeAlias(w: Walker, node: PyNode, bind: Bind, at: Scope): void {
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
 * scope (annotations and class headers see them; defaults are excluded by `except`). An inherited one is marked so a
 * method's own binding of the name, or its `global`/`nonlocal`, wins over it.
 */
function bindTypeParameters(w: Walker, own: string, inherited: readonly string[], typeParams: readonly string[], except: CodeRange[]): void {
  const annotationScope = typeParamsScope(own);
  for (const typeParam of inherited) {
    w.out.push({ scope: own, name: typeParam, kind: 'other', inherited: true });
    w.out.push({ scope: annotationScope, name: typeParam, kind: 'other' });
  }
  for (const typeParam of typeParams) {
    w.out.push({ scope: own, name: typeParam, kind: 'other', ...(except.length && { except }) });
    w.out.push({ scope: annotationScope, name: typeParam, kind: 'other', ...(except.length && { except }) });
  }
}

/** A class's name and bases for the dispatch index; its members and writes are read from the bindings once all are made. */
function recordClass(w: Walker, def: PyNode, id: string): void {
  if (def.type !== 'class_definition') return;
  const superclasses = def.childForFieldName('superclasses');
  w.classes.push({
    id,
    name: def.childForFieldName('name')?.text ?? '',
    bases: baseNames(superclasses),
    members: [],
    writes: [],
    ...(hasMetaclass(superclasses) && { metaclass: true }),
    ...(opaqueBase(superclasses) && { opaqueBase: true }),
  });
}

/** A method's `self.f = …` writes poison the class attribute `f` for member calls, though not for a bare name. */
function bindAttributeWrites(w: Walker, def: PyNode, at: Scope): void {
  const body = def.childForFieldName('body');
  if (def.type !== 'function_definition' || !body || at.isFunction || !at.scope) return;
  for (const attr of attributeWrites(body, parameterNames(def.childForFieldName('parameters'))[0])) w.out.push({ scope: at.scope, name: attr, kind: 'other', attr: true });
}

/** A decorator's return value is what a decorated definition's name binds, so it proves no target. */
const definitionKind = (def: PyNode): PyBinding['kind'] => (def.parent?.type === 'decorated_definition' ? 'other' : 'def');

/**
 * A `def` or `class` binds its name here; its parameters and body bind in its own scope. A method's `global`/`nonlocal`
 * of an inherited type parameter makes that name reach the outer scope, so the inherited binding is not recorded.
 */
function enterDefinition(w: Walker, def: PyNode, bind: Bind, at: Scope): void {
  const name = def.childForFieldName('name')?.text;
  if (name) bind(name, definitionKind(def), { start: nodeRange(def).start });
  const own = w.scopeOf(def);
  const fn = def.type === 'function_definition';
  const typeParams = typeParameterNames(def.childForFieldName('type_parameters'));
  const inherited = at.typeParams ?? [];
  const body = def.childForFieldName('body');
  const parameters = def.childForFieldName('parameters');
  const globals = declaredNames(body, 'global_statement');
  const nonlocals = declaredNames(body, 'nonlocal_statement');
  // Defaults and class bases/keywords run in the enclosing scope, before the definition exists.
  if (fn) for (const value of defaultValues(parameters)) walk(w, value, at);
  if (fn) for (const annotation of annotationExpressions(def, parameters)) walk(w, annotation, at);
  const typeParameterList = def.childForFieldName('type_parameters');
  if (typeParameterList) walk(w, typeParameterList, at);
  const bases = fn ? undefined : def.childForFieldName('superclasses');
  if (bases) walk(w, bases, at);
  // Enclosing type parameters are live throughout nested definitions; a definition's own are not live in its defaults.
  const except = fn ? defaultRanges(parameters) : [];
  bindTypeParameters(w, own, inherited.filter((param) => !globals.has(param) && !nonlocals.has(param)), typeParams, except);
  if (fn) for (const p of parameterNames(parameters)) w.out.push({ scope: own, name: p, kind: 'other' });
  if (body) w.defs.push({ id: own, body: nodeRange(body).start });
  bindAttributeWrites(w, def, at);
  recordClass(w, def, own);
  if (!body) return;
  // `global f` / `nonlocal f` in a class body sends its writes elsewhere while reads still reach the class: unprovable.
  if (!fn) for (const declaredName of [...globals, ...nonlocals]) w.out.push({ scope: own, name: declaredName, kind: 'other' });
  const outer = at.isFunction ? [at.scope, ...at.outer] : at.outer;
  walk(w, body, {
    scope: own,
    isFunction: fn,
    outer,
    globals,
    nonlocals,
    typeParams: [...inherited, ...typeParams],
  });
}

/** The names a body declares with `global` or `nonlocal`, which make those names belong to another scope. */
const declaredNames = (body: PyNode | null, statement: 'global_statement' | 'nonlocal_statement'): Set<string> => new Set(body ? declared(body, statement) : []);

/** The names that writes in `node` bind in the current scope. */
function bindWrites(w: Walker, node: PyNode, bind: Bind): void {
  const start = nodeRange(node).start;
  if (node.type === 'assignment') {
    const right = node.childForFieldName('right');
    // `m = importlib.import_module('x')` binds `m` through the import itself.
    if (right && w.imports.get(right.id)?.locals.length) return;
    const callee = right?.type === 'call' ? right.childForFieldName('function') : undefined;
    const left = node.childForFieldName('left');
    const built = left?.type === 'identifier' && callee?.type === 'identifier' ? { built: callee.text } : {};
    const alias = right?.type === 'identifier' ? { aliasedTo: right.text } : {};
    for (const name of targets(left)) bind(name, 'other', { ...built, ...alias, start });
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

import type { Node } from 'web-tree-sitter';
import type { ModuleExports } from '../imports.js';
import type { CodeSymbol } from '../model.js';

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
  /** A PEP 695 type parameter: bound only from this point on (the definition's body), not in its own parameter defaults. */
  from?: { line: number; column: number };
}

const PATTERNS = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'list_splat_pattern', 'as_pattern_target', 'parenthesized_expression']);
const PARAMETERS = new Set(['default_parameter', 'typed_parameter', 'typed_default_parameter', 'list_splat_pattern', 'dictionary_splat_pattern']);

/** Identifiers a write target binds: `a`, `a, b`, `(a, [b, *c])`. Attributes and subscripts bind no name. */
function targets(node: Node | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'identifier') return [node.text];
  if (PATTERNS.has(node.type)) return node.namedChildren.flatMap((c) => targets(c));
  return [];
}

function parameterNames(params: Node | null): string[] {
  return (params?.namedChildren ?? []).flatMap((p) => {
    if (!p) return [];
    if (p.type === 'identifier') return [p.text];
    if (PARAMETERS.has(p.type)) return targets(p.childForFieldName('name') ?? p.namedChildren.find((c) => c?.type === 'identifier'));
    return [];
  });
}

/** The import index of each import or import call node, by node id; the extractor fills it. */
export type ImportIndex = ReadonlyMap<number, { locals: { name: string; dotted: boolean; index: number }[]; typeOnly: boolean; wildcard: boolean }>;

/** The name each PEP 695 type parameter binds: `[T: int, *Ts, **P]` binds `T`, `Ts` and `P`. */
function typeParameterNames(def: Node): string[] {
  const list = def.childForFieldName('type_parameters');
  return (list?.namedChildren ?? []).flatMap((parameter) => {
    const name = parameter ? identifiers(parameter)[0] : undefined;
    return name ? [name] : [];
  });
}

/**
 * Every name every scope of a Python file binds, by Python's scoping rules: a function's parameters and writes are its
 * own; a class body is a scope its methods do not see; comprehensions and lambdas have their own scope. Scope ids are
 * the symbols `extractSymbols` found for each `def` and `class`.
 */
export function collectBindings(root: Node, symbols: readonly CodeSymbol[], imports: ImportIndex): PyBinding[] {
  const out: PyBinding[] = [];
  const idAt = new Map(symbols.map((s) => [`${s.range.start.line}:${s.range.start.column}`, s.id]));
  const walker: Walker = { out, imports, scopeOf: (def) => idAt.get(`${def.startPosition.row + 1}:${def.startPosition.column}`) ?? `?${def.id}` };
  walk(walker, root, { scope: '', isFunction: false, outer: [], globals: new Set(), nonlocals: new Set() });
  return out;
}

interface Walker {
  out: PyBinding[];
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
  /** In a class body: its type parameters, which its methods also see (PEP 695). */
  classTypeParams?: readonly string[];
}

type Bind = (name: string, kind: PyBinding['kind'], extra?: Partial<PyBinding>) => void;

function binder(w: Walker, at: Scope): Bind {
  return (name, kind, extra = {}) => {
    if (at.globals.has(name)) w.out.push({ scope: '', name, kind, ...extra });
    // `nonlocal f` writes an enclosing function's f; which one is not tracked, so every enclosing scope loses its proof.
    else if (at.nonlocals.has(name)) for (const outer of at.outer) w.out.push({ scope: outer, name, kind: 'other' });
    else w.out.push({ scope: at.scope, name, kind, ...extra });
  };
}

function walk(w: Walker, node: Node, at: Scope): void {
  const bind = binder(w, at);
  for (const child of node.namedChildren) {
    if (!child) continue;
    const inner = child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
    if (inner?.type === 'function_definition' || inner?.type === 'class_definition') {
      enterDefinition(w, inner, bind, at);
      continue;
    }
    if (child.type === 'type_alias_statement') {
      const left = child.childForFieldName('left');
      const name = left ? identifiers(left)[0] : undefined;
      if (name) bind(name, 'other');
      continue;
    }
    const imported = w.imports.get(child.id);
    if (imported) {
      if (imported.wildcard) bind('*', 'other');
      if (!imported.typeOnly) for (const l of imported.locals) bind(l.name, 'import', { import: l.index, ...(l.dotted && { dotted: true }) });
      continue;
    }
    // A comprehension, lambda or `case` pattern binds names a call inside it sees instead of the enclosing ones. Calls are
    // attributed to the enclosing function, so those names count as writes there: the call is then not proven.
    if (child.type === 'lambda') for (const p of parameterNames(child.childForFieldName('parameters'))) bind(p, 'other');
    if (child.type === 'case_pattern') for (const name of identifiers(child)) bind(name, 'other');
    bindWrites(w, child, bind);
    walk(w, child, at);
  }
}

/** A `def` or `class` binds its name here; its parameters and body bind in its own scope. */
function enterDefinition(w: Walker, def: Node, bind: Bind, at: Scope): void {
  const name = def.childForFieldName('name')?.text;
  if (name) bind(name, 'def');
  const own = w.scopeOf(def);
  const fn = def.type === 'function_definition';
  const typeParams = typeParameterNames(def);
  const body = def.childForFieldName('body');
  const from = body ? { line: body.startPosition.row + 1, column: body.startPosition.column } : undefined;
  // A definition's own type parameters are not in scope for its parameter defaults; a class's are in its whole body.
  for (const typeParam of typeParams) w.out.push({ scope: own, name: typeParam, kind: 'other', ...(from && { from }) });
  if (fn) {
    for (const typeParam of at.classTypeParams ?? []) w.out.push({ scope: own, name: typeParam, kind: 'other' });
    for (const p of parameterNames(def.childForFieldName('parameters'))) w.out.push({ scope: own, name: p, kind: 'other' });
  }
  if (!body) return;
  const outer = at.isFunction ? [at.scope, ...at.outer] : at.outer;
  const inner: Scope = {
    scope: own,
    isFunction: fn,
    outer,
    globals: new Set(declared(body, 'global_statement')),
    nonlocals: new Set(declared(body, 'nonlocal_statement')),
  };
  if (!fn) inner.classTypeParams = typeParams;
  walk(w, body, inner);
}

function identifiers(node: Node): string[] {
  if (node.type === 'identifier') return [node.text];
  return node.namedChildren.flatMap((c) => (c ? identifiers(c) : []));
}

/** The names that writes in `node` bind in the current scope. */
function bindWrites(w: Walker, node: Node, bind: Bind): void {
  if (node.type === 'assignment') {
    const right = node.childForFieldName('right');
    // `m = importlib.import_module('x')` binds `m` through the import itself.
    if (right && w.imports.get(right.id)?.locals.length) return;
    const callee = right?.type === 'call' ? right.childForFieldName('function') : undefined;
    const left = node.childForFieldName('left');
    const built = left?.type === 'identifier' && callee?.type === 'identifier' ? { built: callee.text } : {};
    for (const name of targets(left)) bind(name, 'other', built);
    return;
  }
  const field = WRITES[node.type];
  if (field) for (const name of targets(node.childForFieldName(field))) bind(name, 'other');
  else if (node.type === 'delete_statement') for (const name of node.namedChildren.flatMap((c) => targets(c))) bind(name, 'other');
}

/** Statements that write a name, and the field holding the target. */
const WRITES: Record<string, string> = {
  augmented_assignment: 'left',
  for_statement: 'left',
  for_in_clause: 'left',
  as_pattern: 'alias',
  named_expression: 'name',
};

/** Names a function body declares with `global` or `nonlocal`, so its writes to them land in another scope. */
function declared(body: Node, statement: 'global_statement' | 'nonlocal_statement'): string[] {
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
 * The names a module exports: each name bound once at module scope. A name bound more than once (two branches, an
 * import and a definition, a reassignment) has no provable binding, so it is left out and the list is not complete.
 * A wildcard import or a module `__getattr__` can add names nobody lists.
 */
export function moduleExports(bindings: readonly PyBinding[], wildcard: boolean): ModuleExports {
  const byName = new Map<string, PyBinding[]>();
  // A star import can rebind any module name after the line that defines it: no name is provable.
  if (wildcard) return { names: [], complete: false };
  for (const b of bindings) if (b.scope === '') byName.set(b.name, [...(byName.get(b.name) ?? []), b]);
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

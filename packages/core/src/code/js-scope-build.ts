import type { Node } from 'web-tree-sitter';
import { importNames, isUsing, parameterNames, patternNames, pointOf, startsWithUseStrict, strictFile, writeTargets } from './js-scope-decl.js';
import { meaningIn, NONE_MEANING, OTHER_MEANING } from './js-scope-mean.js';
import type { Binding, Scope, ScopeKind } from './js-scope-model.js';
import type { JsMeaning } from './js-scope.js';
import type { Import } from './model.js';

const OTHER: Binding = { kind: 'other' };
const IMPORT: Binding = { kind: 'import' };
const FUNCTION_VALUES = new Set(['arrow_function', 'generator_function', 'function_expression']);
const FUNCTION_NAMES = new Set(['generator_function', 'function_expression']);
const NESTED_BLOCKS = new Set(['statement_block', 'switch_body']);

type Handler = (node: Node, scope: Scope, strict: boolean) => void;

/** The scopes of one JS/TS file, built once and read per call site. */
export class Scopes {
  private readonly byNode = new Map<number, Scope>();

  private readonly handlers: Record<string, Handler> = {
    function_declaration: (node, scope, strict) => this.declaredFunction(node, scope, strict),
    generator_function_declaration: (node, scope, strict) => this.declaredFunction(node, scope, strict),
    function_signature: (node, scope, strict) => this.declaredFunction(node, scope, strict),
    function_expression: (node, scope, strict) => this.walkFunction(node, scope, strict),
    generator_function: (node, scope, strict) => this.walkFunction(node, scope, strict),
    arrow_function: (node, scope, strict) => this.walkFunction(node, scope, strict),
    method_definition: (node, scope, strict) => this.walkFunction(node, scope, strict),
    class_declaration: (node, scope, strict) => this.declareClass(node, scope, strict, true),
    abstract_class_declaration: (node, scope, strict) => this.declareClass(node, scope, strict, true),
    class: (node, scope, strict) => this.declareClass(node, scope, strict, false),
    import_statement: (node, scope) => this.declareImport(node, scope),
    import_alias: (node, scope) => this.declareAlias(node, scope),
    export_statement: (node, scope, strict) => this.walkExport(node, scope, strict),
    ambient_declaration: (node, scope, strict) => this.walkAmbient(node, scope, strict),
    lexical_declaration: (node, scope, strict) => this.declareLexical(node, scope, strict),
    variable_declaration: (node, scope, strict) => this.declareList(node, scope, 'var', strict),
    internal_module: (node, scope, strict) => this.declareModule(node, scope, strict),
    module: (node, scope, strict) => this.declareModule(node, scope, strict),
    enum_declaration: (node, scope) => {
      const name = node.childForFieldName('name');
      if (name) this.add(scope, name.text, OTHER);
    },
    catch_clause: (node, scope, strict) => this.walkCatch(node, scope, strict),
    for_statement: (node, scope, strict) => this.walkFor(node, scope, strict),
    for_in_statement: (node, scope, strict) => this.walkFor(node, scope, strict),
    switch_body: (node, scope, strict) => this.walkBlock(node, scope, strict),
    class_static_block: (node, scope) => this.walkBlock(node, scope, true, true),
    statement_block: (node, scope, strict) => this.walkBlock(node, scope, strict),
    assignment_expression: (node, scope, strict) => this.walkUsing(node, scope, strict),
  };

  constructor(root: Node, path: string, imports: readonly Import[]) {
    const writes = writeTargets(root);
    const program = this.make('program', root, undefined, strictFile(path, root));
    this.declareValueImports(program, imports);
    this.children(root, program, program.strict);
    // Declarations are complete now, so each write can be resolved to the one binding it actually reaches.
    for (const target of writes) this.markWritten(target);
  }

  /** Marks the first binding outward from a write as written; a write to a global marks nothing. */
  private markWritten(target: Node): void {
    for (let scope = this.nearestScope(target); scope; scope = scope.parent) {
      const entries = scope.decls.get(target.text);
      if (!entries) continue;
      for (const entry of entries) entry.written = true;
      return;
    }
  }

  /** Module-scope value imports bind their locals; a type-only one binds the name without a value a call could reach. */
  private declareValueImports(scope: Scope, imports: readonly Import[]): void {
    for (const imp of imports) {
      if (imp.kind !== 'import') continue;
      for (const name of imp.names ?? []) this.add(scope, name.local, imp.typeOnly || name.typeOnly ? OTHER : IMPORT);
    }
  }

  /** The first scope outward from `node` that declares `name`, and what it means there. */
  meaningAt(node: Node, name: string): JsMeaning {
    if (this.insideWith(node)) return OTHER_MEANING;
    for (let scope = this.nearestScope(node); scope; scope = scope.parent) {
      const meaning = meaningIn(scope, name);
      if (meaning) return meaning;
      if (scope.namespace) return OTHER_MEANING;
      if (scope.kind === 'program') return NONE_MEANING;
    }
    return NONE_MEANING;
  }

  /** Whether the node runs in the object environment record of a `with` body, which sits in front of every scope. */
  private insideWith(node: Node): boolean {
    for (let current: Node | null = node; current; current = current.parent) {
      const parent = current.parent;
      if (parent?.type === 'with_statement' && parent.childForFieldName('body')?.id === current.id) return true;
    }
    return false;
  }

  private nearestScope(node: Node): Scope | undefined {
    for (let current: Node | null = node; current; current = current.parent) {
      const scope = this.byNode.get(current.id);
      if (scope) return scope;
    }
    return undefined;
  }

  private make(kind: ScopeKind, node: Node, parent: Scope | undefined, strict: boolean): Scope {
    const scope: Scope = { kind, node, parent, strict, namespace: false, decls: new Map() };
    this.byNode.set(node.id, scope);
    return scope;
  }

  private children(node: Node, scope: Scope, strict: boolean): void {
    for (const child of node.namedChildren) if (child) this.walk(child, scope, strict);
  }

  private walk(node: Node, scope: Scope, strict: boolean): void {
    const handler = this.handlers[node.type];
    if (handler) handler(node, scope, strict);
    else this.children(node, scope, strict);
  }

  private add(scope: Scope, name: string, binding: Binding): void {
    // Each declaration gets its own binding object: a write marks this one, never a constant shared across parses.
    const entry = { ...binding };
    const entries = scope.decls.get(name);
    if (entries) entries.push(entry);
    else scope.decls.set(name, [entry]);
  }

  private varScope(scope: Scope): Scope {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      if (current.kind === 'function' || current.kind === 'program' || current.varBoundary) return current;
    }
    return scope;
  }

  private declaredFunction(node: Node, scope: Scope, strict: boolean): void {
    this.declareFunction(node, scope, strict);
    this.walkFunction(node, scope, strict);
  }

  /** Whether a body declaration redeclares a parameter: the two are one binding, which proves nothing. */
  private isParameterBinding(scope: Scope, name: string): boolean {
    return scope.kind === 'function' && scope.parent?.kind === 'params' && !!scope.parent.decls.get(name)?.length;
  }

  /** A function declaration binds here; in sloppy code a block-level one also weakly binds the enclosing function. */
  private declareFunction(node: Node, scope: Scope, strict: boolean): void {
    const name = node.childForFieldName('name');
    if (!name) return;
    const binding: Binding = this.isParameterBinding(scope, name.text)
      ? OTHER
      : { kind: 'def', start: pointOf(node), func: true, signature: node.type === 'function_signature' };
    this.add(scope, name.text, binding);
    if (strict || scope.kind !== 'block' || scope.namespace || !NESTED_BLOCKS.has(scope.node.type)) return;
    const owner = this.varScope(scope);
    if (owner !== scope) this.add(owner, name.text, OTHER);
  }

  /** A function-like node's parameters and body scopes; the body never sees its own parameters' defaults. */
  private walkFunction(node: Node, scope: Scope, strict: boolean): void {
    const name = FUNCTION_NAMES.has(node.type) ? node.childForFieldName('name') : undefined;
    const outer = name ? this.nameScope(node, scope, name.text, strict, { kind: 'def', start: pointOf(node), func: true }) : scope;
    const params = this.make('params', node, outer, strict);
    for (const parameter of parameterNames(node)) this.add(params, parameter, OTHER);
    const list = node.childForFieldName('parameters');
    if (list) this.children(list, params, strict);
    const single = node.childForFieldName('parameter');
    if (single) this.walk(single, params, strict);
    const body = node.childForFieldName('body');
    if (!body) return;
    const bodyStrict = strict || startsWithUseStrict(body);
    const inner = this.make('function', body, params, bodyStrict);
    // An expression body may itself be a function or class: it must go through its own handler, not have its children
    // walked as if it were a plain expression. A block body's declarations live in the function scope itself.
    if (body.type === 'statement_block') this.children(body, inner, bodyStrict);
    else this.walk(body, inner, bodyStrict);
  }

  private nameScope(node: Node, parent: Scope, name: string, strict: boolean, binding: Binding): Scope {
    const scope = this.make('name', node, parent, strict);
    this.add(scope, name, binding);
    return scope;
  }

  /** A class name binds in the enclosing scope; a class expression's own name binds inside it, and class bodies are strict. */
  private declareClass(node: Node, scope: Scope, strict: boolean, declaration: boolean): void {
    const name = node.childForFieldName('name');
    let inner = scope;
    if (name) {
      if (declaration) this.add(scope, name.text, OTHER);
      else inner = this.nameScope(node, scope, name.text, strict, OTHER);
    }
    for (const child of node.namedChildren) if (child && child.type !== 'class_body') this.walk(child, inner, strict);
    const body = node.childForFieldName('body');
    if (body) this.children(body, inner, true);
  }

  /** A namespace or ambient module body: its members are a scope, and an unbound name there is `other`. */
  private declareModule(node: Node, scope: Scope, strict: boolean): void {
    const name = node.childForFieldName('name');
    if (name && name.type !== 'string') {
      const first = name.type === 'nested_identifier' ? name.namedChildren[0] : name;
      if (first) this.add(scope, first.text, OTHER);
    }
    const body = node.childForFieldName('body');
    if (body) this.namespaceBlock(body, scope, strict);
  }

  private namespaceBlock(node: Node, scope: Scope, strict: boolean): void {
    const inner = this.make('block', node, scope, strict);
    inner.namespace = true;
    inner.varBoundary = true;
    this.children(node, inner, strict);
  }

  private walkExport(node: Node, scope: Scope, strict: boolean): void {
    const declaration = node.childForFieldName('declaration');
    if (declaration) return this.walk(declaration, scope, strict);
    const value = node.childForFieldName('value');
    if (value) return this.walk(value, scope, strict);
    for (const child of node.namedChildren) if (child && child.type !== 'export_clause' && child.type !== 'string') this.walk(child, scope, strict);
  }

  private walkAmbient(node: Node, scope: Scope, strict: boolean): void {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'statement_block') this.namespaceBlock(child, scope, strict);
      else this.walk(child, scope, strict);
    }
  }

  private declareImport(node: Node, scope: Scope): void {
    for (const name of importNames(node)) this.add(scope, name, OTHER);
  }

  private declareAlias(node: Node, scope: Scope): void {
    const identifier = node.namedChildren.find((child) => child?.type === 'identifier');
    if (identifier) this.add(scope, identifier.text, OTHER);
  }

  private declareLexical(node: Node, scope: Scope, strict: boolean): void {
    this.declareList(node, scope, node.childForFieldName('kind')?.type === 'const' ? 'const' : 'let', strict);
  }

  private declareList(node: Node, scope: Scope, kind: 'const' | 'let' | 'var', strict: boolean): void {
    for (const child of node.namedChildren) if (child?.type === 'variable_declarator') this.declareVariable(child, scope, kind, strict);
  }

  /** A declarator binds what its name pattern collects; only an unassigned function value proves a definition. */
  private declareVariable(node: Node, scope: Scope, kind: 'const' | 'let' | 'var', strict: boolean): void {
    const name = node.childForFieldName('name');
    if (!name) return;
    const target = kind === 'var' ? this.varScope(scope) : scope;
    const value = node.childForFieldName('value');
    // Defaults and computed keys in the pattern are expressions evaluated here, not declarations.
    this.children(name, scope, strict);
    if (name.type !== 'identifier') {
      for (const bound of patternNames(name)) this.add(target, bound, OTHER);
    } else if (this.isParameterBinding(target, name.text) || !value || !FUNCTION_VALUES.has(value.type)) {
      this.add(target, name.text, OTHER);
    } else {
      this.add(target, name.text, { kind: 'def', start: pointOf(node), func: true });
    }
    // The initializer runs in this scope: its own functions, classes and bindings are read where they sit.
    if (value) this.walk(value, scope, strict);
  }

  private walkCatch(node: Node, scope: Scope, strict: boolean): void {
    const inner = this.make('block', node, scope, strict);
    const parameter = node.childForFieldName('parameter');
    for (const name of patternNames(parameter)) this.add(inner, name, OTHER);
    if (parameter) this.children(parameter, inner, strict);
    const body = node.childForFieldName('body');
    // The body is an ordinary nested block: a function declared in it is one for Annex B too.
    if (body) this.walk(body, inner, strict);
  }

  /** The head of a `for` is a block scope; `let`/`const` bind there, `var` in the enclosing function. */
  private walkFor(node: Node, scope: Scope, strict: boolean): void {
    const inner = this.make('block', node, scope, strict);
    const left = node.childForFieldName('left');
    const kind = node.childForFieldName('kind');
    if (left && kind) {
      const target = kind.type === 'var' ? this.varScope(inner) : inner;
      for (const name of patternNames(left)) this.add(target, name, OTHER);
    }
    this.children(node, inner, strict);
  }

  private walkBlock(node: Node, scope: Scope, strict: boolean, varBoundary = false): void {
    const inner = this.make('block', node, scope, strict);
    inner.varBoundary = varBoundary;
    this.children(node, inner, strict);
  }

  private walkUsing(node: Node, scope: Scope, strict: boolean): void {
    if (isUsing(node)) for (const name of patternNames(node.childForFieldName('left'))) this.add(scope, name, OTHER);
    this.children(node, scope, strict);
  }
}

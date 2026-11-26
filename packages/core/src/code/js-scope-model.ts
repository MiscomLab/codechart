import type { Node } from 'web-tree-sitter';
import type { CodeRange } from './model.js';

/** One declaration of a name in a scope. */
export interface Binding {
  kind: 'def' | 'import' | 'other';
  start?: CodeRange['start'];
  /** A function declaration or a variable declarator holding a function: candidates for TS overload merging. */
  func?: boolean;
  signature?: boolean;
  /** A `let`/`var` function value, which only proves a definition while no write reaches this binding. */
  mutable?: boolean;
  /** A write in this binding's own scope chain reached it. */
  written?: boolean;
}

export type ScopeKind = 'program' | 'function' | 'params' | 'name' | 'block';

/** One lexical scope of a JS/TS file. */
export interface Scope {
  kind: ScopeKind;
  node: Node;
  parent?: Scope;
  strict: boolean;
  /** A namespace or ambient-module body: an unbound name there may come from a merged declaration. */
  namespace: boolean;
  decls: Map<string, Binding[]>;
}

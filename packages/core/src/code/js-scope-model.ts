import type { Node } from 'web-tree-sitter';
import type { ExemptKind } from './js-types.js';
import type { CodeRange } from './model.js';

/** A fresh object a single unwritten binding was initialized to. */
export interface FreshInit {
  /** `assign` for `Object.assign(<fresh literal>, …)`, which a source's own `__proto__` property can reach; else `literal`. */
  kind: 'literal' | 'assign';
  /** The builtins the initializer names, which must be unbound where it sits. */
  globals: readonly string[];
  /** The declarator, from which the globals' scopes are read. */
  at: Node;
}

/** One declaration of a name in a scope. */
export interface Binding {
  kind: 'def' | 'import' | 'other';
  start?: CodeRange['start'];
  /** A function declaration or a variable declarator holding a function: candidates for TS overload merging. */
  func?: boolean;
  signature?: boolean;
  /** A write in this binding's own scope chain reached it. */
  written?: boolean;
  /** For `const x = other`: the name whose value `x` holds, followed when a class extends `x`. */
  alias?: string;
  /** An initializer that gives the binding its own fresh object: its computed writes stay its own. */
  fresh?: FreshInit;
  /** The computed-write exemptions a TypeScript type annotation on the declaration gives. */
  exempt?: readonly ExemptKind[];
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
  /** A class static block or namespace body: `var` declarations stay here, as their own var scope. */
  varBoundary?: boolean;
  /** A sloppy direct `eval` here may rebind any name this scope (or an enclosing one) binds. */
  evalTainted?: boolean;
  decls: Map<string, Binding[]>;
}

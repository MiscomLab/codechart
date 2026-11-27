import type { Node } from 'web-tree-sitter';
import type { ExemptKind } from './js-types.js';
import type { CodeRange } from './model.js';

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
  /** A `const` bound to an object literal, array literal or `Object.create(null)`: its computed writes stay its own. */
  literal?: boolean;
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

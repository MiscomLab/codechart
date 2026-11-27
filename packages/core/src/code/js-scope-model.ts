import type { Node } from 'web-tree-sitter';
import type { CodeRange } from './model.js';

/** What a `const` key proves for a computed class member: the string it holds, or that it holds a symbol. */
export type ConstantKey = { kind: 'string'; value: string } | { kind: 'symbol' };

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
  /** For `const k = 'f'` or `const s = Symbol()`: what the key is, and the declarator, whose global `Symbol` is checked. */
  constant?: { key: ConstantKey; at: Node };
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
  decls: Map<string, Binding[]>;
}

import type { Node } from 'web-tree-sitter';
import { Scopes } from './js-scope-build.js';
import { declaredTypeNames, type ExemptKind } from './js-types.js';
import type { CodeRange, Import } from './model.js';

/**
 * What a name means at a call site, from JS/TS scope rules: a function definition it provably reaches, a module-scope
 * value import, another local name it aliases with `const x = other`, no binding at all, or anything else that binds
 * the name (so no target is provable).
 */
export type JsMeaning =
  | { kind: 'def'; start: CodeRange['start'] }
  | { kind: 'import' }
  | { kind: 'alias'; name: string }
  | { kind: 'none' }
  | { kind: 'other' };

/** One call's callee and identifier-receiver meanings, in `ParsedFile.calls` order. */
export interface JsCallScope {
  callee: JsMeaning;
  receiver?: JsMeaning;
}

/** Reads what a name means at any node of a JS/TS tree, from the file's scopes. */
export interface JsScopeReader {
  /** Whether the file is TypeScript, where an annotation is a type tsc checks: a `.js` file's JSDoc never counts. */
  readonly typescript: boolean;
  /** The type names the file declares anywhere, which shadow the global lib types of the same name. */
  readonly typeNames: ReadonlySet<string>;
  meaningAt: (node: Node, name: string) => JsMeaning;
  /** Whether `name` at `node` is one `const` binding of an object/array literal or `Object.create(null)`. */
  isLocalLiteral: (node: Node, name: string) => boolean;
  /** The computed-write exemptions the one binding of `name` nearest `node` declares, if any. */
  computedExempt: (node: Node, name: string) => readonly ExemptKind[] | undefined;
}

/** Reads what the callee and an identifier receiver mean at any call site of a JS/TS tree. */
export function jsScopes(root: Node, path: string, imports: readonly Import[]): JsScopeReader {
  const scopes = new Scopes(root, path, imports, declaredTypeNames(root));
  return {
    typescript: scopes.typescript,
    typeNames: scopes.typeNames,
    meaningAt: (node, name) => scopes.meaningAt(node, name),
    isLocalLiteral: (node, name) => scopes.isLocalLiteral(node, name),
    computedExempt: (node, name) => scopes.computedExempt(node, name),
  };
}

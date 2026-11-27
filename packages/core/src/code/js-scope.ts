import type { Node } from 'web-tree-sitter';
import { Scopes } from './js-scope-build.js';
import type { ConstantKey } from './js-scope-model.js';
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
  meaningAt: (node: Node, name: string) => JsMeaning;
  /** The string or symbol the one unwritten `const` binding of `name` nearest `node` holds, when its initializer proves one. */
  constantAt: (node: Node, name: string) => ConstantKey | undefined;
}

/** Reads what the callee and an identifier receiver mean at any call site of a JS/TS tree. */
export function jsScopes(root: Node, path: string, imports: readonly Import[]): JsScopeReader {
  const scopes = new Scopes(root, path, imports);
  return {
    meaningAt: (node, name) => scopes.meaningAt(node, name),
    constantAt: (node, name) => scopes.constantAt(node, name),
  };
}

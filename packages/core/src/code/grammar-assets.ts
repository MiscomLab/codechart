/**
 * Grammar files the build copies from the pinned grammar packages into `dist/grammars/`.
 * Those packages stay dev dependencies: their install scripts build native bindings codechart never loads.
 */
export const GRAMMAR_ASSETS = {
  'tree-sitter-javascript.wasm': 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  'tree-sitter-typescript.wasm': 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm': 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  'javascript-tags.scm': 'tree-sitter-javascript/queries/tags.scm',
  'typescript-tags.scm': 'tree-sitter-typescript/queries/tags.scm',
} as const;

export type GrammarAsset = keyof typeof GRAMMAR_ASSETS;

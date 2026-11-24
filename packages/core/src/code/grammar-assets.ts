/**
 * Grammar files the build copies from the pinned grammar packages into `dist/grammars/`.
 * Those packages stay dev dependencies: their install scripts build native bindings codechart never loads.
 */
export const GRAMMAR_ASSETS = {
  'tree-sitter-javascript.wasm': 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  'tree-sitter-typescript.wasm': 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm': 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  'tree-sitter-python.wasm': 'tree-sitter-python/tree-sitter-python.wasm',
  'tree-sitter-html.wasm': 'tree-sitter-html/tree-sitter-html.wasm',
  'tree-sitter-css.wasm': 'tree-sitter-css/tree-sitter-css.wasm',
  'tree-sitter-bash.wasm': 'tree-sitter-bash/tree-sitter-bash.wasm',
  'tree-sitter-json.wasm': 'tree-sitter-json/tree-sitter-json.wasm',
  'tree-sitter-yaml.wasm': '@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm',
  'javascript-tags.scm': 'tree-sitter-javascript/queries/tags.scm',
  'typescript-tags.scm': 'tree-sitter-typescript/queries/tags.scm',
  'python-tags.scm': 'tree-sitter-python/queries/tags.scm',
} as const;

/**
 * Grammars no package ships compiled, kept in `packages/core/grammars/` (paths relative to `packages/core`) and copied
 * to `dist/grammars/` too. `scripts/build-sql-grammar.sh` builds the SQL one from `@derekstride/tree-sitter-sql`,
 * `scripts/build-prisma-grammar.sh` the Prisma one from `tree-sitter-prisma`.
 */
export const VENDORED_ASSETS = {
  'tree-sitter-sql.wasm': 'grammars/tree-sitter-sql.wasm',
  'tree-sitter-prisma.wasm': 'grammars/tree-sitter-prisma.wasm',
} as const;

export type GrammarAsset = keyof typeof GRAMMAR_ASSETS | keyof typeof VENDORED_ASSETS;

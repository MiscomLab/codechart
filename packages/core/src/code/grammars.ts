import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Language, Parser, Query } from 'web-tree-sitter';
import { GRAMMAR_ASSETS, VENDORED_ASSETS, type GrammarAsset } from './grammar-assets.js';
import { IMPORTS_QUERY } from './imports.js';
import type { EntityGrammar, Grammar } from './languages.js';
import { PYTHON_IMPORTS_QUERY } from './python/imports.js';

/** Definitions the upstream `tags.scm` files leave out. */
const EXTRA_JS = `
(field_definition
  property: [(property_identifier) (private_property_identifier)] @name
  value: [(arrow_function) (function_expression)]) @definition.method
`;
const EXTRA_TS = `
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(internal_module name: [(identifier) (nested_identifier)] @name) @definition.module
(public_field_definition
  name: [(property_identifier) (private_property_identifier)] @name
  value: [(arrow_function) (function_expression)]) @definition.method
`;

/** Bash has no `tags.scm`: functions are its only definitions. */
const BASH_TAGS = `(function_definition name: (word) @name) @definition.function`;

const WASM: Record<Grammar | EntityGrammar, GrammarAsset> = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  html: 'tree-sitter-html.wasm',
  css: 'tree-sitter-css.wasm',
  sql: 'tree-sitter-sql.wasm',
  bash: 'tree-sitter-bash.wasm',
  yaml: 'tree-sitter-yaml.wasm',
  json: 'tree-sitter-json.wasm',
  prisma: 'tree-sitter-prisma.wasm',
};

/** The imports query each grammar reads imports with. */
const IMPORTS: Record<Grammar, string> = {
  javascript: IMPORTS_QUERY,
  typescript: IMPORTS_QUERY,
  tsx: IMPORTS_QUERY,
  python: PYTHON_IMPORTS_QUERY,
};

function assetPath(name: GrammarAsset): string {
  const built = fileURLToPath(new URL(`./grammars/${name}`, import.meta.url));
  if (existsSync(built)) return built;
  // Running from source (tests, dev): the grammar packages are installed as dev dependencies.
  if (name in VENDORED_ASSETS) return fileURLToPath(new URL(`../../${VENDORED_ASSETS[name as keyof typeof VENDORED_ASSETS]}`, import.meta.url));
  return createRequire(import.meta.url).resolve(GRAMMAR_ASSETS[name as keyof typeof GRAMMAR_ASSETS]);
}

function tagsSource(grammar: Grammar): string {
  // Python's tags.scm reads `def` in a class body as a function; `extractSymbols` turns those into methods.
  if (grammar === 'python') return readFileSync(assetPath('python-tags.scm'), 'utf8');
  const js = readFileSync(assetPath('javascript-tags.scm'), 'utf8');
  if (grammar === 'javascript') return js + EXTRA_JS;
  // TypeScript's tags.scm only adds to JavaScript's.
  return js + readFileSync(assetPath('typescript-tags.scm'), 'utf8') + EXTRA_TS;
}

/** One loaded grammar: a parser set to it, its definitions query and its imports query. */
export interface LoadedGrammar {
  parser: Parser;
  tags: Query;
  imports: Query;
}

let runtime: Promise<typeof import('web-tree-sitter')> | undefined;

// Imported on first use, so bundles of core that never parse (the OpenCode plugin) leave web-tree-sitter out.
const loadRuntime = () =>
  (runtime ??= import('web-tree-sitter').then(async (ts) => {
    await ts.Parser.init();
    return ts;
  }));

/** A parser set to the grammar's language, and a query maker for it. */
async function open(grammar: Grammar | EntityGrammar) {
  const ts = await loadRuntime();
  const language: Language = await ts.Language.load(assetPath(WASM[grammar]));
  const parser = new ts.Parser();
  parser.setLanguage(language);
  return { parser, query: (source: string) => new ts.Query(language, source) };
}

/** Loads each grammar once per process. */
function once<K, V>(make: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const loaded = new Map<K, Promise<V>>();
  return (key) => {
    let entry = loaded.get(key);
    if (!entry) loaded.set(key, (entry = make(key)));
    return entry;
  };
}

/** The grammar, loaded once per process. */
export const loadGrammar = once(async (grammar: Grammar): Promise<LoadedGrammar> => {
  const { parser, query } = await open(grammar);
  return { parser, tags: query(tagsSource(grammar)), imports: query(IMPORTS[grammar]) };
});

/** A grammar of a language without imports: a parser, and for Bash the query its functions are read with. */
export interface LoadedEntityGrammar {
  parser: Parser;
  tags?: Query;
}

/** The entity grammar, loaded once per process. */
export const loadEntityGrammar = once(async (grammar: EntityGrammar): Promise<LoadedEntityGrammar> => {
  const { parser, query } = await open(grammar);
  return grammar === 'bash' ? { parser, tags: query(BASH_TAGS) } : { parser };
});

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Language, Parser, Query } from 'web-tree-sitter';
import { GRAMMAR_ASSETS, type GrammarAsset } from './grammar-assets.js';
import type { Grammar } from './languages.js';

/** Definitions the upstream `tags.scm` files leave out. */
const EXTRA_JS = `
(field_definition
  property: (property_identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.method
`;
const EXTRA_TS = `
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(internal_module name: (identifier) @name) @definition.module
(public_field_definition
  name: (property_identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.method
`;

const WASM: Record<Grammar, GrammarAsset> = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
};

function assetPath(name: GrammarAsset): string {
  const built = fileURLToPath(new URL(`./grammars/${name}`, import.meta.url));
  if (existsSync(built)) return built;
  // Running from source (tests, dev): the grammar packages are installed as dev dependencies.
  return createRequire(import.meta.url).resolve(GRAMMAR_ASSETS[name]);
}

function tagsSource(grammar: Grammar): string {
  const js = readFileSync(assetPath('javascript-tags.scm'), 'utf8');
  if (grammar === 'javascript') return js + EXTRA_JS;
  // TypeScript's tags.scm only adds to JavaScript's.
  return js + readFileSync(assetPath('typescript-tags.scm'), 'utf8') + EXTRA_TS;
}

/** One loaded grammar: a parser set to it and its definitions query. */
export interface LoadedGrammar {
  parser: Parser;
  tags: Query;
}

let runtime: Promise<typeof import('web-tree-sitter')> | undefined;
const loaded = new Map<Grammar, Promise<LoadedGrammar>>();

// Imported on first use, so bundles of core that never parse (the OpenCode plugin) leave web-tree-sitter out.
const loadRuntime = () =>
  (runtime ??= import('web-tree-sitter').then(async (ts) => {
    await ts.Parser.init();
    return ts;
  }));

async function load(grammar: Grammar): Promise<LoadedGrammar> {
  const ts = await loadRuntime();
  const language: Language = await ts.Language.load(assetPath(WASM[grammar]));
  const parser = new ts.Parser();
  parser.setLanguage(language);
  return { parser, tags: new ts.Query(language, tagsSource(grammar)) };
}

/** The grammar, loaded once per process. */
export function loadGrammar(grammar: Grammar): Promise<LoadedGrammar> {
  let entry = loaded.get(grammar);
  if (!entry) {
    entry = load(grammar);
    loaded.set(grammar, entry);
  }
  return entry;
}

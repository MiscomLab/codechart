import { createHash } from 'node:crypto';
import { loadGrammar } from './grammars.js';
import { grammarOf, langOf } from './languages.js';
import { extractImports, type ModuleExports } from './imports.js';
import type { CodeSymbol, FileInfo, CodeRange, Import } from './model.js';
import { extractSymbols, type Extracted } from './symbols.js';

/** One file of the code layer. */
export interface ParsedFile {
  file: FileInfo;
  symbols: CodeSymbol[];
  /** Where tree-sitter recovered from a syntax error; empty when the file parses. */
  parseErrors: CodeRange[];
  /** Ids of symbols carried over from the last good parse with their old range, since the broken text no longer shows them. */
  kept: string[];
  /** `unknown` until `linkImports` resolves them against the rest of the repo. */
  imports: Import[];
  exports: ModuleExports;
}

/**
 * Live map #11: symbols outside syntax errors update; one parsed in or around an error stays only when the last good
 * parse had it, and last good symbols the broken text lost are kept. No new symbol comes from broken text.
 */
function keepLastGood(extracted: Extracted, lastGood: readonly CodeSymbol[] | undefined): Pick<ParsedFile, 'symbols' | 'kept'> {
  if (!extracted.errors.length) return { symbols: extracted.symbols, kept: [] };
  const good = new Map((lastGood ?? []).map((s) => [s.id, s]));
  const symbols = extracted.symbols.filter((s) => !extracted.broken.has(s.id) || good.has(s.id));
  const present = new Set(symbols.map((s) => s.id));
  const kept = [...good.values()].filter((s) => !present.has(s.id));
  return { symbols: [...symbols, ...kept], kept: kept.map((s) => s.id) };
}

/**
 * Parses one file in isolation. `path` is repo-relative with `/`; `lastGood` is the file's previous symbols, which
 * stand in for definitions a syntax error hides. A file in a v1 language without a symbol grammar yet gets no symbols.
 */
export async function parseCode(path: string, text: string, lastGood?: readonly CodeSymbol[]): Promise<ParsedFile | undefined> {
  const lang = langOf(path);
  if (!lang) return undefined;
  const file: FileInfo = { path, lang, hash: createHash('sha256').update(text).digest('hex') };
  const grammar = grammarOf(path);
  if (!grammar) return { file, symbols: [], parseErrors: [], kept: [], imports: [], exports: { names: [], complete: false } };
  const { parser, tags, imports: query } = await loadGrammar(grammar);
  const tree = parser.parse(text);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${path}`);
  try {
    const extracted = extractSymbols(path, tree, tags);
    const { imports, exports } = extractImports(path, tree, query);
    return {
      file,
      ...keepLastGood(extracted, lastGood),
      parseErrors: extracted.errors,
      imports: imports.map((i) => ({ ...i, status: 'unknown' as const })),
      exports,
    };
  } finally {
    tree.delete();
  }
}

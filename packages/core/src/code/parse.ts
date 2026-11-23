import { createHash } from 'node:crypto';
import { extractCalls } from './calls.js';
import { loadGrammar } from './grammars.js';
import { grammarOf, langOf } from './languages.js';
import { extractImports, type ExportName, type ImportSpec, type ModuleExports } from './imports.js';
import type { CallRef, CodeSymbol, FileInfo, CodeRange, Import } from './model.js';
import { extractPythonImports } from './python/imports.js';
import type { PyBinding } from './python/module-scope.js';
import { extractSymbols } from './symbols.js';
import { errorNodes } from './tree.js';

/** One file of the code layer. */
export interface ParsedFile {
  file: FileInfo;
  symbols: CodeSymbol[];
  /** Where tree-sitter recovered from a syntax error; empty when the file parses. */
  parseErrors: CodeRange[];
  /** Ids of symbols carried over from the last good parse with their old range, since the broken text no longer shows them. */
  kept: string[];
  /** `unknown` until the link pass resolves them against the rest of the repo. */
  imports: Import[];
  exports: ModuleExports;
  /** Calls by `from` symbol; `name-only` until the link pass proves a target. */
  calls: CallRef[];
  /** Python only: every name each scope binds, which decides what a called name means where it is called. */
  bindings?: PyBinding[];
  /** The file edits `sys.path`, so its absolute Python imports have no provable target. Absent for other files. */
  sysPathEdited?: boolean;
}

/** The previous parse of a file: symbols, imports and exports that stand in while syntax errors hide them. */
export type LastGood = ParsedFile | readonly CodeSymbol[];

/**
 * Live map #11: symbols outside syntax errors update; one parsed in or around an error stays only when the last good
 * parse had it, and last good symbols the broken text lost are kept. No new symbol comes from broken text.
 */
function keepLastGood(extracted: ReturnType<typeof extractSymbols>, lastGood: readonly CodeSymbol[] | undefined): Pick<ParsedFile, 'symbols' | 'kept'> {
  if (!extracted.errors.length) return { symbols: extracted.symbols, kept: [] };
  const good = new Map((lastGood ?? []).map((s) => [s.id, s]));
  const symbols = extracted.symbols.filter((s) => !extracted.broken.has(s.id) || good.has(s.id));
  const present = new Set(symbols.map((s) => s.id));
  const kept = [...good.values()].filter((s) => !present.has(s.id));
  return { symbols: [...symbols, ...kept], kept: kept.map((s) => s.id) };
}

const importKey = (imp: Pick<Import, 'kind' | 'spec' | 'typeOnly' | 'names'>): string =>
  JSON.stringify([imp.kind, imp.spec, imp.typeOnly ?? false, (imp.names ?? []).map((n) => [n.imported, n.local, n.typeOnly ?? false])]);

const lineOverlap = (a: CodeRange, b: CodeRange): boolean => a.start.line <= b.end.line && a.end.line >= b.start.line;

/**
 * COD-42 follow-up: while a file has a syntax error, an import hidden by the broken text keeps its last good version,
 * so arrows do not flicker as the agent types. An import cleanly replaced or deleted is not resurrected: a type-only
 * replacement must switch the call to name-only immediately, not keep the old value import.
 */
function keepLastGoodImports(
  imports: readonly ImportSpec[],
  hidden: readonly ImportSpec[],
  errors: CodeRange[],
  lastGood: ParsedFile | undefined,
  text: string,
): Import[] {
  const current: Import[] = imports.map((i) => ({ ...i, status: 'unknown' }));
  if (!errors.length || !lastGood) return current;
  const present = new Set(current.map(importKey));
  const hiddenKeys = new Set(hidden.map(importKey));
  const hiddenSpecs = new Set(hidden.map((i) => i.spec));
  const kept = lastGood.imports.filter((imp) => {
    if (present.has(importKey(imp))) return false;
    if (hiddenKeys.has(importKey(imp)) || hiddenSpecs.has(imp.spec)) return true;
    if (hidden.some((h) => lineOverlap(h.range, imp.range))) return true;
    // A statement whose own specifier is broken has no query match; the broken text still names the old spec.
    return errors.some((e) => lineOverlap(e, imp.range)) && text.includes(imp.spec);
  });
  return [...current, ...kept];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the text still names an export: `export default` for a default, else the exported name as a whole word. */
const stillWritten = (text: string, name: ExportName): boolean =>
  (name.name === 'default' ? /\bexport\s+default\b/ : new RegExp(`(?<![\\w$])${escapeRegExp(name.name)}(?![\\w$])`)).test(text);

/**
 * Own exports hidden by a syntax error keep their last good names, so barrel lookups do not flicker. As with imports,
 * an export whose name is gone from the text was deleted, not hidden, and is not resurrected.
 */
function keepLastGoodExports(exports: ModuleExports, errors: CodeRange[], lastGood: ParsedFile | undefined, text: string): ModuleExports {
  if (!errors.length || !lastGood) return exports;
  const names = [...exports.names];
  const present = new Set(names.map((n) => `${n.name}\0${n.local ?? ''}`));
  for (const name of lastGood.exports.names) {
    const key = `${name.name}\0${name.local ?? ''}`;
    if (!present.has(key) && stillWritten(text, name)) {
      present.add(key);
      names.push(name);
    }
  }
  return { names, complete: false };
}

/** A parsed import, with any previous link evidence removed; the next link pass proves it again. */
function unlinked(imp: Import): Import {
  const copy: Import = { ...imp, status: 'unknown' };
  delete copy.resolved;
  if (copy.names) {
    copy.names = copy.names.map((name) => {
      const fresh = { ...name };
      delete fresh.definedIn;
      return fresh;
    });
  }
  return copy;
}

/**
 * Parses one file in isolation. `path` is repo-relative with `/`; `lastGood` is the file's previous parse, whose
 * symbols, imports and exports stand in for what a syntax error hides. A file in a v1 language without a symbol
 * grammar yet gets no symbols.
 */
export async function parseCode(path: string, text: string, lastGood?: LastGood): Promise<ParsedFile | undefined> {
  const lang = langOf(path);
  if (!lang) return undefined;
  const file: FileInfo = { path, lang, hash: createHash('sha256').update(text).digest('hex') };
  const grammar = grammarOf(path);
  if (!grammar) return { file, symbols: [], parseErrors: [], kept: [], imports: [], exports: { names: [], complete: false }, calls: [] };
  const { parser, tags, imports: query } = await loadGrammar(grammar);
  const tree = parser.parse(text);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${path}`);
  try {
    const previous = Array.isArray(lastGood) ? undefined : (lastGood as ParsedFile | undefined);
    const errors = tree.rootNode.hasError ? errorNodes(tree.rootNode) : [];
    const extracted = extractSymbols(path, tree, tags, grammar);
    const good = keepLastGood(extracted, Array.isArray(lastGood) ? lastGood : previous?.symbols);
    const python = grammar === 'python' ? extractPythonImports(path, tree, query, extracted.symbols) : undefined;
    const stated = python ?? extractImports(path, tree, query);
    return {
      file,
      ...good,
      parseErrors: extracted.errors,
      imports: keepLastGoodImports(stated.imports, stated.hidden, extracted.errors, previous, text).map(unlinked),
      exports: keepLastGoodExports(stated.exports, extracted.errors, previous, text),
      calls: extractCalls(tree, tags, good, errors, python ? 'python' : undefined),
      ...(python && { bindings: python.bindings }),
      ...(python?.sysPathEdited && { sysPathEdited: true }),
    };
  } finally {
    tree.delete();
  }
}

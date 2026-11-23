import { createHash } from 'node:crypto';
import { extractCalls } from './calls.js';
import { extractEntities } from './entities/index.js';
import { loadEntityGrammar, loadGrammar } from './grammars.js';
import { entityGrammarOf, grammarOf, langOf, type EntityGrammar } from './languages.js';
import { extractImports, type ExportName, type ImportSpec, type ModuleExports } from './imports.js';
import type { CallRef, CodeEntity, CodeRef, CodeSymbol, FileInfo, CodeRange, Import } from './model.js';
import { extractPythonImports } from './python/imports.js';
import type { PyBinding } from './python/module-scope.js';
import { extractSymbols } from './symbols.js';
import { errorNodes, nodeRange } from './tree.js';

/** One file of the code layer. */
export interface ParsedFile {
  file: FileInfo;
  symbols: CodeSymbol[];
  /** Where tree-sitter recovered from a syntax error; empty when the file parses. */
  parseErrors: CodeRange[];
  /** Ids of symbols and entities carried over from the last good parse with their old range, since the broken text no longer shows them. */
  kept: string[];
  /** `unknown` until the link pass resolves them against the rest of the repo. */
  imports: Import[];
  exports: ModuleExports;
  /** Calls by `from` symbol; `name-only` until the link pass proves a target. */
  calls: CallRef[];
  /** Tables, workflow jobs and steps, compose services and npm scripts (Code model #3); empty for languages with imports. */
  entities: CodeEntity[];
  /** Files this one runs, sources, loads or imports without an import statement; `unknown` until the link pass. */
  refs: CodeRef[];
  /** Python only: every name each scope binds, which decides what a called name means where it is called. */
  bindings?: PyBinding[];
  /** The file edits `sys.path`, so its absolute Python imports have no provable target. Absent for other files. */
  sysPathEdited?: boolean;
}

/** The previous parse of a file: symbols, imports and exports that stand in while syntax errors hide them. */
export type LastGood = ParsedFile | readonly CodeSymbol[];

/**
 * Live map #11: symbols and entities outside syntax errors update; one parsed in or around an error stays only when the
 * last good parse had it, and last good ones the broken text lost are kept. None comes new from broken text.
 */
function keepLastGood<T extends { id: string }>(items: readonly T[], broken: ReadonlySet<string>, errors: readonly CodeRange[], lastGood: readonly T[] | undefined): { items: T[]; kept: string[] } {
  if (!errors.length) return { items: [...items], kept: [] };
  const good = new Map((lastGood ?? []).map((s) => [s.id, s]));
  const current = items.filter((s) => !broken.has(s.id) || good.has(s.id));
  const present = new Set(current.map((s) => s.id));
  const kept = [...good.values()].filter((s) => !present.has(s.id));
  return { items: [...current, ...kept], kept: kept.map((s) => s.id) };
}

const keepLastGoodSymbols = (extracted: ReturnType<typeof extractSymbols>, lastGood: readonly CodeSymbol[] | undefined): Pick<ParsedFile, 'symbols' | 'kept'> => {
  const { items, kept } = keepLastGood(extracted.symbols, extracted.broken, extracted.errors, lastGood);
  return { symbols: items, kept };
};

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

/**
 * A reference a syntax error hides keeps its last good version while the text still names it, as imports do; one whose
 * spec is gone from the text was deleted, not hidden.
 */
function keepLastGoodRefs(refs: readonly CodeRef[], errors: readonly CodeRange[], lastGood: ParsedFile | undefined, text: string): CodeRef[] {
  if (!errors.length || !lastGood) return [...refs];
  const key = (r: CodeRef) => `${r.kind}\0${r.spec}`;
  // Counted, so a hidden reference is kept even while another one with the same spec still parses.
  const present = new Map<string, number>();
  for (const r of refs) present.set(key(r), (present.get(key(r)) ?? 0) + 1);
  const kept = lastGood.refs.filter((r) => {
    const left = present.get(key(r)) ?? 0;
    if (left > 0) {
      present.set(key(r), left - 1);
      return false;
    }
    return errors.some((e) => lineOverlap(e, r.range)) && text.includes(r.spec);
  });
  return [...refs, ...kept.map(unlinkedRef)];
}

function unlinkedRef(ref: CodeRef): CodeRef {
  const copy: CodeRef = { ...ref, status: 'unknown' };
  delete copy.resolved;
  return copy;
}

/** A file in a language without imports: its entities, references and (Bash) functions. */
async function parseEntities(file: FileInfo, grammar: EntityGrammar, text: string, lastGood: LastGood | undefined): Promise<ParsedFile> {
  const { parser, tags } = await loadEntityGrammar(grammar);
  const tree = parser.parse(text);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${file.path}`);
  try {
    const previous = Array.isArray(lastGood) ? undefined : (lastGood as ParsedFile | undefined);
    const extracted = extractEntities(file.path, text, tree, grammar, tags);
    const errors = tree.rootNode.hasError ? errorNodes(tree.rootNode).map(nodeRange) : [];
    const symbols = extracted.symbols ? keepLastGoodSymbols(extracted.symbols, Array.isArray(lastGood) ? lastGood : previous?.symbols) : { symbols: [], kept: [] };
    const entities = keepLastGood(extracted.entities, extracted.broken, errors, previous?.entities);
    return {
      file,
      symbols: symbols.symbols,
      parseErrors: errors,
      kept: [...symbols.kept, ...entities.kept],
      imports: [],
      exports: { names: [], complete: false },
      calls: [],
      entities: entities.items,
      refs: keepLastGoodRefs(extracted.refs, errors, previous, text),
    };
  } finally {
    tree.delete();
  }
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
 * symbols, entities, imports, exports and references stand in for what a syntax error hides.
 */
export async function parseCode(path: string, text: string, lastGood?: LastGood): Promise<ParsedFile | undefined> {
  const lang = langOf(path);
  if (!lang) return undefined;
  const file: FileInfo = { path, lang, hash: createHash('sha256').update(text).digest('hex') };
  const grammar = grammarOf(path);
  if (!grammar) return parseEntities(file, entityGrammarOf(path)!, text, lastGood);
  const { parser, tags, imports: query } = await loadGrammar(grammar);
  const tree = parser.parse(text);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${path}`);
  try {
    const previous = Array.isArray(lastGood) ? undefined : (lastGood as ParsedFile | undefined);
    const errors = tree.rootNode.hasError ? errorNodes(tree.rootNode) : [];
    const extracted = extractSymbols(path, tree, tags, grammar);
    const good = keepLastGoodSymbols(extracted, Array.isArray(lastGood) ? lastGood : previous?.symbols);
    const python = grammar === 'python' ? extractPythonImports(path, tree, query, extracted.symbols) : undefined;
    const stated = python ?? extractImports(path, tree, query);
    return {
      file,
      ...good,
      parseErrors: extracted.errors,
      imports: keepLastGoodImports(stated.imports, stated.hidden, extracted.errors, previous, text).map(unlinked),
      exports: keepLastGoodExports(stated.exports, extracted.errors, previous, text),
      calls: extractCalls(tree, tags, good, errors, python ? 'python' : undefined),
      entities: [],
      refs: [],
      ...(python && { bindings: python.bindings }),
      ...(python?.sysPathEdited && { sysPathEdited: true }),
    };
  } finally {
    tree.delete();
  }
}

import type { Query } from 'web-tree-sitter';
import { compileQuery } from './grammars.js';
import { PATTERN_GRAMMARS, type PatternGrammar } from './languages.js';

/** A named tree-sitter query (a `map.rules` pattern, or one of the app's own), run on the files of its grammar. */
export interface CodePattern {
  id: string;
  grammar: PatternGrammar;
  /** One or more patterns; each captures the node it is about as `@entity`, exactly once. */
  pattern: string;
}

/** A pattern set's name, and how long and how wide it may run on one file. */
export interface PatternSetOptions {
  /** Names the set in each match's `set` and in `patternLimits`; default `patterns`. Two sets in one parse need two ids. */
  id?: string;
  /** Per file and grammar; the query stops after it and the file is marked `timeout`. Default 500. */
  timeoutMs?: number;
  /**
   * tree-sitter's cap on matches in progress at once, 1 to 65536, which bounds the memory a query takes; when tree-sitter
   * drops matches past it the file is marked `match-limit`. Default 1024. web-tree-sitter runs every query on one cursor
   * per process whose pool never shrinks, so the cap in force is the larger of this and the most any earlier query used.
   */
  matchLimit?: number;
}

/** Why a set's matches on a file may be incomplete; `timeout` wins when both happened. */
export type PatternLimit = 'timeout' | 'match-limit';

export type PatternCheck = { ok: true } | { ok: false; error: string };

/**
 * Patterns compiled into one query per grammar, for `parseCode`, `parseRepo` and `openCodeIndex`, which take one set or
 * several; each set runs on its own, within its own limits. Holds WebAssembly memory: `delete()` it once nothing parses
 * with it any more (an index uses it until it is dropped).
 */
export interface PatternSet {
  readonly id: string;
  /** The pattern ids, in the order given. */
  readonly ids: readonly string[];
  delete(): void;
}

const DEFAULT_SET_ID = 'patterns';
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_MATCH_LIMIT = 1024;
const MAX_MATCH_LIMIT = 65536;

/** The predicates web-tree-sitter filters matches with; it ignores any other, so they are refused. */
const TEXT_PREDICATES = ['eq?', 'not-eq?', 'any-eq?', 'any-not-eq?', 'match?', 'not-match?', 'any-match?', 'any-not-match?', 'any-of?', 'not-any-of?'];

const orList = (items: readonly string[]): string => `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;

const UNSUPPORTED = `use ${orList(TEXT_PREDICATES.map((p) => `#${p}`))}`;

/** Where an offset of the query source is, as an editor counts: 1-based line and column. */
function position(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index);
  return { line: before.split('\n').length, column: index - before.lastIndexOf('\n') };
}

const at = (source: string, index: number): string => {
  const { line, column } = position(source, index);
  return `line ${line}, column ${column}`;
};

/** web-tree-sitter's `QueryErrorKind`, which it does not export. */
const QUERY_ERRORS: Record<number, (word: string, where: string) => string> = {
  1: (_, where) => `syntax error at ${where}`,
  2: (word, where) => `unknown node type '${word}' at ${where}`,
  3: (word, where) => `unknown field '${word}' at ${where}`,
  4: (word, where) => `unknown capture '@${word}' at ${where}`,
  5: (_, where) => `impossible pattern at ${where}`,
};

/** A compile error in words; the query's offsets count UTF-16 code units, as JavaScript strings do. */
function compileError(source: string, error: unknown): string {
  const e = error as Error & { kind?: number; index?: number; info?: { word?: string } };
  const message = e.kind === undefined ? undefined : QUERY_ERRORS[e.kind];
  if (e.name === 'QueryError' && message && typeof e.index === 'number') return message(e.info?.word ?? '', at(source, e.index));
  // A #match? pattern is compiled with `new RegExp`.
  if (e instanceof SyntaxError) return `invalid #match? regular expression: ${e.message}`;
  // web-tree-sitter's own messages for a predicate with the wrong arguments; anything else is not the pattern's fault.
  if (e instanceof Error && /predicate/i.test(e.message)) return `invalid predicate: ${e.message}`;
  throw error;
}

/** The first predicate of a pattern that filters nothing: one web-tree-sitter keeps as data instead. */
function unsupportedPredicate(query: Query, pattern: number): string | undefined {
  const other = query.predicates[pattern]?.[0];
  if (other) return `#${other.operator}`;
  if (query.setProperties[pattern]) return '#set!';
  if (query.assertedProperties[pattern]) return '#is?';
  if (query.refutedProperties[pattern]) return '#is-not?';
  return undefined;
}

/** CaptureQuantifier.One: the capture is on exactly one node of every match. */
const ONE = 3;

/** Why a compiled query can't be a rule's pattern, or undefined when it can. */
function shapeError(query: Query, source: string): string | undefined {
  const count = query.patternCount();
  if (!count) return 'the query has no pattern';
  const entity = query.captureNames.indexOf('entity');
  for (let pattern = 0; pattern < count; pattern++) {
    const { line } = position(source, query.startIndexForPattern(pattern));
    const quantifier = entity < 0 ? 0 : (query.captureQuantifiers[pattern]?.[entity] ?? 0);
    if (!quantifier) return `the pattern at line ${line} has no @entity capture: capture the node the rule applies to as @entity`;
    if (quantifier !== ONE) return `the pattern at line ${line} captures @entity optionally or more than once: capture exactly one node as @entity`;
    const predicate = unsupportedPredicate(query, pattern);
    if (predicate) return `unsupported predicate ${predicate} in the pattern at line ${line}: ${UNSUPPORTED}`;
  }
  return undefined;
}

/** Compiles and checks one pattern; on success, how many top-level patterns it holds. */
async function check(grammar: PatternGrammar, source: string): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  if (!(PATTERN_GRAMMARS as readonly string[]).includes(grammar)) return { ok: false, error: `unknown grammar '${grammar}': use ${orList(PATTERN_GRAMMARS)}` };
  let query: Query;
  try {
    query = await compileQuery(grammar, source);
  } catch (error) {
    return { ok: false, error: compileError(source, error) };
  }
  try {
    const error = shapeError(query, source);
    return error ? { ok: false, error } : { ok: true, count: query.patternCount() };
  } finally {
    query.delete();
  }
}

/**
 * Whether `pattern` compiles for `grammar` and can be a rule's pattern: every pattern in it captures `@entity` exactly
 * once and uses only predicates that filter. The error names the line and column (1-based) in `pattern`.
 */
export async function checkPattern(grammar: PatternGrammar, pattern: string): Promise<PatternCheck> {
  const result = await check(grammar, pattern);
  return result.ok ? { ok: true } : result;
}

/** One grammar's patterns as a single query, and the pattern id of each of its patterns. */
export interface GrammarQuery {
  query: Query;
  ids: string[];
}

interface Limits {
  timeoutMs: number;
  matchLimit: number;
}

export class CompiledPatterns implements PatternSet {
  private deleted = false;

  constructor(
    readonly id: string,
    readonly ids: readonly string[],
    private readonly queries: ReadonlyMap<PatternGrammar, GrammarQuery>,
    readonly limits: Limits,
  ) {}

  /** The grammar's query, or undefined when no pattern is written for it. */
  queryFor(grammar: PatternGrammar): GrammarQuery | undefined {
    if (this.deleted) throw new Error('this pattern set was deleted');
    return this.queries.get(grammar);
  }

  delete(): void {
    if (this.deleted) return;
    this.deleted = true;
    for (const { query } of this.queries.values()) query.delete();
  }
}

function checkOptions(options: PatternSetOptions): Limits & { id: string } {
  const { id = DEFAULT_SET_ID, timeoutMs = DEFAULT_TIMEOUT_MS, matchLimit = DEFAULT_MATCH_LIMIT } = options;
  if (!id) throw new Error('a pattern set id must not be empty');
  if (!Number.isInteger(matchLimit) || matchLimit < 1 || matchLimit > MAX_MATCH_LIMIT) throw new Error(`matchLimit must be an integer from 1 to ${MAX_MATCH_LIMIT}`);
  if (!(timeoutMs > 0)) throw new Error('timeoutMs must be a positive number');
  return { id, timeoutMs, matchLimit };
}

/**
 * Checks each pattern as `checkPattern` does and compiles them once, into one query per grammar, for parsing with.
 * Throws on a broken pattern (naming its id) or a repeated id.
 */
export async function compilePatterns(patterns: readonly CodePattern[], options: PatternSetOptions = {}): Promise<PatternSet> {
  const { id: setId, ...limits } = checkOptions(options);
  const byGrammar = new Map<PatternGrammar, { sources: string[]; ids: string[] }>();
  const ids: string[] = [];
  for (const { id, grammar, pattern } of patterns) {
    if (ids.includes(id)) throw new Error(`pattern id '${id}' is used twice`);
    const result = await check(grammar, pattern);
    if (!result.ok) throw new Error(`pattern '${id}' (${grammar}): ${result.error}`);
    ids.push(id);
    const entry = byGrammar.get(grammar) ?? { sources: [], ids: [] };
    entry.sources.push(pattern);
    // tree-sitter numbers patterns in source order, so pattern i of the joined query belongs to entry.ids[i].
    for (let i = 0; i < result.count; i++) entry.ids.push(id);
    byGrammar.set(grammar, entry);
  }
  const queries = new Map<PatternGrammar, GrammarQuery>();
  try {
    // A newline between sources ends a trailing `;` comment, which would otherwise swallow the next pattern.
    for (const [grammar, entry] of byGrammar) queries.set(grammar, { query: await compileQuery(grammar, entry.sources.join('\n')), ids: entry.ids });
  } catch (error) {
    for (const { query } of queries.values()) query.delete();
    throw error;
  }
  return new CompiledPatterns(setId, ids, queries, limits);
}

/** One pattern set or several, as the parse options take them. */
export type PatternSets = PatternSet | readonly PatternSet[];

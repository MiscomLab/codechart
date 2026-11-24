import { createHash } from 'node:crypto';
import type { Node, QueryMatch } from 'web-tree-sitter';
import type { PatternGrammar } from './languages.js';
import type { PatternMatch } from './model.js';
import { CompiledPatterns, type GrammarQuery, type PatternLimit, type PatternSet, type PatternSets } from './patterns.js';
import { nodeRange, touches } from './tree.js';

/** A match before the last good parse is weighed: whether a syntax error touches its node. */
interface Found extends PatternMatch {
  broken: boolean;
}

/** The text of each capture of a match but `@entity`, from its first node; `_` names left out. */
function captureTexts(match: QueryMatch): Record<string, string> {
  const first = new Map<string, Node>();
  for (const { name, node } of match.captures) {
    if (name === 'entity' || name.startsWith('_')) continue;
    const seen = first.get(name);
    if (!seen || node.startIndex < seen.startIndex) first.set(name, node);
  }
  return Object.fromEntries([...first].map(([name, node]) => [name, node.text]));
}

/** Runs the grammar's query within the limits: one result per pattern id and `@entity` node, the first match found. */
function run(set: CompiledPatterns, grammar: GrammarQuery, root: Node, errors: readonly Node[]): { found: Found[]; limit?: PatternLimit } {
  const { timeoutMs, matchLimit } = set.limits;
  const started = performance.now();
  let timedOut = false;
  const matches = grammar.query.matches(root, {
    matchLimit,
    // Returning true cancels the query; the matches found so far are returned.
    progressCallback: () => (timedOut ||= performance.now() - started > timeoutMs),
  });
  const limit: PatternLimit | undefined = timedOut ? 'timeout' : grammar.query.didExceedMatchLimit() ? 'match-limit' : undefined;
  const seen = new Set<string>();
  const found: Found[] = [];
  for (const match of matches) {
    const pattern = grammar.ids[match.patternIndex]!;
    const node = match.captures.find((c) => c.name === 'entity')!.node;
    const key = `${pattern}\0${node.startIndex}\0${node.endIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      set: set.id,
      pattern,
      range: nodeRange(node),
      hash: createHash('sha256').update(node.text).digest('hex'),
      captures: captureTexts(match),
      broken: errors.some((e) => touches(node, e)),
    });
  }
  return { found, ...(limit && { limit }) };
}

const matchKey = (m: PatternMatch): string => `${m.pattern}\0${m.hash}`;

const at = (m: PatternMatch): string => `${m.range.start.line}:${m.range.start.column}`;
const byPosition = (a: PatternMatch, b: PatternMatch): number => a.range.start.line - b.range.start.line || a.range.start.column - b.range.start.column;

/** Groups by pattern and content, each group in source order. */
function byKey<T extends PatternMatch>(matches: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const m of matches) {
    const group = groups.get(matchKey(m));
    if (group) group.push(m);
    else groups.set(matchKey(m), [m]);
  }
  for (const group of groups.values()) group.sort(byPosition);
  return groups;
}

/**
 * Pairs identical current and last good matches: first those still at the same place, then the rest in source order,
 * each current match with the nearest last good one by line (an edit above moves them alike; on a tie, the earlier one).
 * Linear in both counts.
 */
function pair(found: readonly Found[], old: readonly PatternMatch[]): { paired: Found[]; unpaired: Found[]; left: PatternMatch[] } {
  const free = new Map<string, number>();
  for (const m of old) free.set(at(m), (free.get(at(m)) ?? 0) + 1);
  const paired: Found[] = [];
  const rest: Found[] = [];
  for (const m of found) {
    const n = free.get(at(m)) ?? 0;
    if (n) {
      free.set(at(m), n - 1);
      paired.push(m);
    } else rest.push(m);
  }
  const others: PatternMatch[] = [];
  for (const m of old) {
    const n = free.get(at(m)) ?? 0;
    if (n) {
      free.set(at(m), n - 1);
      others.push(m);
    }
  }
  const unpaired: Found[] = [];
  const left: PatternMatch[] = [];
  const distance = (a: PatternMatch, b: PatternMatch) => Math.abs(a.range.start.line - b.range.start.line);
  let j = 0;
  for (const m of rest) {
    while (j + 1 < others.length && distance(others[j + 1]!, m) < distance(others[j]!, m)) left.push(others[j++]!);
    if (j < others.length) {
      j++;
      paired.push(m);
    } else unpaired.push(m);
  }
  for (; j < others.length; j++) left.push(others[j]!);
  return { paired, unpaired, left };
}

/**
 * Live map #11, as for symbols: while the file has a syntax error, a match the error touches stays only when the last
 * good parse had one with the same pattern and content (hash), and last good matches the text no longer gives are kept
 * at their old place. Identical matches are paired by place, so of two, the one the error hides is the one kept.
 */
function keepLastGood(found: readonly Found[], errors: readonly Node[], lastGood: readonly PatternMatch[], set: CompiledPatterns): PatternMatch[] {
  const strip = ({ set: id, pattern, range, hash, captures }: Found): PatternMatch => ({ set: id, pattern, range, hash, captures });
  if (!errors.length) return found.map(strip);
  const current = byKey(found);
  const old = byKey(lastGood.filter((m) => m.set === set.id && set.ids.includes(m.pattern)));
  const out: PatternMatch[] = [];
  for (const key of new Set([...current.keys(), ...old.keys()])) {
    const { paired, unpaired, left } = pair(current.get(key) ?? [], old.get(key) ?? []);
    for (const m of paired) out.push(strip(m));
    for (const m of unpaired) if (!m.broken) out.push(strip(m));
    for (const m of left) out.push({ ...m, kept: true });
  }
  return out;
}

const asList = (patterns: PatternSets): readonly PatternSet[] => (Array.isArray(patterns) ? patterns : [patterns as PatternSet]);

/** The sets as compiled, refusing anything else and two sets with one id. */
function compiledSets(patterns: PatternSets): CompiledPatterns[] {
  const sets = asList(patterns);
  const seen = new Set<string>();
  return sets.map((set) => {
    if (!(set instanceof CompiledPatterns)) throw new TypeError('patterns must come from compilePatterns');
    if (seen.has(set.id)) throw new Error(`pattern set id '${set.id}' is given twice`);
    seen.add(set.id);
    return set;
  });
}

/**
 * The sets' matches in a parsed tree, each set run on its own query and limits: `errors` are the tree's ERROR and
 * MISSING nodes, `lastGood` the file's previous matches. Sorted by position, then set order, then pattern order.
 */
export function matchPatterns(
  patterns: PatternSets,
  grammar: PatternGrammar,
  root: Node,
  errors: readonly Node[],
  lastGood: readonly PatternMatch[] | undefined,
): { matches: PatternMatch[]; patternLimits?: Record<string, PatternLimit> } {
  const sets = compiledSets(patterns);
  const order = new Map(sets.flatMap((set, s) => set.ids.map((id, p) => [`${set.id}\0${id}`, s * 1e6 + p] as const)));
  const limits: [string, PatternLimit][] = [];
  const matches: PatternMatch[] = [];
  for (const set of sets) {
    const query = set.queryFor(grammar);
    const { found, limit } = query ? run(set, query, root, errors) : { found: [] };
    if (limit) limits.push([set.id, limit]);
    // A loop, not push(...): a big file can give more matches than a call takes arguments.
    for (const m of keepLastGood(found, errors, lastGood ?? [], set)) matches.push(m);
  }
  const rank = (m: PatternMatch) => order.get(`${m.set}\0${m.pattern}`)!;
  matches.sort(
    (a, b) =>
      a.range.start.line - b.range.start.line ||
      a.range.start.column - b.range.start.column ||
      rank(a) - rank(b) ||
      a.range.end.line - b.range.end.line ||
      a.range.end.column - b.range.end.column,
  );
  // fromEntries makes an own property of any id, __proto__ too.
  return { matches, ...(limits.length && { patternLimits: Object.fromEntries(limits) }) };
}

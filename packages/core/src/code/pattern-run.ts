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
 * Where matches start, as one number in which a line outweighs any column: the line times one more than the widest
 * column in the group of identical matches (current and last good), plus the column. Distance on it is a distance on a line, where a best pairing
 * never crosses.
 */
type Place = (m: PatternMatch) => number;
function placeFor(matches: readonly PatternMatch[]): { place: Place; farthest: number } {
  let widest = 0;
  for (const m of matches) widest = Math.max(widest, m.range.start.column);
  const place: Place = (m) => m.range.start.line * (widest + 1) + m.range.start.column;
  let farthest = 0;
  for (const m of matches) farthest = Math.max(farthest, place(m));
  return { place, farthest };
}

/** Exact-pairing steps one parse may spend, shared by every group of every set; past it, `nearest` (best effort). */
const ALIGN_WORK = 1_000_000;

/** What is left of a parse's `ALIGN_WORK`. */
interface Budget {
  left: number;
}

/**
 * Whether a group pairs exactly or nearest first: exactly only when its `short × (difference + 1)` steps fit what is
 * left of the parse's budget, and when its largest possible total, `short` pairs each at most `farthest` (the
 * largest place) apart, stays a safe integer, so sums and their comparisons are exact.
 */
export function alignMethod(short: number, long: number, farthest: number, left: number): 'exact' | 'nearest' {
  if (short * (long - short + 1) > left) return 'nearest';
  return short * farthest > Number.MAX_SAFE_INTEGER ? 'nearest' : 'exact';
}

/**
 * Pairs the shorter list with an in-order subsequence of the longer one, every entry of the shorter paired, with the
 * least total distance (on a tie, the earlier entries of the longer list). Exact by dynamic programming over the
 * entries of the shorter list and how many of the longer one are skipped, O(shorter × (difference + 1)), spent from
 * the parse's budget; `nearest` instead when `alignMethod` says so.
 */
function align<A extends PatternMatch, B extends PatternMatch>(short: readonly A[], long: readonly B[], place: Place, farthest: number, budget: Budget): [A, B][] {
  if (!short.length) return [];
  const distance = (a: PatternMatch, b: PatternMatch) => Math.abs(place(a) - place(b));
  const skips = long.length - short.length;
  if (alignMethod(short.length, long.length, farthest, budget.left) === 'nearest') return nearest(short, long, place);
  budget.left -= short.length * (skips + 1);
  // cost[s]: best total for the entries of `short` so far, the last one paired with long[i + s]; from[i][s]: the skip
  // count the previous entry was paired at.
  let cost = new Float64Array(skips + 1);
  const from: Int32Array[] = [];
  for (let i = 0; i < short.length; i++) {
    const next = new Float64Array(skips + 1);
    const back = new Int32Array(skips + 1);
    let best = 0;
    for (let s = 0; s <= skips; s++) {
      if (i > 0 && cost[s]! < cost[best]!) best = s;
      next[s] = (i === 0 ? 0 : cost[best]!) + distance(short[i]!, long[i + s]!);
      back[s] = best;
    }
    cost = next;
    from.push(back);
  }
  const pairs: [A, B][] = [];
  let s = 0;
  for (let k = 1; k <= skips; k++) if (cost[k]! < cost[s]!) s = k;
  for (let i = short.length - 1; i >= 0; i--) {
    pairs.push([short[i]!, long[i + s]!]);
    s = from[i]![s]!;
  }
  return pairs.reverse();
}

/**
 * Best effort, linear: each entry of the shorter list in order takes the nearest entry of the longer one still ahead,
 * skipping one only while enough are left for the entries still to pair, so every entry of the shorter list pairs.
 */
function nearest<A extends PatternMatch, B extends PatternMatch>(short: readonly A[], long: readonly B[], place: Place): [A, B][] {
  const distance = (a: PatternMatch, b: PatternMatch) => Math.abs(place(a) - place(b));
  const pairs: [A, B][] = [];
  let j = 0;
  for (const [i, m] of short.entries()) {
    while (long.length - j - 1 >= short.length - i && distance(long[j + 1]!, m) < distance(long[j]!, m)) j++;
    pairs.push([m, long[j++]!]);
  }
  return pairs;
}

/**
 * Pairs identical current and last good matches one to one: as many pairs as possible, then the least total distance
 * between starts (see `placeFor` and `align`). Matches still at the same place pair first: a shortcut that keeps an
 * unchanged file linear; some best pairing contains those pairs anyway.
 */
function pair(found: readonly Found[], old: readonly PatternMatch[], budget: Budget): { paired: Found[]; unpaired: Found[]; left: PatternMatch[] } {
  const { place, farthest } = placeFor([...found, ...old]);
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
  const currentFirst = rest.length <= others.length;
  const pairs = currentFirst ? align(rest, others, place, farthest, budget) : align(others, rest, place, farthest, budget).map(([o, c]) => [c, o] as const);
  const usedCurrent = new Set<PatternMatch>(pairs.map(([c]) => c));
  const usedOld = new Set<PatternMatch>(pairs.map(([, o]) => o));
  for (const [c] of pairs) paired.push(c as Found);
  return { paired, unpaired: rest.filter((m) => !usedCurrent.has(m)), left: others.filter((m) => !usedOld.has(m)) };
}

/**
 * Live map #11 for matches. Without a syntax error, the current matches are the result. With one, per group of identical
 * matches (same set, pattern and hash), current and last good matches are paired one to one (`pair`): a paired current
 * match is shown at its current place; an unpaired one only when no error touches it (nothing new from broken text); an
 * unpaired last good match is kept at its old place, marked `kept`; a paired last good match is not shown, so nothing
 * stale stands next to its current copy.
 */
function keepLastGood(found: readonly Found[], errors: readonly Node[], lastGood: readonly PatternMatch[], set: CompiledPatterns, budget: Budget): PatternMatch[] {
  const strip = ({ set: id, pattern, range, hash, captures }: Found): PatternMatch => ({ set: id, pattern, range, hash, captures });
  if (!errors.length) return found.map(strip);
  const current = byKey(found);
  const old = byKey(lastGood.filter((m) => m.set === set.id && set.ids.includes(m.pattern)));
  const out: PatternMatch[] = [];
  for (const key of new Set([...current.keys(), ...old.keys()])) {
    const { paired, unpaired, left } = pair(current.get(key) ?? [], old.get(key) ?? [], budget);
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
  const budget: Budget = { left: ALIGN_WORK };
  const matches: PatternMatch[] = [];
  for (const set of sets) {
    const query = set.queryFor(grammar);
    const { found, limit } = query ? run(set, query, root, errors) : { found: [] };
    if (limit) limits.push([set.id, limit]);
    // A loop, not push(...): a big file can give more matches than a call takes arguments.
    for (const m of keepLastGood(found, errors, lastGood ?? [], set, budget)) matches.push(m);
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

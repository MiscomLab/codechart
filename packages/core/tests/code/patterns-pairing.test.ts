import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser, Query, type Node } from 'web-tree-sitter';
import { parseCode } from '../../src/code/parse.js';
import { compilePatterns, type PatternSet } from '../../src/code/patterns.js';

/*
 * Live map #11 for pattern matches, checked as a whole against a brute-force oracle written from the spec, not from
 * the implementation. The spec, per group of identical matches (same set, pattern and hash) in a file with a syntax
 * error, old = the last good parse's matches, current = this parse's:
 *   - pair current with old one to one: as many pairs as possible, then the least total distance between starts, a
 *     start read as one number in which a line outweighs any column (ties: either);
 *   - a paired current match is shown at its current place, not kept;
 *   - an unpaired current match is shown only when no error touches it (nothing new from broken text);
 *   - an unpaired old match is kept at its old place, marked kept; a paired old match is never shown.
 * Without a syntax error, the current matches are shown as they are.
 *
 * The oracle reads the current and last good matches with raw web-tree-sitter (its own query run, its own error
 * nodes), tries every pairing of each group and accepts the output of any best one.
 */

const PATTERN = '(call_expression function: (member_expression property: (property_identifier) @method) arguments: (arguments . (string (string_fragment) @path))) @entity';

interface Seen {
  line: number;
  col: number;
  hash: string;
  broken: boolean;
}

let language: Language;
let parser: Parser;
let query: Query;
let patterns: PatternSet;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(createRequire(import.meta.url).resolve('tree-sitter-javascript/tree-sitter-javascript.wasm'));
  parser = new Parser();
  parser.setLanguage(language);
  query = new Query(language, PATTERN);
  patterns = await compilePatterns([{ id: 'call', grammar: 'javascript', pattern: PATTERN }]);
});
afterAll(() => {
  query.delete();
  parser.delete();
  patterns.delete();
});

/** ERROR and MISSING nodes, all of them. */
function errorsIn(node: Node, out: Node[] = []): Node[] {
  if (node.isError || node.isMissing) out.push(node);
  for (const child of node.children) if (child) errorsIn(child, out);
  return out;
}

/** In or at the edge of an error: a zero-width MISSING node touches a node ending or starting where it sits. */
const touchesError = (node: Node, e: Node) =>
  e.startIndex === e.endIndex ? node.startIndex <= e.startIndex && e.startIndex <= node.endIndex : e.startIndex < node.endIndex && e.endIndex > node.startIndex;

/** The query's @entity nodes, one per node, and whether the text has a syntax error. */
function raw(text: string): { seen: Seen[]; broken: boolean } {
  const tree = parser.parse(text)!;
  try {
    const errors = errorsIn(tree.rootNode);
    const byNode = new Map<string, Seen>();
    for (const match of query.matches(tree.rootNode)) {
      const node = match.captures.find((c) => c.name === 'entity')!.node;
      byNode.set(`${node.startIndex}:${node.endIndex}`, {
        line: node.startPosition.row + 1,
        col: node.startPosition.column,
        hash: createHash('sha256').update(node.text).digest('hex'),
        broken: errors.some((e) => touchesError(node, e)),
      });
    }
    return { seen: [...byNode.values()], broken: errors.length > 0 };
  } finally {
    tree.delete();
  }
}

type Shown = [line: number, col: number, kept: boolean];
/** A start as one number: a line outweighs any column (columns stay below 2^21 in a file of at most 1 MB). */
const place = (s: { line: number; col: number }) => s.line * 2 ** 21 + s.col;
const canonical = (shown: Shown[]) => JSON.stringify([...shown].sort((a, b) => a[0] - b[0] || a[1] - b[1] || Number(a[2]) - Number(b[2])));

/** Every output a best pairing of one group gives, by trying every one-to-one pairing. */
function bestOutputs(current: Seen[], old: Seen[]): Set<string> {
  let best: [number, number] | undefined;
  let outputs = new Set<string>();
  const pairing: (number | undefined)[] = [];
  const used = new Set<number>();
  const visit = (i: number) => {
    if (i === current.length) {
      let pairs = 0;
      let total = 0;
      const shown: Shown[] = [];
      current.forEach((c, k) => {
        const o = pairing[k];
        if (o === undefined) {
          if (!c.broken) shown.push([c.line, c.col, false]);
          return;
        }
        pairs++;
        total += Math.abs(place(c) - place(old[o]!));
        shown.push([c.line, c.col, false]);
      });
      old.forEach((o, k) => {
        if (!used.has(k)) shown.push([o.line, o.col, true]);
      });
      const score: [number, number] = [-pairs, total];
      const cmp = best ? score[0] - best[0] || score[1] - best[1] : -1;
      if (cmp < 0) {
        best = score;
        outputs = new Set([canonical(shown)]);
      } else if (cmp === 0) outputs.add(canonical(shown));
      return;
    }
    pairing[i] = undefined;
    visit(i + 1);
    for (let o = 0; o < old.length; o++) {
      if (used.has(o)) continue;
      used.add(o);
      pairing[i] = o;
      visit(i + 1);
      used.delete(o);
    }
    pairing[i] = undefined;
  };
  visit(0);
  return outputs;
}

// Identical calls alone, two on one line, and indented, so groups differ in columns as well as lines.
const CALLS = ["app.get('/a', h);", "app.get('/a', h);", "app.get('/a', h); app.get('/a', h);", "    app.get('/a', h);", "app.get('/b', h);", 'x;', ''];
const line = fc.constantFrom(...CALLS);
const edit = fc.oneof(
  fc.record({ op: fc.constant('insert' as const), at: fc.nat(), text: line }),
  fc.record({ op: fc.constant('delete' as const), at: fc.nat() }),
  fc.record({ op: fc.constant('move' as const), at: fc.nat(), to: fc.nat() }),
);
const breakage = fc.oneof(
  fc.record({ kind: fc.constant('none' as const) }),
  fc.record({ kind: fc.constant('stray' as const), at: fc.nat() }),
  fc.record({ kind: fc.constant('open-call' as const), at: fc.nat() }),
  fc.record({ kind: fc.constant('open-array' as const), at: fc.nat() }),
);

function apply(lines: string[], edits: { op: string; at: number; text?: string; to?: number }[]): string[] {
  const out = [...lines];
  for (const e of edits) {
    if (e.op === 'insert') out.splice(e.at % (out.length + 1), 0, e.text!);
    else if (e.op === 'delete' && out.length) out.splice(e.at % out.length, 1);
    else if (e.op === 'move' && out.length) out.splice(e.to! % out.length, 0, ...out.splice(e.at % out.length, 1));
  }
  return out;
}

function breakText(lines: string[], b: { kind: string; at?: number }): string[] {
  const out = [...lines];
  const calls = out.flatMap((l, i) => (l.includes('app.') ? [i] : []));
  if (b.kind === 'stray') out.splice(b.at! % (out.length + 1), 0, 'foo(;');
  // A call left open: its text changes, so it is a match the error touches with new content.
  if (b.kind === 'open-call' && calls.length) out[calls[b.at! % calls.length]!] = out[calls[b.at! % calls.length]!]!.replace(');', ';');
  // A call inside an unclosed array: its text stays, and the missing ] touches it.
  if (b.kind === 'open-array' && calls.length) out[calls[b.at! % calls.length]!] = `z = [${out[calls[b.at! % calls.length]!]!}`;
  return out;
}

describe('pairing identical matches across a syntax error, against a brute-force oracle', () => {
  it('matches the spec on generated edits (fixed seed)', async () => {
    let broken = 0;
    // Groups with a real choice: two or more identical last good matches and at least one current one.
    let choices = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(line, { minLength: 1, maxLength: 6 }), fc.array(edit, { maxLength: 3 }), breakage, async (start, edits, b) => {
        const goodText = `${start.join('\n')}\n`;
        const nowText = `${breakText(apply(start, edits), b).join('\n')}\n`;
        const before = raw(goodText);
        if (before.broken) return;
        const now = raw(nowText);
        if (now.broken) broken++;
        const good = await parseCode('a.js', goodText, undefined, { patterns });
        const parsed = await parseCode('a.js', nowText, good, { patterns });
        const got = parsed!.matches!;
        if (!now.broken) {
          expect(canonical(got.map((m) => [m.range.start.line, m.range.start.column, m.kept ?? false]))).toBe(canonical(now.seen.map((s) => [s.line, s.col, false])));
          return;
        }
        const hashes = new Set([...now.seen, ...before.seen].map((s) => s.hash));
        for (const m of got) expect(hashes.has(m.hash)).toBe(true);
        for (const hash of hashes) {
          const shown = canonical(got.filter((m) => m.hash === hash).map((m) => [m.range.start.line, m.range.start.column, m.kept ?? false]));
          const current = now.seen.filter((s) => s.hash === hash);
          const old = before.seen.filter((s) => s.hash === hash);
          if (current.length && old.length > 1) choices++;
          const allowed = bestOutputs(current, old);
          expect(allowed, `good:\n${goodText}now:\n${nowText}`).toContain(shown);
        }
      }),
      { seed: 54, numRuns: 3000 },
    );
    // The generator must reach broken files often, or the property says little.
    expect(broken).toBeGreaterThan(1000);
    expect(choices).toBeGreaterThan(500);
  }, 120_000);
});

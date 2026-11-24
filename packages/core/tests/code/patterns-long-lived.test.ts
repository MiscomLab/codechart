import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openCodeIndex } from '../../src/code/code-index.js';
import { parseCode } from '../../src/code/parse.js';
import { compilePatterns, type PatternSet } from '../../src/code/patterns.js';

// The app runs every pattern in one long-lived process, where web-tree-sitter shares one query cursor whose pool of
// in-progress matches only grows, so the match limit stops biting. The time limit must hold there anyway.
const PATHOLOGICAL = '(_ (_)* @a (_)* @b (_)* @c) @entity';
const declarations = (n: number) => Array.from({ length: n }, (_, i) => `const a${i} = [${Array.from({ length: 30 }, (_, j) => j).join(', ')}];`).join('\n');
const big = declarations(4000);

let repo: string;
const sets: PatternSet[] = [];
const compile = async (...args: Parameters<typeof compilePatterns>) => {
  const set = await compilePatterns(...args);
  sets.push(set);
  return set;
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'codechart-long-lived-'));
  writeFileSync(join(repo, 'routes.js'), "app.get('/users', list);\napp.post('/users', create);\n");
  writeFileSync(join(repo, 'models.py'), 'class User(Base):\n    pass\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
});
afterAll(() => {
  sets.forEach((s) => s.delete());
  rmSync(repo, { recursive: true, force: true });
});

it('cuts off a pathological pattern within its time limit after other queries ran in the same process, and says so', async () => {
  // Other queries first: symbols and imports of a file, a pattern set without a practical match limit, and a
  // pathological one with the same, cancelled midway, which grows the shared pool far past the default limit.
  await parseCode('a.ts', 'import { b } from "./b";\nexport function a() { return b(); }\n');
  const grow = await compile([{ id: 'pairs', grammar: 'typescript', pattern: '(program (lexical_declaration) @entity (lexical_declaration) @other)' }], {
    matchLimit: 65536,
    timeoutMs: 10_000,
  });
  const grown = await parseCode('mid.ts', declarations(300), undefined, { patterns: grow });
  expect(grown?.matches).toHaveLength(299);
  expect('patternLimits' in grown!).toBe(false);
  const cancelled = await parseCode('big.ts', big, undefined, {
    patterns: await compile([{ id: 'slow', grammar: 'typescript', pattern: PATHOLOGICAL }], { timeoutMs: 200, matchLimit: 65536 }),
  });
  expect(cancelled?.patternLimits).toStrictEqual({ patterns: 'timeout' });

  // The app's live path: an index with its patterns, then a save of a file the user's pattern chokes on.
  const timeoutMs = 100;
  const patterns = await compile(
    [
      { id: 'route', grammar: 'javascript', pattern: '(call_expression function: (member_expression property: (property_identifier) @method)) @entity' },
      { id: 'slow', grammar: 'javascript', pattern: PATHOLOGICAL },
    ],
    { timeoutMs },
  );
  const index = await openCodeIndex(repo, { patterns });
  // A query cancelled before does not halt the next: the small file is read in full.
  expect(index.file('routes.js')?.matches?.filter((m) => m.pattern === 'route').map((m) => m.captures.method)).toEqual(['get', 'post']);
  expect('patternLimits' in index.file('routes.js')!).toBe(false);

  writeFileSync(join(repo, 'big.js'), big);
  const started = performance.now();
  const update = await index.update(['big.js']);
  const elapsed = performance.now() - started;
  expect(update.parsed).toEqual(['big.js']);
  const file = index.file('big.js')!;
  expect(file.patternLimits).toStrictEqual({ patterns: 'timeout' });
  // Uncapped, this query was still running after 30 s on this file. The rest is the parse and link of a 4000-line file.
  expect(elapsed).toBeLessThan(timeoutMs + 2000);
  // Cut off, not silently empty: what was found before the cut is there, and is real code.
  expect(file.matches!.length).toBeGreaterThan(0);
  const lines = big.split('\n');
  const offset = (line: number, column: number) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column;
  for (const m of file.matches!.slice(0, 50)) {
    const text = big.slice(offset(m.range.start.line, m.range.start.column), offset(m.range.end.line, m.range.end.column));
    expect(m.hash).toBe(createHash('sha256').update(text).digest('hex'));
  }

  // And a cheap parse after it still runs in full.
  const after = await parseCode('more.js', "app.put('/x', h);\n", undefined, { patterns });
  expect(after?.matches?.filter((m) => m.pattern === 'route')).toHaveLength(1);
  // Parsing a 4000-line file several times: more than the default 5 s on a slow runner; the time check above is the bound.
}, 20_000);

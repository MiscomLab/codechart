import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openCodeIndex, type CodeIndex } from '../../src/code/code-index.js';
import { parseCode } from '../../src/code/parse.js';
import { alignMethod } from '../../src/code/pattern-run.js';
import { compilePatterns, type PatternSet } from '../../src/code/patterns.js';
import { parseRepo } from '../../src/code/repo.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'code', 'patterns');

const ROUTES = `
(program
  (expression_statement
    (call_expression
      function: (member_expression object: (identifier) @app property: (property_identifier) @method)
      arguments: (arguments . (string (string_fragment) @path))) @entity)
  (#any-of? @method "get" "post" "put" "patch" "delete"))
`;
const DJANGO = `
(class_definition
  name: (identifier) @name
  superclasses: (argument_list (attribute object: (identifier) @module attribute: (identifier) @base))
  (#eq? @module "models")
  (#eq? @base "Model")) @entity
`;

let patterns: PatternSet;
let repo: string;
let index: CodeIndex;

const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
const routes = (path = 'express.js') => index.file(path)?.matches?.map((m) => [m.captures.method, m.captures.path, m.range.start.line, m.kept ?? false]);

beforeAll(async () => {
  patterns = await compilePatterns([
    { id: 'route', grammar: 'javascript', pattern: ROUTES },
    { id: 'django-model', grammar: 'python', pattern: DJANGO },
  ]);
});
afterAll(() => patterns.delete());

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'codechart-patterns-'));
  cpSync(join(FIXTURES, 'express.js'), join(repo, 'express.js'));
  cpSync(join(FIXTURES, 'models_django.py'), join(repo, 'models.py'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  index = await openCodeIndex(repo, { patterns });
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('openCodeIndex with patterns', () => {
  it('runs them on every file at open', () => {
    expect(routes()).toEqual([
      ['get', '/users', 9, false],
      ['post', '/users', 10, false],
      ['delete', '/users/:id', 12, false],
    ]);
    expect(index.file('models.py')?.matches?.map((m) => m.captures.name)).toEqual(['Author', 'Article']);
  });

  it('gives the same matches as parseRepo', async () => {
    const files = await parseRepo(repo, { patterns });
    expect(files.map((f) => [f.file.path, f.matches?.length])).toEqual([
      ['express.js', 3],
      ['models.py', 2],
    ]);
    expect(Object.fromEntries(files.map((f) => [f.file.path, f.matches]))).toEqual(Object.fromEntries(index.files.map((f) => [f.file.path, f.matches])));
  });

  it('an edit re-runs them on the saved file only; the other keeps its matches', async () => {
    const models = index.file('models.py')?.matches;
    write('express.js', read('express.js').replace("app.use('/api', router);", "app.put('/users/:id', updateUser);\napp.use('/api', router);"));
    const update = await index.update(['express.js']);
    expect(update.parsed).toEqual(['express.js']);
    expect(routes()).toEqual([
      ['get', '/users', 9, false],
      ['post', '/users', 10, false],
      ['delete', '/users/:id', 12, false],
      ['put', '/users/:id', 20, false],
    ]);
    expect(index.file('models.py')?.matches).toBe(models);
  });

  it('a line move updates the range', async () => {
    write('express.js', `// header\n${read('express.js')}`);
    await index.update(['express.js']);
    expect(routes()?.map((r) => r[2])).toEqual([10, 11, 13]);
  });

  it('broken text adds no match and keeps the last good one it hides', async () => {
    const before = index.file('express.js')!.matches!;
    // The route's path is edited and its call left open.
    write('express.js', read('express.js').replace("app.get('/users', listUsers);", "app.get('/people', listUsers"));
    await index.update(['express.js']);
    const after = index.file('express.js')!;
    expect(after.parseErrors.length).toBeGreaterThan(0);
    expect(after.matches?.some((m) => m.captures.path === '/people')).toBe(false);
    const kept = after.matches?.find((m) => m.captures.method === 'get');
    expect(kept).toStrictEqual({ ...before[0], kept: true });
    // The delete route sits below the error; it is either parsed again or kept, never lost.
    expect(after.matches?.some((m) => m.captures.method === 'delete')).toBe(true);
  });

  it('fixing the text drops the kept match and reads the new one', async () => {
    write('express.js', read('express.js').replace("app.get('/users', listUsers);", "app.get('/people', listUsers"));
    await index.update(['express.js']);
    write('express.js', read('express.js').replace("app.get('/people', listUsers", "app.get('/people', listUsers);"));
    await index.update(['express.js']);
    expect(index.file('express.js')?.parseErrors).toEqual([]);
    expect(routes()).toEqual([
      ['get', '/people', 9, false],
      ['post', '/users', 10, false],
      ['delete', '/users/:id', 12, false],
    ]);
  });

  it('a route removed while another part of the file is broken stays until the file parses', async () => {
    write('express.js', read('express.js').replace('app.post("/users", createUser);\n', '').replace('app.listen(3000);', 'app.listen(3000'));
    await index.update(['express.js']);
    expect(index.file('express.js')?.matches?.find((m) => m.captures.method === 'post')?.kept).toBe(true);
    write('express.js', read('express.js').replace('app.listen(3000', 'app.listen(3000);'));
    await index.update(['express.js']);
    expect(routes()?.map((r) => r[0])).toEqual(['get', 'delete']);
  });

  it('a new file gets matches and a deleted one leaves', async () => {
    write('more.js', "app.patch('/users/:id', patchUser);\n");
    await index.update(['more.js']);
    expect(routes('more.js')).toEqual([['patch', '/users/:id', 1, false]]);
    unlinkSync(join(repo, 'express.js'));
    await index.update(['express.js']);
    expect(index.file('express.js')).toBeUndefined();
  });

  it('a new route clear of an error is read while the file is broken', async () => {
    write('express.js', `app.put('/x', h);\n${read('express.js').replace('app.listen(3000);', 'app.listen(3000')}`);
    await index.update(['express.js']);
    expect(index.file('express.js')?.parseErrors).not.toEqual([]);
    expect(routes()).toEqual([
      ['put', '/x', 1, false],
      ['get', '/users', 10, false],
      ['post', '/users', 11, false],
      ['delete', '/users/:id', 13, false],
    ]);
  });

  it('a file cut off by the time limit keeps its mark through the update', async () => {
    const slow = await compilePatterns([{ id: 'slow', grammar: 'javascript', pattern: '(_ (_)* @a (_)* @b (_)* @c) @entity' }], { id: 'slow', timeoutMs: 20 });
    try {
      const big = Array.from({ length: 4000 }, (_, i) => `const a${i} = [${Array.from({ length: 30 }, (_, j) => j).join(', ')}];`).join('\n');
      write('big.js', big);
      const slowIndex = await openCodeIndex(repo, { patterns: slow });
      expect(slowIndex.file('big.js')?.patternLimits).toStrictEqual({ slow: 'timeout' });
      expect('patternLimits' in slowIndex.file('models.py')!).toBe(false);
      write('big.js', `${big}\n// edited`);
      const update = await slowIndex.update(['big.js']);
      expect(update.parsed).toEqual(['big.js']);
      expect(slowIndex.file('big.js')?.patternLimits).toStrictEqual({ slow: 'timeout' });
    } finally {
      slow.delete();
    }
  });

  it('an index with a built-in and a user set: a slow user pattern costs the built-in set nothing, on open and on update', async () => {
    const builtin = await compilePatterns([{ id: 'route', grammar: 'javascript', pattern: ROUTES }], { id: 'builtin' });
    const user = await compilePatterns([{ id: 'slow', grammar: 'javascript', pattern: '(_ (_)* @a (_)* @b (_)* @c) @entity' }], { id: 'user', timeoutMs: 20 });
    try {
      const routes = Array.from({ length: 2000 }, (_, i) => `app.get('/r${i}', [${Array.from({ length: 30 }, (_, j) => j).join(', ')}]);`).join('\n');
      write('routes.js', routes);
      const both = await openCodeIndex(repo, { patterns: [builtin, user] });
      const builtinRoutes = () => both.file('routes.js')?.matches?.filter((m) => m.set === 'builtin').length;
      expect(both.file('routes.js')?.patternLimits).toStrictEqual({ user: 'timeout' });
      expect(builtinRoutes()).toBe(2000);
      write('routes.js', `${routes}\napp.post('/last', h);`);
      await both.update(['routes.js']);
      expect(both.file('routes.js')?.patternLimits).toStrictEqual({ user: 'timeout' });
      expect(builtinRoutes()).toBe(2001);
    } finally {
      builtin.delete();
      user.delete();
    }
  }, 20_000);

  it('parseRepo takes several sets too', async () => {
    const builtin = await compilePatterns([{ id: 'route', grammar: 'javascript', pattern: ROUTES }], { id: 'builtin' });
    const user = await compilePatterns([{ id: 'model', grammar: 'python', pattern: DJANGO }], { id: 'user' });
    try {
      const files = await parseRepo(repo, { patterns: [builtin, user] });
      expect(files.map((f) => [f.file.path, f.matches?.map((m) => `${m.set}:${m.pattern}`)])).toEqual([
        ['express.js', ['builtin:route', 'builtin:route', 'builtin:route']],
        ['models.py', ['user:model', 'user:model']],
      ]);
    } finally {
      builtin.delete();
      user.delete();
    }
  });

  it('an index opened without patterns has no matches', async () => {
    const plain = await openCodeIndex(repo);
    expect(plain.files.every((f) => !('matches' in f))).toBe(true);
  });
});

describe('parseCode with a last good parse', () => {
  const CALLS = '(call_expression function: (member_expression property: (property_identifier) @method) arguments: (arguments . (string (string_fragment) @path))) @entity';
  let calls: PatternSet;
  beforeAll(async () => {
    calls = await compilePatterns([{ id: 'call', grammar: 'javascript', pattern: CALLS }]);
  });
  afterAll(() => calls.delete());
  const shape = (f: Awaited<ReturnType<typeof parseCode>>) => f?.matches?.map((m) => [m.captures.path, m.range.start.line, m.range.start.column, m.kept ?? false]);

  it('keeps only last good matches of patterns still in the set', async () => {
    const text = "app.get('/users', list);\napp.post('/users', create);\n";
    const old = await compilePatterns([
      { id: 'route', grammar: 'javascript', pattern: ROUTES },
      { id: 'gone', grammar: 'javascript', pattern: '(program (expression_statement (call_expression) @entity))' },
    ]);
    try {
      const good = await parseCode('a.js', text, undefined, { patterns: old });
      expect(good?.matches?.map((m) => m.pattern)).toEqual(['route', 'gone', 'route', 'gone']);
      // tree-sitter reads the open call as one call spanning both lines, through the error: nothing new comes from it.
      const broken = await parseCode('a.js', "app.get('/users', list\napp.post('/users', create);\n", good, { patterns });
      expect(broken?.matches?.map((m) => [m.pattern, m.captures.method, m.range.start.line, m.kept ?? false])).toEqual([
        ['route', 'get', 1, true],
        ['route', 'post', 2, true],
      ]);
    } finally {
      old.delete();
    }
  });

  it('keeps last good matches per set, and none of a set no longer given', async () => {
    const a = await compilePatterns([{ id: 'call', grammar: 'javascript', pattern: CALLS }], { id: 'a' });
    const b = await compilePatterns([{ id: 'call', grammar: 'javascript', pattern: CALLS }], { id: 'b' });
    try {
      const good = await parseCode('a.js', "app.get('/users', h);\n", undefined, { patterns: [a, b] });
      expect(good?.matches?.map((m) => m.set)).toEqual(['a', 'b']);
      const broken = await parseCode('a.js', "app.get('/people', h;\n", good, { patterns: [a] });
      expect(broken?.matches?.map((m) => [m.set, m.captures.path, m.kept])).toStrictEqual([['a', '/users', true]]);
    } finally {
      a.delete();
      b.delete();
    }
  });

  it('many identical matches in a broken file cost about what a clean parse does, not the square (Greptile #101)', async () => {
    const names = await compilePatterns([{ id: 'name', grammar: 'javascript', pattern: '(identifier) @entity' }], { id: 'names' });
    try {
      const n = 80_000;
      const good = await parseCode('a.js', 'x;\n'.repeat(n), undefined, { patterns: names });
      let started = performance.now();
      await parseCode('a.js', `${'x;\n'.repeat(n)}y;`, good, { patterns: names });
      const clean = performance.now() - started;
      started = performance.now();
      const broken = await parseCode('a.js', `${'x;\n'.repeat(n)}(`, good, { patterns: names });
      const elapsed = performance.now() - started;
      expect(broken?.parseErrors).not.toEqual([]);
      expect(broken?.matches).toHaveLength(n);
      // Measured before the fix: clean 279 ms, broken 6,816 ms at this size (4x per doubling of n).
      expect(elapsed).toBeLessThan(4 * clean + 1000);
    } finally {
      names.delete();
    }
  }, 60_000);

  it('the same when all of them move down a line: they pair by place, the one left over by distance', async () => {
    const names = await compilePatterns([{ id: 'name', grammar: 'javascript', pattern: '(identifier) @entity' }], { id: 'names' });
    try {
      const n = 80_000;
      const good = await parseCode('a.js', 'x;\n'.repeat(n), undefined, { patterns: names });
      let started = performance.now();
      await parseCode('a.js', `y;\n${'x;\n'.repeat(n)}`, good, { patterns: names });
      const clean = performance.now() - started;
      started = performance.now();
      const broken = await parseCode('a.js', `y;\n${'x;\n'.repeat(n)}(`, good, { patterns: names });
      const elapsed = performance.now() - started;
      expect(broken?.parseErrors).not.toEqual([]);
      const xs = broken!.matches!.filter((m) => m.hash === createHash('sha256').update('x').digest('hex'));
      expect(xs).toHaveLength(n);
      expect(xs.every((m) => !m.kept)).toBe(true);
      expect(elapsed).toBeLessThan(4 * clean + 1000);
    } finally {
      names.delete();
    }
  }, 60_000);

  it('none left at its place and twice as many before: the pairing by distance stays bounded (gate #101)', async () => {
    const names = await compilePatterns([{ id: 'name', grammar: 'javascript', pattern: '(identifier) @entity' }], { id: 'names' });
    try {
      const n = 40_000;
      const good = await parseCode('a.js', 'x;\n'.repeat(n), undefined, { patterns: names });
      let started = performance.now();
      await parseCode('a.js', ' x;\n'.repeat(n / 2), good, { patterns: names });
      const clean = performance.now() - started;
      started = performance.now();
      const broken = await parseCode('a.js', `${' x;\n'.repeat(n / 2)}(`, good, { patterns: names });
      const elapsed = performance.now() - started;
      expect(broken?.parseErrors).not.toEqual([]);
      const xs = broken!.matches!.filter((m) => m.hash === createHash('sha256').update('x').digest('hex'));
      // Every current match pairs with one last good match; the other half is kept.
      expect(xs.filter((m) => !m.kept)).toHaveLength(n / 2);
      expect(xs.filter((m) => m.kept)).toHaveLength(n / 2);
      expect(elapsed).toBeLessThan(4 * clean + 1000);
    } finally {
      names.delete();
    }
  }, 120_000);

  it('identical matches on one line pair by the least distance, columns included (gate #101)', async () => {
    const good = await parseCode('a.js', "y;\n                  app.get('/a', h);\napp.get('/a', h); app.get('/a', h);\n", undefined, { patterns: calls });
    const broken = await parseCode('a.js', "app.get('/a', h); app.get('/a', h);\ny;\nz;\nfoo(;\n", good, { patterns: calls });
    expect(broken?.matches?.map((m) => [m.range.start.line, m.range.start.column, m.kept ?? false])).toEqual([
      [1, 0, false],
      [1, 18, false],
      [3, 18, true],
    ]);
  });

  it('a line longer than 2^21 characters still counts more than any column', async () => {
    // The last good copies sit on line 1 past column 2^21 and on line 2; the current one is on line 1.
    const far = 2 ** 21 + 10;
    const good = await parseCode('a.js', `${' '.repeat(far)}app.get('/a', h);\napp.get('/a', h); app.get('/a', h);\n`, undefined, { patterns: calls });
    expect(good?.matches?.map((m) => [m.range.start.line, m.range.start.column])).toEqual([
      [1, far],
      [2, 0],
      [2, 18],
    ]);
    const broken = await parseCode('a.js', "app.get('/a', h);\nfoo(;\n", good, { patterns: calls });
    expect(broken?.matches?.map((m) => [m.range.start.line, m.range.start.column, m.kept ?? false])).toEqual([
      [1, 0, false],
      [2, 0, true],
      [2, 18, true],
    ]);
  }, 30_000);

  it('past the work cap, the fallback still skips to the nearest copies: an edit above leaves no stale copy in place (gate #101)', async () => {
    const names = await compilePatterns([{ id: 'name', grammar: 'javascript', pattern: '(identifier) @entity' }], { id: 'names' });
    try {
      // 1000 current × 1001 skips is past the cap, so the fallback pairs them.
      const good = await parseCode('a.js', 'x;\n'.repeat(2000), undefined, { patterns: names });
      const broken = await parseCode('a.js', `${'\n'.repeat(1000)}${' x;\n'.repeat(1000)}(`, good, { patterns: names });
      const kept = broken!.matches!.filter((m) => m.hash === createHash('sha256').update('x').digest('hex') && m.kept).map((m) => m.range.start.line);
      expect(kept).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
    } finally {
      names.delete();
    }
  });

  it('past the work cap, the fallback keeps the hard guarantees: counts, and no kept copy where a current one is', async () => {
    const names = await compilePatterns([{ id: 'name', grammar: 'javascript', pattern: '(identifier) @entity' }], { id: 'names' });
    const x = createHash('sha256').update('x').digest('hex');
    try {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1000, max: 1300 }), fc.integer({ min: 2200, max: 2600 }), fc.array(fc.nat(), { maxLength: 40 }), async (now, before, blanks) => {
          const good = await parseCode('a.js', 'x;\n'.repeat(before), undefined, { patterns: names });
          // Indented, so none pairs by place and every group goes past the work budget (at least 1000 × 901 steps).
          const lines: string[] = Array.from({ length: now }, () => ' x;');
          for (const at of blanks) lines.splice(at % (lines.length + 1), 0, '');
          // The error is past the last line, touching none of the matches.
          const broken = await parseCode('a.js', `${lines.join('\n')}\n(`, good, { patterns: names });
          const xs = broken!.matches!.filter((m) => m.hash === x);
          const current = xs.filter((m) => !m.kept);
          const kept = xs.filter((m) => m.kept);
          expect(current).toHaveLength(now);
          expect(kept).toHaveLength(before - now);
          const places = new Set(current.map((m) => `${m.range.start.line}:${m.range.start.column}`));
          for (const m of kept) expect(places.has(`${m.range.start.line}:${m.range.start.column}`)).toBe(false);
        }),
        { seed: 54, numRuns: 25 },
      );
    } finally {
      names.delete();
    }
  }, 120_000);

  it('one work budget per parse: groups each under it but together past it leave the last ones to the fallback', async () => {
    const names = await compilePatterns([{ id: 'name', grammar: 'javascript', pattern: '(identifier) @entity' }], { id: 'names' });
    try {
      // Four groups of 500 current against 999 last good, none at its place: 500 × 500 steps each, the whole budget.
      const fillers = ['a0', 'a1', 'a2', 'a3'];
      const before = fillers.map((a) => `${a};\n`.repeat(999)).join('');
      const now = `${fillers.map((a) => ` ${a};\n`.repeat(500)).join('')}${'\n'.repeat(4 * 999 - 4 * 500)}`;
      // Then a group of two current (lines 3, 4) against three last good (lines 1, 2, 8): the exact pairing keeps
      // line 8, the nearest-first fallback line 1.
      const g = (lines: number[]) => Array.from({ length: 8 }, (_, i) => (lines.includes(i + 1) ? 'g;' : '')).join('\n');
      const base = 4 * 999;
      const good = await parseCode('a.js', `${before}${g([1, 2, 8])}\n`, undefined, { patterns: names });
      const broken = await parseCode('a.js', `${now}${g([3, 4])}\n\n(`, good, { patterns: names });
      const gs = broken!.matches!.filter((m) => m.hash === createHash('sha256').update('g').digest('hex'));
      expect(gs.map((m) => [m.range.start.line - base, m.kept ?? false])).toEqual([
        [1, true],
        [3, false],
        [4, false],
      ]);
      // The same group alone gets the exact pairing.
      const alone = await parseCode('a.js', `${g([3, 4])}\n\n(`, await parseCode('a.js', `${g([1, 2, 8])}\n`, undefined, { patterns: names }), { patterns: names });
      expect(alone!.matches!.map((m) => [m.range.start.line, m.kept ?? false])).toEqual([
        [3, false],
        [4, false],
        [8, true],
      ]);
    } finally {
      names.delete();
    }
  }, 60_000);

  it('the exact pairing runs only when it fits the budget left and its sums stay exact', () => {
    // short × (difference + 1) steps against what is left of the parse's budget.
    expect(alignMethod(500, 999, 10_000, 250_000)).toBe('exact');
    expect(alignMethod(500, 999, 10_000, 249_999)).toBe('nearest');
    // The largest total is at most short × the widest place; past Number.MAX_SAFE_INTEGER sums lose precision.
    expect(alignMethod(1, 1, Number.MAX_SAFE_INTEGER, 1_000_000)).toBe('exact');
    expect(alignMethod(2, 2, 2 ** 52, 1_000_000)).toBe('nearest');
    expect(alignMethod(2, 2, 2 ** 52 - 1, 1_000_000)).toBe('exact');
  });

  it('a list of last good symbols carries no matches; one clear of the error still counts', async () => {
    // The open call is a match the error touches: new from broken text, so dropped.
    const broken = await parseCode('a.js', "app.post('/a', h);\napp.get('/b', h;\n", [], { patterns: calls });
    expect(broken?.matches?.map((m) => [m.captures.path, m.kept])).toStrictEqual([['/a', undefined]]);
  });

  it('a last good parse made without patterns counts as none', async () => {
    const good = await parseCode('a.js', "app.post('/a', h);\napp.get('/b', h);\n");
    expect(good && 'matches' in good).toBe(false);
    const broken = await parseCode('a.js', "app.post('/a', h);\napp.get('/b', h;\n", good, { patterns: calls });
    expect(broken?.matches?.map((m) => [m.captures.path, m.kept])).toStrictEqual([['/a', undefined]]);
  });

  it('a match the error touches stays current, not kept, when the last good parse had the same text', async () => {
    const good = await parseCode('a.js', "x = [app.get('/users', h)];\n", undefined, { patterns: calls });
    // The closing ] goes missing right where the call ends.
    const broken = await parseCode('a.js', "\nx = [app.get('/users', h);\n", good, { patterns: calls });
    expect(broken?.parseErrors).not.toEqual([]);
    expect(shape(broken)).toEqual([['/users', 2, 5, false]]);
  });

  it('a match the error touches with new text is dropped, and the last good one kept', async () => {
    const good = await parseCode('a.js', "x = [app.get('/users', h)];\n", undefined, { patterns: calls });
    const broken = await parseCode('a.js', "x = [app.get('/people', h);\n", good, { patterns: calls });
    expect(shape(broken)).toEqual([['/users', 1, 5, true]]);
  });

  it('a match the error touches with the same captures but new content is dropped, and the last good one kept', async () => {
    const good = await parseCode('a.js', "x = [app.get('/users', h)];\n", undefined, { patterns: calls });
    const broken = await parseCode('a.js', "x = [app.get('/users', other);\n", good, { patterns: calls });
    expect(shape(broken)).toEqual([['/users', 1, 5, true]]);
    expect(broken?.matches?.[0]?.hash).toBe(createHash('sha256').update("app.get('/users', h)").digest('hex'));
  });

  it('the same for a pattern without captures: only the content tells the edit apart', async () => {
    const bare = await compilePatterns([{ id: 'call', grammar: 'javascript', pattern: '(call_expression) @entity' }], { id: 'bare' });
    try {
      const good = await parseCode('a.js', "x = [app.get('/users', h)];\n", undefined, { patterns: bare });
      const broken = await parseCode('a.js', "x = [app.get('/users', other);\n", good, { patterns: bare });
      expect(broken?.matches?.map((m) => [m.range.end.column, m.kept ?? false, m.hash])).toEqual([[25, true, createHash('sha256').update("app.get('/users', h)").digest('hex')]]);
    } finally {
      bare.delete();
    }
  });

  it('two identical matches: one still parsed, the hidden one kept', async () => {
    const good = await parseCode('a.js', "app.get('/users', h);\napp.get('/users', h);\n", undefined, { patterns: calls });
    const broken = await parseCode('a.js', "app.get('/users', h);\napp.get('/users', h;\n", good, { patterns: calls });
    expect(shape(broken)).toEqual([
      ['/users', 1, 0, false],
      ['/users', 2, 0, true],
    ]);
  });

  it('two identical matches, the first hidden: the second stays where it is, the first is kept at its own place (Greptile #101)', async () => {
    const good = await parseCode('a.js', "app.get('/users', h);\napp.get('/users', h);\n", undefined, { patterns: calls });
    const broken = await parseCode('a.js', "app.get('/users', h;\napp.get('/users', h);\n", good, { patterns: calls });
    expect(shape(broken)).toEqual([
      ['/users', 1, 0, true],
      ['/users', 2, 0, false],
    ]);
  });

  it('the same when an edit above also moves them down a line', async () => {
    const good = await parseCode('a.js', "app.get('/users', h);\napp.get('/users', h);\n", undefined, { patterns: calls });
    const broken = await parseCode('a.js', "// moved\napp.get('/users', h;\napp.get('/users', h);\n", good, { patterns: calls });
    expect(shape(broken)).toEqual([
      ['/users', 1, 0, true],
      ['/users', 3, 0, false],
    ]);
  });

  it('an unchanged match the error touches stays where it is, ahead of nearer-looking copies', async () => {
    const good = await parseCode('a.js', "app.get('/users', h);\na;\nb;\nc;\nx = [app.get('/users', h)];\n", undefined, { patterns: calls });
    // The first call moved below three lines; the second keeps its place, and its missing ] touches it.
    const broken = await parseCode('a.js', "a;\nb;\nc;\napp.get('/users', h);\nx = [app.get('/users', h);\n", good, { patterns: calls });
    expect(broken?.matches?.map((m) => [m.range.start.line, m.range.start.column, m.kept ?? false])).toEqual([
      [4, 0, false],
      [5, 5, false],
    ]);
  });

  it('identical matches moved down together keep their count, with an unrelated error below (Greptile #101)', async () => {
    const good = await parseCode('a.js', "app.get('/users', h);\napp.get('/users', h);\nz;\n", undefined, { patterns: calls });
    const broken = await parseCode('a.js', "\n\n\napp.get('/users', h);\napp.get('/users', h);\nz(;\n", good, { patterns: calls });
    expect(broken?.parseErrors).not.toEqual([]);
    expect(shape(broken)).toEqual([
      ['/users', 4, 0, false],
      ['/users', 5, 0, false],
    ]);
  });

  it('in a language without imports too: a table hidden by an error is kept, one clear of it is read', async () => {
    const tables = await compilePatterns([{ id: 'table', grammar: 'sql', pattern: '(create_table (object_reference name: (identifier) @name)) @entity' }]);
    try {
      const names = (f: Awaited<ReturnType<typeof parseCode>>) => f?.matches?.map((m) => [m.captures.name, m.range.start.line, m.kept ?? false]);
      const good = await parseCode('s.sql', 'CREATE TABLE users (id INT);\nCREATE TABLE orders (id INT);\n', undefined, { patterns: tables });
      const broken = await parseCode('s.sql', 'CREATE TABLE users (id INT);\nCREATE TABLE orders (id INT;\nCREATE TABLE audit (id INT);\n', good, { patterns: tables });
      expect(broken?.parseErrors).not.toEqual([]);
      expect(names(broken)).toEqual([
        ['users', 1, false],
        ['orders', 2, true],
        ['audit', 3, false],
      ]);
      // A new table the error touches is not read.
      const hidden = await parseCode('s.sql', 'CREATE TABLE users (id INT);\nCREATE TABLE orders (id INT);\nCREATE TABLE audit (id INT;\n', good, { patterns: tables });
      expect(names(hidden)).toEqual([
        ['users', 1, false],
        ['orders', 2, false],
      ]);
    } finally {
      tables.delete();
    }
  });
});

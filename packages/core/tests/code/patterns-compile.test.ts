import { describe, expect, it, vi } from 'vitest';
import { parseCode } from '../../src/code/parse.js';
import { checkPattern, compilePatterns } from '../../src/code/patterns.js';

const counter = vi.hoisted(() => ({ queries: 0, deleted: 0 }));

// Counts every tree-sitter query core compiles.
vi.mock('web-tree-sitter', async (importOriginal) => {
  const ts = await importOriginal<typeof import('web-tree-sitter')>();
  class CountingQuery extends ts.Query {
    constructor(...args: ConstructorParameters<typeof ts.Query>) {
      // Stands in for a runtime failure that is not the pattern's fault.
      if (args[1].includes('; runtime failure')) throw new Error('out of memory');
      super(...args);
      counter.queries++;
    }
    override delete(): void {
      counter.deleted++;
      super.delete();
    }
  }
  return { ...ts, Query: CountingQuery };
});

const live = () => counter.queries - counter.deleted;

describe('compilePatterns', () => {
  it('keeps one query per grammar, frees the rest, and delete() frees those', async () => {
    // Load the grammars first: their own queries (symbols, imports) live for the process.
    await parseCode('warm.py', 'pass\n');
    await parseCode('warm.tsx', 'export {};\n');
    const before = live();
    const set = await compilePatterns([
      { id: 'functions', grammar: 'python', pattern: '(function_definition) @entity' },
      { id: 'classes', grammar: 'python', pattern: '(class_definition) @entity' },
      { id: 'components', grammar: 'tsx', pattern: '(jsx_element) @entity' },
    ]);
    expect(live() - before).toBe(2);
    set.delete();
    expect(live()).toBe(before);
  });

  it('a refused set leaves nothing behind', async () => {
    await parseCode('warm.py', 'pass\n');
    const before = live();
    await expect(
      compilePatterns([
        { id: 'ok', grammar: 'python', pattern: '(function_definition) @entity' },
        { id: 'bad', grammar: 'python', pattern: '(identifier) @name' },
      ]),
    ).rejects.toThrow();
    expect(live()).toBe(before);
  });

  it('delete() twice frees each query once', async () => {
    const set = await compilePatterns([{ id: 'f', grammar: 'python', pattern: '(function_definition) @entity' }]);
    const before = counter.deleted;
    set.delete();
    set.delete();
    expect(counter.deleted - before).toBe(1);
  });

  it('checkPattern passes on an error that is not about the pattern', async () => {
    await expect(checkPattern('python', '(identifier) @entity ; runtime failure')).rejects.toThrow('out of memory');
  });

  it('checkPattern frees what it compiles, accepted or not', async () => {
    await parseCode('warm.py', 'pass\n');
    const before = live();
    expect((await checkPattern('python', '(function_definition) @entity')).ok).toBe(true);
    expect((await checkPattern('python', '(function_definition) @name')).ok).toBe(false);
    expect(live()).toBe(before);
  });

  it('compiles once; parsing files runs the compiled queries without compiling again', async () => {
    const set = await compilePatterns([
      { id: 'functions', grammar: 'python', pattern: '(function_definition) @entity' },
      { id: 'classes', grammar: 'python', pattern: '(class_definition) @entity' },
      { id: 'components', grammar: 'tsx', pattern: '(jsx_element) @entity' },
    ]);
    // Load the grammars' own queries (symbols, imports) first, so only pattern compiles could show below.
    await parseCode('warm.py', 'pass\n');
    await parseCode('warm.tsx', 'export {};\n');
    const before = counter.queries;
    for (let i = 0; i < 5; i++) {
      expect((await parseCode(`m${i}.py`, `def f${i}(): pass\nclass C${i}: pass\n`, undefined, { patterns: set }))?.matches).toHaveLength(2);
      expect((await parseCode(`c${i}.tsx`, `const a = <p>${i}</p>;\n`, undefined, { patterns: set }))?.matches).toHaveLength(1);
    }
    expect(counter.queries).toBe(before);
    set.delete();
  });
});

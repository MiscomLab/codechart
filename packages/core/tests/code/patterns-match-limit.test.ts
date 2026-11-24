import { expect, it } from 'vitest';
import { parseCode } from '../../src/code/parse.js';
import { compilePatterns } from '../../src/code/patterns.js';

// Its own file, so its own process: web-tree-sitter runs every query on one cursor per process, whose pool of
// in-progress matches never shrinks, so a match limit only bites once a query needs more than any earlier one did.
it('marks a file where in-progress matches passed the match limit', async () => {
  const text = Array.from({ length: 10 }, (_, i) => `const a${i} = [${Array.from({ length: 30 }, (_, j) => j).join(', ')}];`).join('\n');
  // Each declaration starts a match that stays open while later siblings are tried: 10 at once on 10 lines.
  const set = await compilePatterns([{ id: 'pairs', grammar: 'typescript', pattern: '(program (lexical_declaration) @entity (lexical_declaration) @other)' }], { matchLimit: 2 });
  try {
    const parsed = await parseCode('big.ts', text, undefined, { patterns: set });
    expect(parsed?.patternLimits).toStrictEqual({ patterns: 'match-limit' });
  } finally {
    set.delete();
  }
});

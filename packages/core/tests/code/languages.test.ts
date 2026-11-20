import { describe, expect, it } from 'vitest';
import { grammarOf, langOf } from '../../src/code/languages.js';

describe('langOf and grammarOf', () => {
  it.each([
    ['a.ts', 'typescript', 'typescript'],
    ['a.mts', 'typescript', 'typescript'],
    ['a.cts', 'typescript', 'typescript'],
    ['a.d.ts', 'typescript', 'typescript'],
    ['A.TSX', 'typescript', 'tsx'],
    ['a.js', 'javascript', 'javascript'],
    ['a.mjs', 'javascript', 'javascript'],
    ['a.cjs', 'javascript', 'javascript'],
    ['a.jsx', 'javascript', 'javascript'],
    ['a.PY', 'python', undefined],
    ['x.pyi', 'python', undefined],
    ['ci.yml', 'yaml', undefined],
    ['deploy.sh', 'bash', undefined],
  ])('%s is %s, parsed with %s', (path, lang, grammar) => {
    expect([langOf(path), grammarOf(path)]).toEqual([lang, grammar]);
  });

  it.each(['Makefile', '.ts', 'src/.js', '.eslintrc', 'a.d.ts.map', 'dir.ts/file'])('skips %s', (path) => {
    expect([langOf(path), grammarOf(path)]).toEqual([undefined, undefined]);
  });
});

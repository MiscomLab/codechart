import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../../../src/code/resolve/jsonc.js';

describe('parseJsonc', () => {
  it('drops line and block comments and trailing commas, also one followed by a comment', () => {
    const text = '\uFEFF{\n  // note\n  "a": [1, 2,], /* x */\n  "b": { "c": true, }, // end\n}';
    expect(parseJsonc(text)).toEqual({ a: [1, 2], b: { c: true } });
  });

  it('keeps comment markers and commas inside strings', () => {
    expect(parseJsonc('{ "url": "http://x/*y*/", "s": ",}", "q": "a\\"//b" }')).toEqual({ url: 'http://x/*y*/', s: ',}', q: 'a"//b' });
  });

  it('gives undefined for text that is not JSON', () => {
    expect([parseJsonc('{ a: 1 }'), parseJsonc(''), parseJsonc('{ "a": 1 /* open')]).toEqual([undefined, undefined, undefined]);
  });
});

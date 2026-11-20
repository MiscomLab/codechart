import { describe, expect, it } from 'vitest';
import { parseCode } from '../../src/code/parse.js';
import type { CodeSymbol } from '../../src/code/model.js';

const parse = async (text: string, lastGood?: CodeSymbol[]) => (await parseCode('a.ts', text, lastGood))!;
const ids = (symbols: CodeSymbol[]) => symbols.map((s) => s.path.join('.'));

const GOOD = ['function a() {', '  return 1;', '}', '', 'class B {', '  m() {}', '}', '', 'function c() {}', ''].join('\n');

describe('parseCode on broken code (Live map #11)', () => {
  it('reports where the syntax breaks', async () => {
    const { parseErrors } = await parse(GOOD.replace('return 1;', 'return 1 +;'));
    expect(parseErrors.length).toBeGreaterThan(0);
    expect(parseErrors[0]!.start.line).toBe(2);
  });

  it('keeps the last good symbols a missing brace swallows, and makes none from broken text', async () => {
    const good = await parse(GOOD);
    const broken = await parse(GOOD.replace('  return 1;\n}', '  return 1;'), good.symbols);
    // Without the brace, B and c would read as a.B and a.c.
    expect(ids(broken.symbols).sort()).toEqual(['B', 'B.m', 'a', 'c']);
    expect(broken.kept.sort()).toEqual(['a.ts::B.m::method', 'a.ts::B::class', 'a.ts::c::function']);
    const keptC = broken.symbols.find((s) => s.id === 'a.ts::c::function');
    expect(keptC).toEqual(good.symbols.find((s) => s.id === 'a.ts::c::function'));
  });

  it('updates symbols outside the broken region', async () => {
    const good = await parse(GOOD);
    const edited = GOOD.replace('function c() {}', '\n\nfunction c() {}\nfunction d() {}').replace('m() {}', 'm() { if ( }');
    const broken = await parse(edited, good.symbols);
    expect(broken.symbols.find((s) => s.path.join('.') === 'c')!.range.start.line).toBe(11);
    expect(ids(broken.symbols)).toContain('d');
    expect(ids(broken.symbols)).toEqual(expect.arrayContaining(['a', 'B', 'B.m', 'c']));
  });

  it('drops symbols from broken text when there is no last good parse', async () => {
    const first = await parse(GOOD.replace('  return 1;\n}', '  return 1;'));
    expect(ids(first.symbols)).not.toContain('a.B');
    expect(ids(first.symbols)).not.toContain('a.c');
    expect(first.kept).toEqual([]);
  });

  it('clears kept symbols once the file parses again', async () => {
    const good = await parse(GOOD);
    const broken = await parse(GOOD.replace('  return 1;\n}', '  return 1;'), good.symbols);
    const fixed = await parse(GOOD, broken.symbols);
    expect([fixed.kept, fixed.parseErrors]).toEqual([[], []]);
    expect(fixed.symbols).toEqual(good.symbols);
  });
});

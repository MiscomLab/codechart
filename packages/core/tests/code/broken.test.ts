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
    expect(parseErrors.every((e) => e.start.line >= 1 && e.start.line <= 3)).toBe(true);
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
    // The missing brace is a MISSING node at the end of a, which then holds every later definition.
    const first = await parse(GOOD.replace('  return 1;\n}', '  return 1;'));
    expect([first.symbols, first.kept]).toEqual([[], []]);
  });

  it('drops a broken definition and its children, keeps the rest', async () => {
    const { symbols } = await parse('class C {\n  m() { if ( }\n}\nfunction q() {}\n');
    expect(ids(symbols)).toEqual(['q']);
  });

  it('keeps a broken definition the last good parse had, with its new range and not as kept', async () => {
    const good = await parse(GOOD);
    const broken = await parse(GOOD.replace('function c() {}', '').replace('m() {}', 'm() { if ( }'), good.symbols);
    expect(ids(broken.symbols)).toEqual(['a', 'B', 'B.m', 'c']);
    expect(broken.symbols.find((s) => s.id === 'a.ts::B.m::method')!.range.end.line).toBe(6);
    // c was deleted in clean text, but a syntax error anywhere keeps it until the file parses (removed at settle).
    expect(broken.kept).toEqual(['a.ts::c::function']);
  });

  it('clears kept symbols once the file parses again', async () => {
    const good = await parse(GOOD);
    const broken = await parse(GOOD.replace('  return 1;\n}', '  return 1;'), good.symbols);
    const fixed = await parse(GOOD, broken.symbols);
    expect([fixed.kept, fixed.parseErrors]).toEqual([[], []]);
    expect(fixed.symbols).toEqual(good.symbols);
  });
});

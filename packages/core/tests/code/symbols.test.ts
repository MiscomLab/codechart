import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeSymbolSchema, fileInfoSchema } from '../../src/code/model.js';
import { parseCode } from '../../src/code/parse.js';

const APP = join(import.meta.dirname, '..', 'fixtures', 'code', 'ts-app');
const fixture = (path: string) => readFileSync(join(APP, path), 'utf8');
const parse = async (path: string, text = fixture(path)) => (await parseCode(path, text))!;
const outline = async (path: string, text?: string) => (await parse(path, text)).symbols.map((s) => `${s.path.join('.')} ${s.kind} ${s.range.start.line}-${s.range.end.line}`);

describe('parseCode symbols', () => {
  it('reads definitions with their path, kind and lines', async () => {
    expect(await outline('src/payments/service.ts')).toEqual([
      'Currency type 1-1',
      'Status enum 3-6',
      'Receipt interface 8-11',
      'PaymentService class 13-19',
      'PaymentService.charge method 14-16',
      'PaymentService.refund method 18-18',
      'format function 21-26',
      'format.pad function 24-24',
    ]);
  });

  it('identifies a symbol by file, path and kind', async () => {
    const { symbols } = await parse('src/payments/service.ts');
    expect(symbols.find((s) => s.path.join('.') === 'PaymentService.charge')).toMatchObject({
      id: 'src/payments/service.ts::PaymentService.charge::method',
      file: 'src/payments/service.ts',
      range: { start: { line: 14, column: 2 }, end: { line: 16, column: 3 } },
    });
    for (const s of symbols) codeSymbolSchema.parse(s);
  });

  it('keeps an identity when lines above it change', async () => {
    const before = await parse('src/payments/service.ts');
    const after = await parse('src/payments/service.ts', `// a new comment\n\n${fixture('src/payments/service.ts')}`);
    expect(after.symbols.map((s) => s.id)).toEqual(before.symbols.map((s) => s.id));
    expect(after.symbols[0]!.range.start.line).toBe(3);
  });

  it('numbers a repeated identity in source order', async () => {
    const text = 'function f() {\n  const a = { go: () => 1 };\n  const b = { go: () => 2 };\n}\n';
    expect((await parse('x.ts', text)).symbols.map((s) => s.id)).toEqual(['x.ts::f::function', 'x.ts::f.go::function', 'x.ts::f.go::function~2']);
  });

  it('merges overload signatures only within one scope', async () => {
    const modules = "declare module 'a' {\n  export function setup(): void;\n}\nconst z = 1;\ndeclare module 'b' {\n  export function setup(): void;\n}\n";
    expect(await outline('x.d.ts', modules)).toEqual(['setup function 2-2', 'setup function 6-6']);
    expect((await parse('x.d.ts', modules)).symbols.map((s) => s.id)).toEqual(['x.d.ts::setup::function', 'x.d.ts::setup::function~2']);
    const interfaces = 'interface I {\n  m(): void;\n}\nfunction g() {}\ninterface I {\n  m(): void;\n}\n';
    expect(await outline('y.ts', interfaces)).toEqual(['I interface 1-3', 'I.m method 2-2', 'g function 4-4', 'I interface 5-7', 'I.m method 6-6']);
  });

  it('merges each later group of overloads too', async () => {
    const text = 'interface I {\n  m(a: string): void;\n  m(a: number): void;\n}\ninterface I {\n  m(a: string): void;\n  m(a: number): void;\n}\n';
    expect((await parse('z.ts', text)).symbols.map((s) => `${s.id} ${s.range.start.line}-${s.range.end.line}`)).toEqual([
      'z.ts::I::interface 1-4',
      'z.ts::I.m::method 2-3',
      'z.ts::I::interface~2 5-8',
      'z.ts::I.m::method~2 6-7',
    ]);
  });

  it('merges ambient overloads, which declare wraps one by one', async () => {
    const text = 'declare function f(): void;\ndeclare function f(a: string): void;\nexport declare function g(): void;\nexport declare function g(a: string): void;\n';
    expect(await outline('x.d.ts', text)).toEqual(['f function 1-2', 'g function 3-4']);
  });

  it('reads namespaces, dotted ones as nested', async () => {
    const text = 'namespace A {\n  export function f() {}\n}\nnamespace B.C {\n  export function g() {}\n}\n';
    expect(await outline('n.ts', text)).toEqual(['A module 1-3', 'A.f function 2-2', 'B.C module 4-6', 'B.C.g function 5-5']);
  });

  it('reads private arrow-function fields', async () => {
    const text = 'class K {\n  #p = () => 1;\n}\n';
    expect(await outline('k.ts', text)).toEqual(['K class 1-3', 'K.#p method 2-2']);
    expect(await outline('k.js', text)).toEqual(['K class 1-3', 'K.#p method 2-2']);
  });

  it('parses TSX and JavaScript with JSX', async () => {
    expect(await outline('src/ui/Button.tsx')).toEqual(['Button function 1-3']);
    expect(await outline('src/legacy/util.js')).toEqual(['legacy function 1-3', 'helper function 7-9']);
    expect(await outline('a.jsx', 'class A {\n  render = () => <div />;\n}\n')).toEqual(['A class 1-3', 'A.render method 2-2']);
  });

  it('describes the file and hashes its text', async () => {
    const text = fixture('src/ui/Button.tsx');
    const { file, parseErrors, kept } = await parse('src/ui/Button.tsx');
    expect(file).toEqual({ path: 'src/ui/Button.tsx', lang: 'typescript', hash: createHash('sha256').update(text).digest('hex') });
    fileInfoSchema.parse(file);
    expect([parseErrors, kept]).toEqual([[], []]);
  });

  it('lists a v1 file without a symbol grammar yet, and skips other files', async () => {
    const py = await parse('src/app.py');
    expect([py.file.lang, py.symbols]).toEqual(['python', []]);
    expect(await parseCode('README.md', 'hi')).toBeUndefined();
  });
});

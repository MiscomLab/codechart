import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeSymbolSchema } from '../../src/code/model.js';
import { parseCode } from '../../src/code/parse.js';

const PY = join(import.meta.dirname, '..', 'fixtures', 'code', 'py-src');
const fixture = (path: string) => readFileSync(join(PY, path), 'utf8');
const parse = async (path: string, text = fixture(path)) => (await parseCode(path, text))!;
const outline = async (path: string, text?: string) => (await parse(path, text)).symbols.map((s) => `${s.path.join('.')} ${s.kind}`);

/** Each symbol as `path kind`, with the source line its range starts on. */
async function located(path: string, text = fixture(path)): Promise<string[]> {
  const source = text.split('\n');
  return (await parse(path, text)).symbols.map((s) => `${s.path.join('.')} ${s.kind}: ${source[s.range.start.line - 1]!.trim()}`);
}

describe('parseCode on Python', () => {
  it('reads functions, classes, methods and module constants, each from its own line', async () => {
    expect(await outline('src/shop/billing.py')).toEqual([
      'RATE constant',
      'PaymentService class',
      'PaymentService.__init__ method',
      'PaymentService.charge method',
      'PaymentService.refund method',
      'PaymentService._format method',
      'charge function',
      'helper function',
    ]);
    expect(await located('src/shop/billing.py')).toEqual([
      'RATE constant: RATE = 0.2',
      'PaymentService class: class PaymentService:',
      'PaymentService.__init__ method: def __init__(self, name: str) -> None:',
      'PaymentService.charge method: def charge(self, amount: float) -> str:',
      'PaymentService.refund method: def refund(self, amount: float) -> str:',
      'PaymentService._format method: def _format(self, amount: float) -> str:',
      'charge function: def charge(amount: float) -> str:',
      'helper function: def helper() -> str:',
    ]);
    for (const s of (await parse('src/shop/billing.py')).symbols) codeSymbolSchema.parse(s);
  });

  it('gives a file its python language and hash, and a decorated method its class path', async () => {
    const text = 'class A:\n    @property\n    def size(self):\n        return 1\n\n    async def load(self):\n        pass\n';
    const parsed = await parse('x.py', text);
    expect(parsed.file).toEqual({ path: 'x.py', lang: 'python', hash: createHash('sha256').update(text).digest('hex') });
    expect(parsed.symbols.map((s) => [s.path.join('.'), s.kind])).toEqual([
      ['A', 'class'],
      ['A.size', 'method'],
      ['A.load', 'method'],
    ]);
    // Decorators are not a call site of the method: the range starts at its `def`.
    expect(parsed.symbols[1]!.range.start.line).toBe(3);
  });

  it("keeps a stub file's signatures as symbols", async () => {
    expect(await outline('x.pyi', 'class A:\n    def run(self, a: int) -> str: ...\n\ndef go() -> None: ...\n')).toEqual([
      'A class',
      'A.run method',
      'go function',
    ]);
  });

  it('marks a symbol in broken text as parse errors, and keeps the last good parse', async () => {
    const good = await parse('src/shop/billing.py');
    const broken = await parseCode('src/shop/billing.py', 'from .billing import charge\ndef broken(:\n', good);
    expect(broken!.parseErrors.length).toBeGreaterThan(0);
    expect(broken!.kept).toContain('src/shop/billing.py::PaymentService::class');
  });

  it('reads calls in methods, functions and nested scopes, with the caller each belongs to', async () => {
    const parsed = await parse('src/shop/app.py');
    expect(parsed.calls.map((c) => [c.name, c.via, c.from])).toEqual([
      ['allow', 'bare', 'src/shop/app.py::run::function'],
      ['charge', 'member', 'src/shop/app.py::run::function'],
      ['PaymentService', 'bare', 'src/shop/app.py::run_service::function'],
      ['charge', 'member', 'src/shop/app.py::run_service::function'],
      ['make_slug', 'bare', 'src/shop/app.py::run_slug::function'],
    ]);
    const refund = await parse('src/shop/billing.py');
    expect(refund.calls.filter((c) => c.from === 'src/shop/billing.py::PaymentService.refund::method').map((c) => [c.name, c.via])).toEqual([
      ['charge', 'this'],
      ['_format', 'this'],
    ]);
  });
});

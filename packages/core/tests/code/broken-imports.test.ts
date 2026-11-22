import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

const GOOD = "import { pay } from './b';\nexport function run() {\n  pay();\n}\n";

const parse = async (text: string, lastGood?: ParsedFile) => (await parseCode('a.ts', text, lastGood))!;

describe('last good imports on broken code (COD-42 follow-up)', () => {
  it('keeps an import whose own statement is broken while the specifier is still in the file', async () => {
    const good = await parse(GOOD);
    const broken = await parse("import { pay } from './b;\nexport function run() {\n  pay();\n}\n", good);
    expect(broken.parseErrors.length).toBeGreaterThan(0);
    expect(broken.imports.map((i) => [i.spec, i.status, i.names])).toEqual([['./b', 'unknown', [{ imported: 'pay', local: 'pay' }]]]);
    expect(broken.exports.names).toEqual([{ name: 'run' }]);
  });

  it('keeps an import swallowed by a missing brace, and the exports the broken text hides', async () => {
    const good = await parse("function run() { pay(); }\nimport { pay } from './b';\nexport function kept() {}\n");
    const broken = await parse("function run() { pay();\nimport { pay } from './b';\nexport function kept() {}\n", good);
    expect(broken.parseErrors.length).toBeGreaterThan(0);
    expect(broken.imports.map((i) => i.spec)).toEqual(['./b']);
    expect(broken.exports.names.map((n) => n.name)).toContain('kept');
  });

  it('does not resurrect an import that was deleted from clean text', async () => {
    const good = await parse(GOOD);
    const broken = await parse('export function run() {\n  pay();\n}\nconst x = ;\n', good);
    expect(broken.imports).toEqual([]);
    expect(broken.parseErrors.length).toBeGreaterThan(0);
  });

  it('stays linked while the import is broken, then parses clean again', async () => {
    const good = await parse(GOOD);
    const tree = { 'a.ts': GOOD, 'b.ts': 'export function pay() {}\n' };
    const brokenText = "import { pay } from './b;\nexport function run() {\n  pay();\n}\n";
    const [broken] = linkCode([(await parseCode('a.ts', brokenText, good))!, (await parseCode('b.ts', tree['b.ts']))!], createResolver(Object.keys(tree), (p) => tree[p as keyof typeof tree]));
    expect(broken!.imports[0]).toMatchObject({ status: 'resolved', resolved: 'b.ts', names: [{ imported: 'pay', local: 'pay', definedIn: 'b.ts' }] });
    expect(broken!.calls[0]).toMatchObject({ name: 'pay', to: 'b.ts::pay::function', evidence: 'resolved' });

    const fixed = await parse(GOOD, broken);
    expect([fixed.parseErrors, fixed.kept]).toEqual([[], []]);
    expect(fixed.imports.map((i) => i.spec)).toEqual(['./b']);
  });
});

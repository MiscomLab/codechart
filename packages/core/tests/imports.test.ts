import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCode } from '../src/code/parse.js';

const CORE = resolve('packages/core/src');
const ALLOWED = new Set(['elkjs', 'picomatch', 'web-tree-sitter', 'yaml', 'zod']);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

const specifiers = async (file: string): Promise<string[]> => (await parseCode(file, readFileSync(file, 'utf8')))!.imports.map((i) => i.spec);

describe('@codechart/core independence', () => {
  it('imports no CLI module or commander', async () => {
    const bad: string[] = [];
    for (const file of walk(CORE)) {
      for (const spec of await specifiers(file)) {
        if (spec === 'commander' || spec.includes('@codechart/cli') || spec.includes('packages/cli')) bad.push(`${relative(CORE, file)}: ${spec}`);
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
          if (relative(CORE, target).startsWith('..')) bad.push(`${relative(CORE, file)}: escapes core via ${spec}`);
        } else if (!spec.startsWith('node:') && !ALLOWED.has(spec) && !spec.startsWith('elkjs/')) {
          bad.push(`${relative(CORE, file)}: unexpected ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('declares only runtime dependencies core imports', () => {
    const pkg = JSON.parse(readFileSync('packages/core/package.json', 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([...ALLOWED].sort());
  });
});

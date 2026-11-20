import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defineConfig } from 'tsup';
import { GRAMMAR_ASSETS } from './src/code/grammar-assets.js';

const require = createRequire(import.meta.url);

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  clean: true,
  splitting: false,
  dts: true,
  onSuccess: async () => {
    const dir = join(import.meta.dirname, 'dist', 'grammars');
    mkdirSync(dir, { recursive: true });
    for (const [name, from] of Object.entries(GRAMMAR_ASSETS)) copyFileSync(require.resolve(from), join(dir, name));
  },
});

import { defineConfig } from 'tsup';

const common = { format: ['esm' as const], target: 'node22', splitting: false, banner: { js: '#!/usr/bin/env node' } };

// The package ships exactly dist/cli.js and dist/server.js (scripts/check-pack.mjs).
export default defineConfig([
  { ...common, entry: { cli: 'src/cli.ts' }, clean: true, external: ['@codechart/core'] },
  // install-skill copies server.js alone into the OpenCode plugin folder, so core must be inlined.
  { ...common, entry: { server: 'src/opencode/server.ts' }, noExternal: ['@codechart/core'] },
]);

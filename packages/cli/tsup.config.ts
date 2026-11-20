import { defineConfig } from 'tsup';

const common = { format: ['esm' as const], target: 'node22', splitting: false, banner: { js: '#!/usr/bin/env node' } };

// The package ships exactly dist/cli.js and dist/server.js (scripts/check-pack.mjs).
export default defineConfig([
  // tsup runs both builds at once; this clean must not delete the server build's output.
  { ...common, entry: { cli: 'src/cli.ts' }, clean: ['!server.js'], external: ['@codechart/core'] },
  // install-skill copies server.js alone into the OpenCode plugin folder, so core must be inlined.
  { ...common, entry: { server: 'src/opencode/server.ts' }, noExternal: ['@codechart/core'] },
]);

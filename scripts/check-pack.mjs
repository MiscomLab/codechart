import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED = [
  /^dist\/(cli|server)\.js$/,
  /^skills\/codechart\/[^/]+\.md$/,
  /^templates\/.+/,
  /^config\.schema\.json$/,
  /^package\.json$/,
  /^LICENSE$/,
  /^README\.md$/,
  /^THIRD_PARTY_NOTICES\.md$/,
];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cwd = join(import.meta.dirname, '..', 'packages', 'cli');
execFileSync(process.execPath, [join(import.meta.dirname, 'pack-readme.mjs')]);
const out = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', shell: process.platform === 'win32', cwd });
const files = JSON.parse(out)[0].files.map((f) => f.path);
const unexpected = files.filter((f) => !ALLOWED.some((re) => re.test(f)));
const missing = ['dist/cli.js', 'dist/server.js', 'config.schema.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'skills/codechart/SKILL.md', 'skills/codechart/flow-guide.md', 'skills/codechart/spec-guide.md', 'skills/codechart/business-guide.md', 'skills/codechart/release-guide.md', 'skills/codechart/explain-guide.md', 'templates/codechart.yaml'].filter((f) => !files.includes(f));
const problems = [];
if (unexpected.length || missing.length) problems.push(`unexpected: ${unexpected.join(', ') || '-'}\nmissing: ${missing.join(', ') || '-'}`);

// install-skill copies server.js alone into the OpenCode plugin folder, so it may import only node built-ins.
const server = join(cwd, 'dist', 'server.js');
const builtins = new Set(builtinModules);
const imported = [...readFileSync(server, 'utf8').matchAll(/^(?:import|export)\b[^'"\n]*?['"]([^'"]+)['"];?$|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => m[1] ?? m[2] ?? m[3]);
const foreign = [...new Set(imported)].filter((s) => !(s.startsWith('node:') || builtins.has(s)));
if (foreign.length) problems.push(`dist/server.js imports non-built-ins: ${foreign.join(', ')}`);
const plugins = mkdtempSync(join(tmpdir(), 'codechart-plugin-'));
try {
  copyFileSync(server, join(plugins, 'codechart.js'));
  await import(pathToFileURL(join(plugins, 'codechart.js')).href);
} catch (e) {
  problems.push(`dist/server.js does not load on its own: ${e.message}`);
} finally {
  rmSync(plugins, { recursive: true, force: true });
}

const readme = readFileSync(join(cwd, 'README.md'), 'utf8');
if (!readme.includes('## Why you can trust the diagram')) problems.push('packed README is not the full README');
const relative = [...readme.matchAll(/\]\(([^)\s]+)|\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? m[2]).filter((u) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u));
if (relative.length) problems.push(`packed README has relative links: ${relative.join(', ')}`);

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`pack ok: ${files.length} files`);

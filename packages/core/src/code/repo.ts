import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { readRegularFile } from '../read-regular.js';
import { git } from '../rules/git-run.js';
import { langOf } from './languages.js';
import { parseCode, type ParsedFile } from './parse.js';
import type { PatternSets } from './patterns.js';
import { linkCode } from './resolve/link.js';
import { createResolver } from './resolve/resolver.js';

/** Dependencies, build output and minified bundles: never source a map should point at. */
export const DEFAULT_CODE_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.turbo/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/*.min.js',
  '**/*.min.css',
];

/** Larger files are generated or data, and would stall the live view. */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Repo-relative paths of the files the code layer reads: tracked and untracked files git does not ignore
 * (`.gitignore`, `.git/info/exclude`, the global excludes file), in a v1 language, outside `DEFAULT_CODE_IGNORE` and `ignore`
 * (the config's `ignore`).
 */
export function listCodeFiles(root: string, ignore: readonly string[] = []): string[] {
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const ignored = picomatch([...DEFAULT_CODE_IGNORE, ...ignore], { dot: true });
  return [...new Set(out.split('\0'))].filter((p) => p && langOf(p) && !ignored(p)).sort();
}

/** Reads a repo file as text; undefined when it is gone, not a regular file, too large or binary. */
export function readCodeFile(root: string, path: string): string | undefined {
  let text: string | undefined;
  try {
    const full = join(root, path);
    // lstat: Windows has no O_NOFOLLOW, so the open alone follows a symlink.
    text = readRegularFile(full, (st) => st.isFile() && st.size <= MAX_FILE_BYTES && lstatSync(full).isFile());
  } catch {
    // Deleted since git listed it, or a symlink, which O_NOFOLLOW refuses.
    return undefined;
  }
  return text?.includes('\0') ? undefined : text;
}

/**
 * The code layer of the repo at `root`, one entry per readable file of `listCodeFiles`, imports and calls resolved;
 * with `patterns`, each file's pattern `matches` too.
 */
export async function parseRepo(root: string, opts: { ignore?: readonly string[]; patterns?: PatternSets } = {}): Promise<ParsedFile[]> {
  const paths = listCodeFiles(root, opts.ignore);
  return linkCode(await parseFiles(root, paths, opts.patterns), createResolver(paths, (path) => readCodeFile(root, path)));
}

/** Each readable file of `paths` parsed on its own, unlinked, in order. */
export async function parseFiles(root: string, paths: readonly string[], patterns: PatternSets | undefined): Promise<ParsedFile[]> {
  const parsed: ParsedFile[] = [];
  for (const path of paths) {
    const text = readCodeFile(root, path);
    const file = text === undefined ? undefined : await parseCode(path, text, undefined, { patterns });
    if (file) parsed.push(file);
  }
  return parsed;
}

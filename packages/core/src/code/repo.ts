import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { readRegularFile } from '../read-regular.js';
import { git } from '../rules/git-run.js';
import { langOf } from './languages.js';
import { parseCode, type ParsedFile } from './parse.js';
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

/** The code layer of the repo at `root`, one entry per readable file of `listCodeFiles`, imports and calls resolved. */
export async function parseRepo(root: string, opts: { ignore?: readonly string[] } = {}): Promise<ParsedFile[]> {
  const paths = listCodeFiles(root, opts.ignore);
  const parsed: ParsedFile[] = [];
  for (const path of paths) {
    const text = readCodeFile(root, path);
    const file = text === undefined ? undefined : await parseCode(path, text);
    if (file) parsed.push(file);
  }
  // A Python project's declared dependencies live in files the code layer does not parse; resolution still reads them.
  return linkCode(parsed, createResolver(paths, (path) => readCodeFile(root, path)));
}

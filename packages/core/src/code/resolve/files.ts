import { posix } from 'node:path';

/** Repo-relative paths with `/`, as `listCodeFiles` gives them. */
export type FileSet = ReadonlySet<string>;

export const dirOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
};

/** The repo path `rel` names from repo directory `dir` (`''` is the root); undefined when it leaves the repo. */
export function joinRepo(dir: string, rel: string): string | undefined {
  if (rel.startsWith('/')) return undefined;
  const path = posix.normalize(posix.join(dir || '.', rel)).replace(/\/$/, '');
  if (path === '..' || path.startsWith('../')) return undefined;
  return path === '.' ? '' : path;
}

export const isRelative = (spec: string): boolean => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');

export const isJsFile = (path: string): boolean => /\.[mc]?jsx?$/.test(path);

// TypeScript's order for a TS importer, except that the JavaScript a `.d.ts` describes wins: its code is what runs.
// A JS importer looks for JavaScript first, as Node and bundlers run it.
const TS_ORDER = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.json'];
const JS_ORDER = ['.js', '.jsx', '.json', '.ts', '.tsx', '.d.ts'];
/** ESM TypeScript names the emitted file: `./x.js` means `x.ts` when that exists. */
const EMITTED: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * The file `path` (a repo path from a specifier) loads, trying extensions and `index` files; undefined when none is in `files`.
 * A JS importer naming an existing `.js` file gets it, since that file is what runs.
 */
export function resolveFile(files: FileSet, path: string, fromJs: boolean): string | undefined {
  const ext = posix.extname(path);
  const sources = EMITTED[ext];
  if (sources && !(fromJs && files.has(path))) {
    const stem = path.slice(0, -ext.length);
    const source = sources.map((s) => stem + s).find((p) => files.has(p));
    if (source) return source;
  }
  if (files.has(path)) return path;
  if (sources) {
    const declaration = `${path.slice(0, -ext.length)}.d${ext.replace('js', 'ts')}`;
    if (files.has(declaration)) return declaration;
  }
  const order = fromJs ? JS_ORDER : TS_ORDER;
  const prefix = path ? `${path}/` : '';
  return order.map((e) => path + e).find((p) => files.has(p)) ?? order.map((e) => `${prefix}index${e}`).find((p) => files.has(p));
}

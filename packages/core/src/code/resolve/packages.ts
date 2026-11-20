import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { dirOf, joinRepo, resolveFile, type FileSet } from './files.js';
import { mapTargets, type LoadKind, type PackageJson } from './package-json.js';

/** Leading folders build tools write to; `dist/esm/x.js` is looked for as `src/x.*` or `x.*`. */
const BUILD_DIRS = new Set(['dist', 'build', 'lib', 'out', 'esm', 'cjs', 'mjs', 'es', 'umd', 'types', 'typings']);
const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const BUILT_EXT = /(\.d)?\.[mc]?[jt]sx?$/;

/**
 * Where a build output path missing from the repo comes from: the one source file at the same path under `src/` or
 * the package root, build folders and extension dropped. Undefined when there is none, null when there are several.
 */
function sourceOf(files: FileSet, dir: string, rel: string): string | null | undefined {
  const segments = rel.split('/');
  let skip = 0;
  while (skip < segments.length - 1 && BUILD_DIRS.has(segments[skip]!)) skip++;
  if (!skip) return undefined;
  const stem = segments.slice(skip).join('/').replace(BUILT_EXT, '');
  const prefix = dir ? `${dir}/` : '';
  const found = new Set([`${prefix}src/${stem}`, `${prefix}${stem}`].flatMap((base) => SOURCE_EXTS.map((e) => base + e).filter((p) => files.has(p))));
  return found.size > 1 ? null : [...found][0];
}

/**
 * The repo file a package-relative target (`./dist/index.js`) stands for, mapping build output back to source;
 * null when several source files could be it. `fromJs` as in `resolveFile`: a JS importer gets the `.js` that runs.
 */
export function inPackage(files: FileSet, dir: string, target: string, fromJs: boolean): string | null | undefined {
  const path = joinRepo(dir, target);
  if (path === undefined || (dir && path !== dir && !path.startsWith(`${dir}/`))) return undefined;
  const direct = resolveFile(files, path, fromJs);
  if (direct) return direct;
  return sourceOf(files, dir, dir ? path.slice(dir.length + 1) : path);
}

/** How the importer loads: `require()` or not picks conditions, a JS importer gets the `.js` an entry names. */
export interface Importer {
  load: LoadKind;
  fromJs: boolean;
}

/**
 * The file a workspace package's `subpath` (`.` or `./x`) is, by `exports`, else by its entry fields or the path itself.
 * A target several source files could be stops the search: a later fallback would be a guess.
 */
export function packageEntry(files: FileSet, dir: string, pkg: PackageJson, subpath: string, importer: Importer): string | undefined {
  const candidates =
    pkg.exports !== undefined ? mapTargets(pkg.exports, subpath, importer.load).filter((t) => t.startsWith('./')) : subpath === '.' ? [...pkg.entries, './index'] : [subpath];
  for (const target of candidates) {
    const file = inPackage(files, dir, target.startsWith('.') ? target : `./${target}`, importer.fromJs);
    if (file !== undefined) return file ?? undefined;
  }
  return undefined;
}

/** Splits `@scope/name/sub` into the package name and its `exports` subpath. */
export function splitPackageSpec(spec: string): { name: string; subpath: string } {
  const parts = spec.split('/');
  const size = spec.startsWith('@') ? 2 : 1;
  const rest = parts.slice(size).join('/');
  return { name: parts.slice(0, size).join('/'), subpath: rest ? `./${rest}` : '.' };
}

function workspaceGlobs(root: PackageJson | undefined, pnpmYaml: string | undefined): string[] {
  let pnpm: string[] = [];
  try {
    const doc: unknown = pnpmYaml ? parseYaml(pnpmYaml) : undefined;
    const list = doc && typeof doc === 'object' ? (doc as { packages?: unknown }).packages : undefined;
    pnpm = Array.isArray(list) ? list.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    // An unreadable pnpm-workspace.yaml declares nothing; its packages then resolve as unknown or external.
  }
  return [...(root?.workspaces ?? []), ...pnpm].map((g) => g.replace(/^\.\//, '').replace(/\/+$/, ''));
}

/**
 * Package name → folder of each npm, yarn or pnpm workspace package of the root. A name two folders claim maps to
 * undefined, so imports of it stay unknown.
 */
export function workspacePackages(files: FileSet, readPackage: (dir: string) => PackageJson | undefined, readText: (path: string) => string | undefined): Map<string, string | undefined> {
  const globs = workspaceGlobs(readPackage(''), files.has('pnpm-workspace.yaml') ? readText('pnpm-workspace.yaml') : undefined);
  const out = new Map<string, string | undefined>();
  const include = globs.filter((g) => !g.startsWith('!'));
  if (!include.length) return out;
  const matches = picomatch(include);
  const negated = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  const excluded = negated.length ? picomatch(negated) : () => false;
  for (const path of files) {
    if (!path.endsWith('/package.json')) continue;
    const dir = dirOf(path);
    const name = matches(dir) && !excluded(dir) ? readPackage(dir)?.name : undefined;
    if (name) out.set(name, out.has(name) ? undefined : dir);
  }
  return out;
}

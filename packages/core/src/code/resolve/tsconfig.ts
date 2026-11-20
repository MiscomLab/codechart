import { dirOf, isRelative, joinRepo, resolveFile, type FileSet } from './files.js';
import { parseJsonc } from './jsonc.js';
import { mapTargets, type PackageJson } from './package-json.js';
import { splitPackageSpec } from './packages.js';

/** The module options of a tsconfig, its `extends` chain merged in. Directories are repo paths. */
export interface TsOptions {
  /** null when set to a folder outside the repo: lookups from it prove nothing. */
  baseUrl?: string | null;
  /** `compilerOptions.paths`; `dir` is the folder of the config that set them, which targets are relative to without `baseUrl`. */
  paths?: { patterns: [string, string[]][]; dir: string };
  /**
   * False when a config in the chain could not be read, so an option it sets is unknown, or when the config is
   * solution-style (`references`, `files: []`): the projects it points to, which hold the real options, aren't read.
   */
  complete: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
const firstListed = (files: FileSet, path: string | undefined) => (path === undefined ? undefined : [path, `${path}.json`].find((p) => files.has(p)));

/**
 * The config `extends: "<package>/<subpath>"` names, as TypeScript looks it up: the package's `exports`, else its
 * `tsconfig` field for the package itself, else the path. Undefined when that file isn't in the repo.
 */
function packageConfig(files: FileSet, dir: string, pkg: PackageJson | undefined, subpath: string): string | undefined {
  if (pkg?.exports !== undefined) {
    const target = mapTargets(pkg.exports, subpath).find((t) => t.startsWith('./'));
    return target === undefined ? undefined : firstListed(files, joinRepo(dir, target));
  }
  if (subpath !== '.') return firstListed(files, joinRepo(dir, subpath));
  return firstListed(files, joinRepo(dir, pkg?.tsconfig ?? 'tsconfig.json'));
}

const isSolution = (raw: Record<string, unknown>) => (Array.isArray(raw.references) && raw.references.length > 0) || (Array.isArray(raw.files) && raw.files.length === 0);

interface Packages {
  dir: (name: string) => string | undefined;
  read: (dir: string) => PackageJson | undefined;
}

/**
 * Reads tsconfig files on demand, cached. `extends` follows relative paths and workspace packages; a base config from
 * a package outside the repo is not read, which leaves the chain incomplete.
 */
export function createTsconfigs(files: FileSet, read: (path: string) => string | undefined, packages: Packages) {
  const configs = new Map<string, TsOptions>();
  const nearest = new Map<string, string | undefined>();

  const extendsPath = (from: string, spec: string): string | undefined => {
    if (isRelative(spec)) return firstListed(files, joinRepo(dirOf(from), spec));
    const { name, subpath } = splitPackageSpec(spec);
    const dir = packages.dir(name);
    return dir === undefined ? undefined : packageConfig(files, dir, packages.read(dir), subpath);
  };

  const load = (path: string, seen: Set<string>): TsOptions => {
    const cached = configs.get(path);
    if (cached) return cached;
    if (seen.has(path)) return { complete: false };
    seen.add(path);
    const raw = parseJsonc(read(path) ?? '');
    if (!isObject(raw)) return { complete: false };
    let merged: TsOptions = { complete: !isSolution(raw) };
    for (const spec of typeof raw.extends === 'string' ? [raw.extends] : strings(raw.extends)) {
      const base = extendsPath(path, spec);
      const opts = base ? load(base, seen) : { complete: false };
      merged = { ...merged, ...opts, complete: merged.complete && opts.complete };
    }
    const options = isObject(raw.compilerOptions) ? raw.compilerOptions : {};
    if (typeof options.baseUrl === 'string') {
      const baseUrl = joinRepo(dirOf(path), options.baseUrl);
      merged = baseUrl === undefined ? { ...merged, baseUrl: null, complete: false } : { ...merged, baseUrl };
    }
    if (isObject(options.paths)) {
      const patterns = Object.entries(options.paths).map(([k, v]): [string, string[]] => [k, strings(v)]);
      merged = { ...merged, paths: { patterns, dir: dirOf(path) } };
    }
    configs.set(path, merged);
    return merged;
  };

  const configFor = (dir: string): string | undefined => {
    if (nearest.has(dir)) return nearest.get(dir);
    const prefix = dir ? `${dir}/` : '';
    const own = [`${prefix}tsconfig.json`, `${prefix}jsconfig.json`].find((p) => files.has(p));
    const found = own ?? (dir ? configFor(dirOf(dir)) : undefined);
    nearest.set(dir, found);
    return found;
  };

  return {
    /** Options of the tsconfig.json or jsconfig.json nearest to `file`, walking up; undefined when there is none. */
    forFile: (file: string): TsOptions | undefined => {
      const config = configFor(dirOf(file));
      return config === undefined ? undefined : load(config, new Set());
    },
  };
}

/**
 * Where a `paths` alias leads: `{ file }`, `'no-file'` when a pattern matches but none of its targets exists, or
 * undefined when no pattern matches. An exact pattern wins, then the longest prefix before `*`, as TypeScript picks.
 */
export function matchAlias(files: FileSet, opts: TsOptions, spec: string, fromJs: boolean): { file: string } | 'no-file' | undefined {
  if (!opts.paths) return undefined;
  let best: { targets: string[]; star?: string; prefix: number } | undefined;
  for (const [pattern, targets] of opts.paths.patterns) {
    const at = pattern.indexOf('*');
    if (at < 0) {
      if (pattern !== spec) continue;
      best = { targets, prefix: Infinity };
      break;
    }
    const [prefix, suffix] = [pattern.slice(0, at), pattern.slice(at + 1)];
    if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix) || prefix.length <= (best?.prefix ?? -1)) continue;
    best = { targets, star: spec.slice(prefix.length, spec.length - suffix.length), prefix: prefix.length };
  }
  if (!best) return undefined;
  if (opts.baseUrl === null) return 'no-file';
  const base = opts.baseUrl ?? opts.paths.dir;
  for (const target of best.targets) {
    const path = joinRepo(base, best.star === undefined ? target : target.replaceAll('*', best.star));
    const file = path === undefined ? undefined : resolveFile(files, path, fromJs);
    if (file) return { file };
  }
  return 'no-file';
}

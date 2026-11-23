import { builtinModules } from 'node:module';
import type { Import } from '../model.js';
import { dirOf, isJsFile, isRelative, joinRepo, resolveFile, type FileSet } from './files.js';
import { parseJsonc } from './jsonc.js';
import { mapTargets, toPackageJson, type LoadKind, type PackageJson } from './package-json.js';
import { inPackage, packageEntry, splitPackageSpec, workspacePackages } from './packages.js';
import { PythonResolver } from './python.js';
import { createTsconfigs, matchAlias } from './tsconfig.js';

export type Resolution = Pick<Import, 'status' | 'resolved' | 'packageFolder'>;

/** What a resolution needs beyond the specifier: whether the importing Python file edits `sys.path`. */
interface ResolveContext {
  sysPathEdited?: boolean;
}

/** Resolves import specifiers against one snapshot of a repo's files; caches configs, so make a new one when a config changes. */
export interface Resolver {
  /** Where `spec`, imported by repo file `from`, leads; `kind` picks the package conditions (`require` or the rest). */
  resolve(from: string, spec: string, kind?: Import['kind'], context?: ResolveContext): Resolution;
}

const BUILTINS = new Set(builtinModules);
const UNKNOWN: Resolution = { status: 'unknown' };
const EXTERNAL: Resolution = { status: 'external' };
/** Runtime built-in schemes; other schemes (`virtual:`, URLs) are a bundler's or the network's. */
const RUNTIME_SCHEMES = /^(node|bun|npm|jsr):/;
const found = (file: string | null | undefined): Resolution => (file ? { status: 'resolved', resolved: file } : UNKNOWN);

interface Repo {
  listed: FileSet;
  readPackage: (dir: string) => PackageJson | undefined;
  workspaces: () => Map<string, string | undefined>;
  tsconfigs: ReturnType<typeof createTsconfigs>;
}

/** Package folders from `dir` up to the root, nearest first. */
function packageDirs(repo: Repo, dir: string): string[] {
  const dirs: string[] = [];
  for (let d: string | undefined = dir; d !== undefined; d = d ? dirOf(d) : undefined) if (repo.readPackage(d)) dirs.push(d);
  return dirs;
}

/** `@types/x` for `x`, `@types/scope__name` for `@scope/name`: where TypeScript looks for a package's types. */
const typesPackage = (name: string) => `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;

const declared = (repo: Repo, from: string, name: string) =>
  BUILTINS.has(name) || packageDirs(repo, dirOf(from)).some((d) => repo.readPackage(d)!.deps.has(name) || repo.readPackage(d)!.deps.has(typesPackage(name)));

function fromPackageImports(repo: Repo, from: string, spec: string, load: LoadKind): Resolution {
  const dir = packageDirs(repo, dirOf(from))[0];
  const pkg = dir === undefined ? undefined : repo.readPackage(dir);
  for (const target of pkg?.imports ? mapTargets(pkg.imports, spec, load) : []) {
    const hit = target.startsWith('./') ? found(inPackage(repo.listed, dir!, target, isJsFile(from))) : bare(repo, from, target, load);
    if (hit.status !== 'unknown') return hit;
  }
  return UNKNOWN;
}

function bare(repo: Repo, from: string, spec: string, load: LoadKind): Resolution {
  const fromJs = isJsFile(from);
  const ts = repo.tsconfigs.forFile(from);
  const { name, subpath } = splitPackageSpec(spec);
  const alias = ts && matchAlias(repo.listed, ts, spec, fromJs);
  if (alias === 'no-file') return declared(repo, from, name) ? EXTERNAL : UNKNOWN;
  if (alias) return found(alias.file);
  const viaBaseUrl = typeof ts?.baseUrl === 'string' ? joinRepo(ts.baseUrl, spec) : undefined;
  const file = viaBaseUrl === undefined ? undefined : resolveFile(repo.listed, viaBaseUrl, fromJs);
  if (file) return found(file);
  if (BUILTINS.has(spec)) return EXTERNAL;
  if (repo.workspaces().has(name)) {
    const dir = repo.workspaces().get(name);
    return dir === undefined ? UNKNOWN : found(packageEntry(repo.listed, dir, repo.readPackage(dir)!, subpath, { load, fromJs }));
  }
  // Bun's runtime module, like `bun:test`, ships with Bun rather than as a package.
  if (spec === 'bun') return EXTERNAL;
  // An unread base config or referenced project may set `paths`: only a declared dependency is surely external then.
  if (ts && (!ts.complete || ts.solution) && !declared(repo, from, name)) return UNKNOWN;
  return EXTERNAL;
}

/** A file first; a folder by its package.json entry, else its `index`, as Node loads them. */
function relative(repo: Repo, from: string, spec: string, load: LoadKind): Resolution {
  // A query (`?raw`, `?worker&url`) changes how a bundler loads the file, not which file.
  const query = spec.indexOf('?');
  const path = joinRepo(dirOf(from), query < 0 ? spec : spec.slice(0, query));
  if (path === undefined) return UNKNOWN;
  const file = resolveFile(repo.listed, path, isJsFile(from));
  const pkg = !file || file.startsWith(path ? `${path}/index.` : 'index.') ? repo.readPackage(path) : undefined;
  // `exports` applies to imports by package name only.
  if (pkg?.entries.length) return found(packageEntry(repo.listed, path, { ...pkg, exports: undefined }, '.', { load, fromJs: isJsFile(from) }));
  return found(file);
}

function resolveSpec(repo: Repo, from: string, spec: string, load: LoadKind): Resolution {
  if (RUNTIME_SCHEMES.test(spec)) return EXTERNAL;
  if (isRelative(spec)) return relative(repo, from, spec, load);
  if (spec.startsWith('#')) return fromPackageImports(repo, from, spec, load);
  // Absolute paths, URLs and bundler schemes (`virtual:`) are outside what the repo proves.
  if (!spec || spec.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(spec)) return UNKNOWN;
  return bare(repo, from, spec, load);
}

/** A file set that reports every path asked about: the paths whose appearance or removal can change a resolution. */
class ProbedSet extends Set<string> {
  constructor(
    files: Iterable<string>,
    private readonly probe: (path: string) => void,
  ) {
    super(files);
  }

  override has(path: string): boolean {
    this.probe(path);
    return super.has(path);
  }
}

/** Hooks that see what resolution depends on. */
export interface ResolverProbes {
  /** Every path one resolution checks for. */
  path?: (path: string) => void;
  /**
   * Every path a config lookup (package.json, tsconfig and its `extends` chain, workspaces) checks for or reads. Those
   * lookups are cached and shared by every resolution, so a change to one of these paths can change any of them.
   */
  config?: (path: string) => void;
}

/**
 * A resolver over `files` (repo paths with `/`, as `listCodeFiles` gives them); `read` returns a repo file's text.
 * Only listed files count, so nothing resolves into `node_modules` or ignored build output.
 */
export function createResolver(files: Iterable<string>, read: (path: string) => string | undefined, probes: ResolverProbes = {}): Resolver {
  const listed: FileSet = probes.path ? new ProbedSet(files, probes.path) : new Set(files);
  const { config } = probes;
  const configFiles: FileSet = config ? new ProbedSet(files, config) : listed;
  const readConfig = config
    ? (path: string) => {
        config(path);
        return read(path);
      }
    : read;
  const packages = new Map<string, PackageJson | undefined>();
  const readPackage = (dir: string): PackageJson | undefined => {
    if (!packages.has(dir)) {
      const path = dir ? `${dir}/package.json` : 'package.json';
      packages.set(dir, configFiles.has(path) ? toPackageJson(parseJsonc(readConfig(path) ?? '')) : undefined);
    }
    return packages.get(dir);
  };
  let map: Map<string, string | undefined> | undefined;
  const workspaces = () => (map ??= workspacePackages(configFiles, readPackage, readConfig));
  const repo: Repo = { listed, readPackage, workspaces, tsconfigs: createTsconfigs(configFiles, readConfig, { dir: (name) => workspaces().get(name), read: readPackage }) };
  // Project files (pyproject.toml, setup.py, setup.cfg) set Python's source roots; they are read as config.
  const python = new PythonResolver(listed, readConfig, (key) => probes.path?.(key));
  return {
    resolve: (from, spec, kind, context) => {
      // Python's rules are its own: dots, packages and source roots, not `package.json` and tsconfig.
      if (from.endsWith('.py') || from.endsWith('.pyi')) {
        return python.resolve(from, spec, context?.sysPathEdited ?? false);
      }
      return resolveSpec(repo, from, spec, kind === 'require' ? 'require' : 'import');
    },
  };
}

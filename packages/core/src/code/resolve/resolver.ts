import { builtinModules } from 'node:module';
import type { Import } from '../model.js';
import { dirOf, isJsFile, isRelative, joinRepo, resolveFile, type FileSet } from './files.js';
import { parseJsonc } from './jsonc.js';
import { mapTargets, toPackageJson, type PackageJson } from './package-json.js';
import { inPackage, packageEntry, splitPackageSpec, workspacePackages } from './packages.js';
import { createTsconfigs, matchAlias } from './tsconfig.js';

export type Resolution = Pick<Import, 'status' | 'resolved'>;

/** Resolves import specifiers against one snapshot of a repo's files; caches configs, so make a new one when a config changes. */
export interface Resolver {
  /** Where `spec`, imported by repo file `from`, leads. */
  resolve(from: string, spec: string): Resolution;
}

const BUILTINS = new Set(builtinModules);
const UNKNOWN: Resolution = { status: 'unknown' };
const EXTERNAL: Resolution = { status: 'external' };
const found = (file: string | undefined): Resolution => (file ? { status: 'resolved', resolved: file } : UNKNOWN);

/**
 * A resolver over `files` (repo paths with `/`, as `listCodeFiles` gives them); `read` returns a repo file's text.
 * Only listed files count, so nothing resolves into `node_modules` or ignored build output.
 */
export function createResolver(files: Iterable<string>, read: (path: string) => string | undefined): Resolver {
  const listed: FileSet = new Set(files);
  const packages = new Map<string, PackageJson | undefined>();
  const readPackage = (dir: string): PackageJson | undefined => {
    if (!packages.has(dir)) {
      const path = dir ? `${dir}/package.json` : 'package.json';
      packages.set(dir, listed.has(path) ? toPackageJson(parseJsonc(read(path) ?? '')) : undefined);
    }
    return packages.get(dir);
  };
  let workspaces: Map<string, string | undefined> | undefined;
  const workspaceMap = () => (workspaces ??= workspacePackages(listed, readPackage, read));
  const tsconfigs = createTsconfigs(listed, read, (name) => workspaceMap().get(name));

  /** Package folders from `dir` up to the root, nearest first. */
  const packageDirs = (dir: string): string[] => {
    const dirs: string[] = [];
    for (let d: string | undefined = dir; d !== undefined; d = d ? dirOf(d) : undefined) if (readPackage(d)) dirs.push(d);
    return dirs;
  };
  const declared = (from: string, name: string) => BUILTINS.has(name) || packageDirs(dirOf(from)).some((d) => readPackage(d)!.deps.has(name));

  const fromPackageImports = (from: string, spec: string): Resolution => {
    const dir = packageDirs(dirOf(from))[0];
    const pkg = dir === undefined ? undefined : readPackage(dir);
    for (const target of pkg?.imports ? mapTargets(pkg.imports, spec) : []) {
      const hit = target.startsWith('./') ? found(inPackage(listed, dir!, target)) : bare(from, target);
      if (hit.status !== 'unknown') return hit;
    }
    return UNKNOWN;
  };

  const bare = (from: string, spec: string): Resolution => {
    const fromJs = isJsFile(from);
    const ts = tsconfigs.forFile(from);
    const { name, subpath } = splitPackageSpec(spec);
    const alias = ts && matchAlias(listed, ts, spec, fromJs);
    if (alias === 'no-file') return declared(from, name) ? EXTERNAL : UNKNOWN;
    if (alias) return found(alias.file);
    const viaBaseUrl = ts?.baseUrl === undefined ? undefined : joinRepo(ts.baseUrl, spec);
    const file = viaBaseUrl === undefined ? undefined : resolveFile(listed, viaBaseUrl, fromJs);
    if (file) return found(file);
    if (BUILTINS.has(spec)) return EXTERNAL;
    if (workspaceMap().has(name)) {
      const dir = workspaceMap().get(name);
      return dir === undefined ? UNKNOWN : found(packageEntry(listed, dir, readPackage(dir)!, subpath));
    }
    // A base config outside the repo may set `paths`: only a declared dependency is surely external then.
    if (ts && !ts.complete && !declared(from, name)) return UNKNOWN;
    return EXTERNAL;
  };

  return {
    resolve(from, spec) {
      if (spec.startsWith('node:')) return EXTERNAL;
      if (isRelative(spec)) {
        const path = joinRepo(dirOf(from), spec);
        return found(path === undefined ? undefined : resolveFile(listed, path, isJsFile(from)));
      }
      if (spec.startsWith('#')) return fromPackageImports(from, spec);
      // Absolute paths, URLs and loader schemes (`virtual:`, `bun:`) are outside what the repo proves.
      if (!spec || spec.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(spec)) return UNKNOWN;
      return bare(from, spec);
    },
  };
}

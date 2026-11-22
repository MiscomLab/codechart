import type { Import, ImportedName } from '../model.js';
import type { ParsedFile } from '../parse.js';
import { resolveCalls } from './calls.js';
import type { Resolver } from './resolver.js';
import { createTracer, type Tracer } from './trace.js';

const allPaths = (files: readonly ParsedFile[]): Set<string> => new Set(files.map((f) => f.file.path));

/** A file's imports with their current resolution and no evidence from an earlier link pass. */
function withResolvedImports(parsed: ParsedFile, resolver: Resolver): ParsedFile {
  return {
    ...parsed,
    imports: parsed.imports.map((stated): Import => {
      const imp: Import = { ...stated, ...resolver.resolve(parsed.file.path, stated.spec, stated.kind) };
      if (imp.status !== 'resolved') delete imp.resolved;
      if (imp.names) {
        imp.names = imp.names.map((name) => {
          const fresh = { ...name };
          delete fresh.definedIn;
          return fresh;
        });
      }
      return imp;
    }),
  };
}

/** Resolves import paths in `only` (all files by default) without parsing; the next pass proves `definedIn`. */
export function resolveImports(files: readonly ParsedFile[], resolver: Resolver, only?: ReadonlySet<string>): ParsedFile[] {
  const paths = only ?? allPaths(files);
  return files.map((f) => (paths.has(f.file.path) ? withResolvedImports(f, resolver) : f));
}

function withDefinitions(imp: Import, trace: Tracer): Import {
  if (!imp.names) return imp;
  const names = imp.names.map((stated): ImportedName => {
    const name = { ...stated };
    delete name.definedIn;
    if (imp.status !== 'resolved' || !imp.resolved || name.local === '*') return name;
    const found = name.imported === '*' ? { file: imp.resolved, binding: '*' } : trace(imp.resolved, name.imported);
    return typeof found === 'object' ? { ...name, definedIn: found.file } : name;
  });
  return { ...imp, names };
}

export interface LinkPass {
  /** Files whose imported names get a fresh `definedIn`. */
  definitions?: ReadonlySet<string>;
  /** Files whose calls get a fresh target. */
  calls?: ReadonlySet<string>;
}

/**
 * Adds `definedIn` and call targets to files whose imports were just resolved. One export tracer serves the whole pass,
 * so a barrel is followed once no matter how many names point through it.
 */
export function linkResolved(files: readonly ParsedFile[], pass: LinkPass): ParsedFile[] {
  const map = new Map(files.map((f) => [f.file.path, f]));
  const trace = createTracer(map);
  const linked = new Map(map);
  for (const path of pass.definitions ?? []) {
    const parsed = map.get(path);
    if (parsed) linked.set(path, { ...parsed, imports: parsed.imports.map((imp) => withDefinitions(imp, trace)) });
  }
  const callRefs = resolveCalls(map, pass.calls ?? new Set(), trace);
  for (const [path, calls] of callRefs) {
    const parsed = linked.get(path);
    if (parsed) linked.set(path, { ...parsed, calls });
  }
  return files.map((f) => linked.get(f.file.path)!);
}

/**
 * Resolves every file's imports with `resolver`, then follows each imported name through re-exports to the file
 * that defines it. Files not passed in count as unparsed: names reaching them get no `definedIn`.
 */
export function linkImports(files: readonly ParsedFile[], resolver: Resolver): ParsedFile[] {
  const resolved = resolveImports(files, resolver);
  return linkResolved(resolved, { definitions: allPaths(resolved) });
}

/** Imports and calls of every file, linked against the full set. */
export function linkCode(files: readonly ParsedFile[], resolver: Resolver): ParsedFile[] {
  const resolved = resolveImports(files, resolver);
  const paths = allPaths(resolved);
  return linkResolved(resolved, { definitions: paths, calls: paths });
}

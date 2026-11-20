import type { Import, ImportedName } from '../model.js';
import type { ParsedFile } from '../parse.js';
import type { Resolver } from './resolver.js';

/** Where a name a file exports is defined: a file, proven absent, or not provable (ambiguous, unresolved, CommonJS). */
type Found = { file: string } | 'none' | 'unknown';

const isStar = (i: Import) => i.kind === 'export' && (i.names ?? []).some((n) => n.local === '*');

function createTracer(byPath: ReadonlyMap<string, ParsedFile>) {
  const memo = new Map<string, Found>();

  const through = (imp: Import, imported: string, seen: Set<string>): Found => {
    if (imp.status !== 'resolved' || !imp.resolved) return 'unknown';
    return imported === '*' ? { file: imp.resolved } : find(imp.resolved, imported, seen);
  };

  /** `export * from` adds a name when exactly one of them provides it; two that do make it ambiguous, so not proven. */
  const viaStars = (parsed: ParsedFile, name: string, seen: Set<string>): Found => {
    const hits = new Set<string>();
    let unsure = !parsed.exports.complete;
    for (const imp of parsed.imports.filter(isStar)) {
      const found = through(imp, name, seen);
      if (found === 'unknown') unsure = true;
      else if (found !== 'none') hits.add(found.file);
    }
    if (hits.size > 1 || unsure) return 'unknown';
    return hits.size ? { file: [...hits][0]! } : 'none';
  };

  // `seen` spans one lookup: a cycle adds no name, and a file reached twice gives the same definition.
  function find(file: string, name: string, seen: Set<string>): Found {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return 'none';
    seen.add(key);
    const parsed = byPath.get(file);
    if (!parsed) return 'unknown';
    const own = parsed.exports.names.find((e) => e.name === name);
    if (own) {
      if (own.local === undefined) return { file };
      const binding = parsed.imports.find((i) => i.kind === 'import' && i.names?.some((n) => n.local === own.local));
      return binding ? through(binding, binding.names!.find((n) => n.local === own.local)!.imported, seen) : { file };
    }
    const reexport = parsed.imports.find((i) => i.kind === 'export' && i.names?.some((n) => n.local === name));
    if (reexport) return through(reexport, reexport.names!.find((n) => n.local === name)!.imported, seen);
    // `export *` never re-exports `default`.
    if (name === 'default') return parsed.exports.complete ? 'none' : 'unknown';
    return viaStars(parsed, name, seen);
  }

  return (file: string, name: string): Found => {
    const key = `${file}\0${name}`;
    let found = memo.get(key);
    if (!found) memo.set(key, (found = find(file, name, new Set())));
    return found;
  };
}

function withDefinitions(imp: Import, trace: ReturnType<typeof createTracer>): Import {
  if (!imp.names) return imp;
  const names = imp.names.map((stated): ImportedName => {
    const name = { ...stated };
    delete name.definedIn;
    if (imp.status !== 'resolved' || !imp.resolved || name.local === '*') return name;
    const found = name.imported === '*' ? { file: imp.resolved } : trace(imp.resolved, name.imported);
    return typeof found === 'object' ? { ...name, definedIn: found.file } : name;
  });
  return { ...imp, names };
}

/**
 * Resolves every file's imports with `resolver`, then follows each imported name through re-exports to the file
 * that defines it. Files not passed in count as unparsed: names reaching them get no `definedIn`.
 */
export function linkImports(files: readonly ParsedFile[], resolver: Resolver): ParsedFile[] {
  const resolved = files.map((f) => ({
    ...f,
    imports: f.imports.map((stated): Import => {
      const imp = { ...stated, ...resolver.resolve(f.file.path, stated.spec) };
      if (imp.status !== 'resolved') delete imp.resolved;
      return imp;
    }),
  }));
  const trace = createTracer(new Map(resolved.map((f) => [f.file.path, f])));
  return resolved.map((f) => ({ ...f, imports: f.imports.map((i) => withDefinitions(i, trace)) }));
}

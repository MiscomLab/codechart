import type { Import, ImportedName } from '../model.js';
import type { ParsedFile } from '../parse.js';
import type { Resolver } from './resolver.js';

/** Where a name a file exports is defined (the file and its binding there), proven absent, or not provable (ambiguous, unresolved, CommonJS). */
type Found = { file: string; binding: string } | 'none' | 'unknown';

const isStar = (i: Import) => i.kind === 'export' && (i.names ?? []).some((n) => n.local === '*');

type Files = ReadonlyMap<string, ParsedFile>;

function through(files: Files, imp: Import, imported: string, seen: Set<string>): Found {
  if (imp.status !== 'resolved' || !imp.resolved) return 'unknown';
  return imported === '*' ? { file: imp.resolved, binding: '*' } : find(files, imp.resolved, imported, seen);
}

/** `export * from` adds a name when exactly one binding provides it; two that do make it ambiguous, so not proven. */
function viaStars(files: Files, parsed: ParsedFile, name: string, seen: Set<string>): Found {
  const hits = new Map<string, Found>();
  let unsure = !parsed.exports.complete;
  for (const imp of parsed.imports.filter(isStar)) {
    const found = through(files, imp, name, seen);
    if (found === 'unknown') unsure = true;
    else if (found !== 'none') hits.set(`${found.file}\0${found.binding}`, found);
  }
  if (hits.size > 1 || unsure) return 'unknown';
  return [...hits.values()][0] ?? 'none';
}

/** The import in `parsed` of `kind` that binds `local`, and its name entry. */
function binding(parsed: ParsedFile, kind: Import['kind'], local: string): { imp: Import; imported: string } | undefined {
  for (const imp of parsed.imports) {
    const name = imp.kind === kind ? imp.names?.find((n) => n.local === local) : undefined;
    if (name) return { imp, imported: name.imported };
  }
  return undefined;
}

// `seen` spans one lookup: a cycle adds no name, and a file reached twice gives the same definition.
function find(files: Files, file: string, name: string, seen: Set<string>): Found {
  const key = `${file}\0${name}`;
  if (seen.has(key)) return 'none';
  seen.add(key);
  const parsed = files.get(file);
  if (!parsed) return 'unknown';
  const own = parsed.exports.names.find((e) => e.name === name);
  if (own) {
    const imported = own.local === undefined ? undefined : binding(parsed, 'import', own.local);
    return imported ? through(files, imported.imp, imported.imported, seen) : { file, binding: own.local ?? name };
  }
  const reexport = binding(parsed, 'export', name);
  if (reexport) return through(files, reexport.imp, reexport.imported, seen);
  // `export *` never re-exports `default`.
  if (name === 'default') return parsed.exports.complete ? 'none' : 'unknown';
  return viaStars(files, parsed, name, seen);
}

function createTracer(files: Files) {
  const memo = new Map<string, Found>();
  return (file: string, name: string): Found => {
    const key = `${file}\0${name}`;
    let found = memo.get(key);
    if (!found) memo.set(key, (found = find(files, file, name, new Set())));
    return found;
  };
}

function withDefinitions(imp: Import, trace: ReturnType<typeof createTracer>): Import {
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

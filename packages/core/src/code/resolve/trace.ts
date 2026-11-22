import type { Import } from '../model.js';
import type { ParsedFile } from '../parse.js';

/** Where a name a file exports is defined (the file and its binding there), proven absent, or not provable (ambiguous, unresolved, CommonJS). */
export type Found = { file: string; binding: string } | 'none' | 'unknown';

/** Resolves an exported name from a file, following re-exports and barrels; memoized for one link pass. */
export type Tracer = (file: string, name: string) => Found;

type Files = ReadonlyMap<string, ParsedFile>;

const isStar = (i: Import) => i.kind === 'export' && (i.names ?? []).some((n) => n.local === '*');

/** The package folder of a Python `__init__` module, or undefined for a file that cannot own submodules. */
function packageDir(file: string): string | undefined {
  for (const init of ['/__init__.py', '/__init__.pyi']) if (file.endsWith(init)) return file.slice(0, -init.length);
  return undefined;
}

/** The module a Python name may be when the package does not export it: `from pkg import mod` → `pkg/mod.py`. */
export function pythonSubmodule(files: Files, file: string, name: string): string | undefined {
  const dir = packageDir(file);
  if (dir === undefined) return undefined;
  const base = dir ? `${dir}/${name}` : name;
  for (const candidate of [`${base}.py`, `${base}/__init__.py`]) if (files.has(candidate)) return candidate;
  return undefined;
}

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
  if (!parsed.exports.complete) return 'unknown';
  // Python's `from pkg import mod` names a module when the package does not export `mod` itself.
  const submodule = pythonSubmodule(files, file, name);
  if (submodule) return { file: submodule, binding: '*' };
  return viaStars(files, parsed, name, seen);
}

/** A tracer over one snapshot of linked files; reuse it for every name in a pass. */
export function createTracer(files: Files): Tracer {
  const memo = new Map<string, Found>();
  return (file: string, name: string): Found => {
    const key = `${file}\0${name}`;
    let found = memo.get(key);
    if (!found) memo.set(key, (found = find(files, file, name, new Set())));
    return found;
  };
}

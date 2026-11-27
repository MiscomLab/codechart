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
  return file.endsWith('/__init__.py') ? file.slice(0, -'/__init__.py'.length) : undefined;
}

/** The module `name` is in a Python package folder, as the import system finds it: a regular package before a module. */
export function submoduleIn(files: Files, folder: string, name: string): string | undefined {
  const base = folder ? `${folder}/${name}` : name;
  return [`${base}/__init__.py`, `${base}.py`].find((path) => files.has(path));
}

/** The module a Python name may be when the package does not bind it: `from pkg import mod` → `pkg/mod.py`. */
function pythonSubmodule(files: Files, file: string, name: string): string | undefined {
  const dir = packageDir(file);
  return dir === undefined ? undefined : submoduleIn(files, dir, name);
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

/**
 * A Python module's own name, from the one module-scope binding its exports were built from: a function-local,
 * type-alias type-parameter or type-checking-only import of the same name binds nothing at module scope. When a package
 * `__init__.py` imports one of its own submodules, that import replaces the same-named attribute with the module.
 */
function pythonOwn(files: Files, parsed: ParsedFile, file: string, name: string, seen: Set<string>): Found {
  const dir = packageDir(file);
  const submodule = dir === undefined ? undefined : submoduleIn(files, dir, name);
  if (submodule !== undefined && parsed.imports.some((imp) => imp.resolved === submodule)) return 'unknown';
  const bound = parsed.bindings!.find((b) => b.scope === '' && b.name === name && !b.alias);
  const imp = bound?.kind === 'import' && !bound.dotted ? parsed.imports[bound.import!] : undefined;
  const entry = imp?.names?.find((n) => n.local === name);
  return imp && entry ? through(files, imp, entry.imported, seen) : { file, binding: name };
}

// `seen` spans one lookup: a cycle adds no name, and a file reached twice gives the same definition.
function find(files: Files, file: string, name: string, seen: Set<string>): Found {
  const key = `${file}\0${name}`;
  if (seen.has(key)) return 'none';
  seen.add(key);
  const parsed = files.get(file);
  if (!parsed) return 'unknown';
  const own = parsed.exports.names.find((e) => e.name === name);
  if (own && parsed.bindings) return pythonOwn(files, parsed, file, name, seen);
  if (own) {
    const imported = own.local === undefined ? undefined : binding(parsed, 'import', own.local);
    return imported ? through(files, imported.imp, imported.imported, seen) : { file, binding: own.local ?? name };
  }
  const reexport = binding(parsed, 'export', name);
  if (reexport) return through(files, reexport.imp, reexport.imported, seen);
  // `export *` never re-exports `default`.
  if (name === 'default') return parsed.exports.complete ? 'none' : 'unknown';
  // Python's `from pkg import mod` names a module when the package does not bind `mod` itself.
  if (parsed.bindings) {
    if (!parsed.exports.complete) return 'unknown';
    const submodule = pythonSubmodule(files, file, name);
    return submodule ? { file: submodule, binding: '*' } : 'none';
  }
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

/** A module binding whose import is known to sit outside the repo: writing to it cannot rebind a module here. */
export const EXTERNAL_MODULE = '\0external';

/** The module a dotted chain names from its root module: each further part must be a submodule of a package. */
export function submoduleFile(files: Files, file: string, parts: readonly string[]): string | undefined {
  let current = file;
  for (const part of parts) {
    const folder = current.endsWith('/__init__.py') ? current.slice(0, -'/__init__.py'.length) : undefined;
    const next = folder === undefined ? undefined : submoduleIn(files, folder, part);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/**
 * The module file an import binding names: the imported module, a submodule a from-import binds, EXTERNAL outside the
 * repo, undefined when the binding holds a value, or null when the parse cannot prove which.
 */
export function importModule(files: Files, parsed: ParsedFile, index: number, name: string, dotted: boolean): string | null | undefined {
  const imp = parsed.imports[index];
  // Only a proven repo module can be written through a value: an external or unknown import names none.
  if (!imp || imp.status !== 'resolved' || !imp.resolved) return undefined;
  if (dotted) return dottedPackage(files, imp);
  const entry = imp.names?.find((n) => n.local === name);
  if (!entry) return imp.resolved;
  if (entry.imported === '*') return imp.resolved;
  const folder = imp.resolved.endsWith('/__init__.py') ? imp.resolved.slice(0, -'/__init__.py'.length) : undefined;
  const pkg = files.get(imp.resolved);
  // A plain module's attribute is a value, never a module; a package's name may be a submodule.
  if (!folder || !pkg) return undefined;
  // A package whose own names are not provable may bind the name itself, so the submodule is not certain.
  if (!pkg.exports.complete) return null;
  if (pkg.exports.names.some((n) => n.name === entry.imported)) return undefined;
  // The package binds neither: the from-import raises unless the name is one of its submodules.
  return submoduleIn(files, folder, entry.imported);
}

/** The package `import a.b` binds (`a`), found from the resolved submodule path; undefined for a namespace package. */
function dottedPackage(files: Files, imp: Import): string | undefined {
  const resolved = imp.resolved;
  if (!resolved) return undefined;
  const parts = imp.spec.split('.');
  const module = `${parts.join('/')}.py`;
  const init = `${parts.join('/')}/__init__.py`;
  const root = resolved.endsWith(module) ? resolved.slice(0, -module.length) : resolved.endsWith(init) ? resolved.slice(0, -init.length) : undefined;
  if (root === undefined) return undefined;
  const file = `${root}${parts[0]}/__init__.py`;
  return files.has(file) ? file : undefined;
}

/** The module file each module-scope import binding names, EXTERNAL for one outside the repo, null when unprovable. */
export function moduleBindings(parsed: ParsedFile): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const b of parsed.bindings ?? []) {
    if (b.scope !== '' || b.kind !== 'import' || b.import === undefined) continue;
    const imp = parsed.imports[b.import];
    const module = b.dotted || !imp ? null : imp.status === 'resolved' && imp.resolved ? imp.resolved : imp.status === 'external' ? EXTERNAL_MODULE : null;
    const known = out.get(b.name);
    if (known === undefined) out.set(b.name, module);
    else if (known !== module) out.set(b.name, null);
  }
  return out;
}

/** Every repo module CPython could load under a dotted name: a file whose path ends with `<name>.py` or `<name>/__init__.py`. */
export function modulesNamed(files: Files, name: string): string[] {
  const path = name.split('.').join('/');
  if (!path) return [];
  return [...files.keys()].filter((file) => file === `${path}.py` || file === `${path}/__init__.py` || file.endsWith(`/${path}.py`) || file.endsWith(`/${path}/__init__.py`));
}

/** The dotted module names an unresolved import could load, or null when it is a relative one above its package. */
export function unresolvedNames(imp: Import, file: string, receiver: string, dotted: boolean): string[] | null {
  if (imp.spec.startsWith('.')) return relativeNames(file, imp.spec);
  // `import a.b` binds the package a; any other binding names the module itself, or the submodule a from-import may bind.
  if (dotted) return [imp.spec.split('.')[0]!];
  const entry = imp.names?.find((n) => n.local === receiver);
  if (!entry || entry.imported === '*') return [imp.spec];
  return [`${imp.spec}.${entry.imported}`];
}

/** A relative spec (`.f`, `..pkg.f`) as an absolute dotted name from the importing file's own folder; over-approximated. */
function relativeNames(file: string, spec: string): string[] | null {
  const level = spec.length - spec.replace(/^\.+/, '').length;
  const rest = spec.slice(level).split('.').filter(Boolean);
  const dir = file.split('/').slice(0, -1);
  if (level - 1 > dir.length) return null;
  const name = [...dir.slice(0, dir.length - (level - 1)), ...rest].join('.');
  return name ? [name] : null;
}

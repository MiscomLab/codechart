import type { CallRef, CodeSymbol } from '../model.js';
import type { ParsedFile } from '../parse.js';
import type { Found, Tracer } from './trace.js';

type Files = ReadonlyMap<string, ParsedFile>;
type Import = ParsedFile['imports'][number];
type FoundTarget = CodeSymbol | undefined;
type SameFile = { kind: 'found'; symbol: CodeSymbol } | { kind: 'ambiguous' } | { kind: 'none' };

const isPrefix = (prefix: readonly string[], path: readonly string[]) => prefix.every((part, i) => path[i] === part);

/** Per-file symbol lookup by leaf name and id, built once per link pass. */
class SymbolLookup {
  private readonly byFile = new Map<string, { byName: Map<string, CodeSymbol[]>; byId: Map<string, CodeSymbol> }>();

  constructor(private readonly files: Files) {}

  private index(file: string) {
    let entry = this.byFile.get(file);
    if (!entry) {
      const byName = new Map<string, CodeSymbol[]>();
      const byId = new Map<string, CodeSymbol>();
      for (const symbol of this.files.get(file)?.symbols ?? []) {
        const leaf = symbol.path[symbol.path.length - 1]!;
        const named = byName.get(leaf);
        if (named) named.push(symbol);
        else byName.set(leaf, [symbol]);
        byId.set(symbol.id, symbol);
      }
      this.byFile.set(file, (entry = { byName, byId }));
    }
    return entry;
  }

  byName(file: string, name: string): CodeSymbol[] {
    return this.index(file).byName.get(name) ?? [];
  }

  all(file: string): CodeSymbol[] {
    return this.files.get(file)?.symbols ?? [];
  }

  byId(file: string, id: string): CodeSymbol | undefined {
    return this.index(file).byId.get(id);
  }
}

/** The top-level function or class a proven export binding points at; anything else proves no call target. */
function symbolAt(found: Found, lookup: SymbolLookup): FoundTarget {
  if (typeof found !== 'object') return undefined;
  const symbols = lookup.byName(found.file, found.binding).filter((s) => (s.kind === 'function' || s.kind === 'class') && s.path.length === 1);
  return symbols.length === 1 ? symbols[0] : undefined;
}

/**
 * A module binding: `import ns`, `import a.b as ns`, `from . import billing` or `importlib.import_module('x')` assigned
 * to a name. `from pkg import mod` binds a name too, but that is the submodule case, not the namespace one.
 */
const moduleBinding = (imp: Import, local: string): boolean =>
  imp.kind === 'import' && imp.status === 'resolved' && !!imp.resolved && (imp.names ?? []).some((n) => n.local === local && !n.typeOnly && (n.imported === '*' || n.imported === imp.spec || n.imported === imp.spec.split('.').pop()));

/** The module file a folder holds under a name, as Python's `from pkg import mod` names it: `pkg/mod.py`. */
function submodule(files: Files, folder: string, name: string): string | undefined {
  const base = folder ? `${folder}/${name}` : name;
  return [`${base}.py`, `${base}/__init__.py`].find((path) => files.has(path));
}

/**
 * The module a Python dotted receiver chain names: `import a.b` then `a.b.f()` walks `a`'s package to `a/b`. The import
 * binds its first segment (`a`); an alias binds the module outright, so the chain after it names submodules of it.
 */
function moduleOf(parsed: ParsedFile, files: Files, call: CallRef): string | undefined {
  const path = call.receiverPath;
  if (!path) return undefined;
  const [root, ...rest] = path;
  const binding = parsed.imports.find((i) => moduleBinding(i, root!) && i.resolved);
  if (binding) {
    let file = binding.resolved!;
    for (const segment of rest) {
      const folder = file.endsWith('/__init__.py') || file.endsWith('/__init__.pyi') ? file.replace(/\/__init__\.pyi?$/, '') : undefined;
      if (folder === undefined) return undefined;
      const next = submodule(files, folder, segment);
      if (!next) return undefined;
      file = next;
    }
    return file;
  }
  // An unaliased `import a.b` names no binding, but the chain the code writes is the spec it resolved.
  const spec = parsed.imports.find((i) => i.kind === 'import' && i.status === 'resolved' && i.resolved && (i.names ?? []).length === 0 && i.spec === path.join('.'));
  return spec?.resolved;
}

/** A bare call bound to an imported name, through barrels to the function that defines it. */
function importedTarget(call: CallRef, parsed: ParsedFile, trace: Tracer, lookup: SymbolLookup): FoundTarget {
  const targets = parsed.imports
    .filter((imp) => imp.kind === 'import' && imp.status === 'resolved' && imp.resolved)
    .flatMap((imp) =>
      (imp.names ?? [])
        .filter((name) => name.local === call.name && !name.typeOnly && name.imported !== '*')
        .map((name) => {
          const found = trace(name.definedIn ?? imp.resolved!, name.imported);
          if (typeof found !== 'object') return undefined;
          // The same file's definitions are the import's source when it imports from itself, as a split module does.
          const own = found.file === parsed.file.path ? lookup.byName(parsed.file.path, found.binding).filter((s) => s.path.length === 1) : [];
          if (own.length === 1) return own[0];
          return symbolAt(found, lookup);
        }),
    )
    .filter((symbol): symbol is CodeSymbol => !!symbol);
  const unique = new Map(targets.map((s) => [s.id, s]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

/** The class whose method holds this call; a class body call (constructor, field initializer) belongs to the class. */
function classOwner(file: string, from: CodeSymbol, lookup: SymbolLookup): CodeSymbol | undefined {
  if (from.kind === 'class') return from;
  const classes = lookup.all(file).filter((s) => s.kind === 'class' && isPrefix(s.path, from.path) && from.path.length === s.path.length + 1);
  return classes.sort((a, b) => b.path.length - a.path.length)[0];
}

/** `this.name()` to the one method that name in the enclosing class; Python's `self.name()` and `cls.name()` too. */
function thisTarget(file: string, call: CallRef, from: CodeSymbol, lookup: SymbolLookup): FoundTarget {
  const owner = classOwner(file, from, lookup);
  if (!owner) return undefined;
  const methods = lookup
    .byName(file, call.name)
    .filter((s) => s.kind === 'method' && s.path.length === owner.path.length + 1 && isPrefix(owner.path, s.path));
  return methods.length === 1 ? methods[0] : undefined;
}

/** `ns.name()` where `ns` is a module the file binds: a TypeScript namespace import, or Python's `import ns`. */
function namespaceTarget(call: CallRef, parsed: ParsedFile, trace: Tracer, lookup: SymbolLookup): FoundTarget {
  if (!call.receiver) return undefined;
  const imp = parsed.imports.find((i) => moduleBinding(i, call.receiver!));
  const file = imp?.resolved ?? imp?.names?.find((n) => n.local === call.receiver)?.definedIn;
  return file ? symbolAt(trace(file, call.name), lookup) : undefined;
}

/**
 * `service.charge()` where the file binds `service = PaymentService(…)` from an import: the method of the class the
 * name was constructed from. Only an assignment the call's own scope holds proves it, and only when one import binds
 * the constructor, so an assignment elsewhere or a second binding leaves the call name-only.
 */
function constructedMember(call: CallRef, parsed: ParsedFile, from: CodeSymbol, trace: Tracer, lookup: SymbolLookup): FoundTarget {
  if (!call.receiver || !parsed.file.path.endsWith('.py')) return undefined;
  const assignments = parsed.assignments?.filter((a) => a.name === call.receiver && isPrefix(from.path.slice(0, -1), a.scope)) ?? [];
  if (assignments.length !== 1) return undefined;
  const constructor = assignments[0]!.constructor;
  // The class may be defined in the file or imported from another one; both are proven, so both are tried.
  const local = lookup.byName(parsed.file.path, constructor).filter((s) => s.kind === 'class' && s.path.length === 1);
  const bindings = parsed.imports.filter((imp) => imp.kind === 'import' && imp.status === 'resolved' && imp.resolved && (imp.names ?? []).some((n) => n.local === constructor && !n.typeOnly && n.imported !== '*'));
  if (local.length + bindings.length !== 1) return undefined;
  let owner = local[0];
  if (!owner) {
    const binding = bindings[0]!.names!.find((n) => n.local === constructor)!;
    const found = trace(binding.definedIn ?? bindings[0]!.resolved!, binding.imported);
    if (typeof found !== 'object') return undefined;
    owner = lookup.byName(found.file, found.binding).filter((s) => s.kind === 'class' && s.path.length === 1)[0];
  }
  if (!owner) return undefined;
  const class_ = owner;
  const methods = lookup.byName(class_.file, call.name).filter((s) => s.kind === 'method' && isPrefix(class_.path, s.path) && s.path.length === class_.path.length + 1);
  return methods.length === 1 ? methods[0] : undefined;
}

/**
 * `mod.name()` where `mod` is a name bound by `from pkg import mod`. The package file may not export `mod` itself, so
 * the submodule is where the name comes from; an unknown spec (a namespace package) still names a folder to look in.
 */
function submoduleTarget(call: CallRef, parsed: ParsedFile, files: Files, trace: Tracer, lookup: SymbolLookup): FoundTarget {
  if (!call.receiver) return undefined;
  const receiver = call.receiver;
  const hits = parsed.imports.flatMap((imp) => {
    const found = (imp.names ?? []).find((n) => n.local === receiver && !n.typeOnly && n.imported !== '*');
    if (!found) return [];
    if (found.definedIn) return [{ file: found.definedIn, binding: found.imported } as const];
    // `from .billing import charge` binds a function, not a module; but `from . import billing` binds the module file.
    if (imp.status === 'resolved' && imp.resolved && (found.imported === imp.spec || found.imported === imp.spec.split('.').pop())) return [{ file: imp.resolved, binding: '*' } as const];
    if (imp.status === 'resolved' && imp.resolved) return [trace(imp.resolved, found.imported)];
    const folder = imp.status === 'unknown' && !imp.resolved ? specFolder(parsed.file.path, imp) : undefined;
    const file = folder === undefined ? undefined : submodule(files, folder, receiver);
    return file ? [{ file, binding: '*' } as const] : [];
  });
  const modules = [...new Set(hits.flatMap((hit) => (typeof hit === 'object' && hit.binding === '*' ? [hit.file] : [])))];
  if (modules.length !== 1) return undefined;
  return symbolAt(trace(modules[0]!, call.name), lookup);
}

/** The folder a relative spec names, for a package whose `__init__.py` the repo does not contain. */
function specFolder(file: string, imp: Import): string | undefined {
  const dir = file.slice(0, Math.max(0, file.lastIndexOf('/')));
  if (!imp.spec.startsWith('.')) return imp.spec.replace(/\./g, '/');
  const level = imp.spec.match(/^\.+/)![0].length;
  let base = dir;
  for (let i = 1; i < level; i++) base = base.slice(0, Math.max(0, base.lastIndexOf('/')));
  const rest = imp.spec.replace(/^\.+/, '').replace(/\./g, '/');
  return rest ? (base ? `${base}/${rest}` : rest) : base;
}

/** Whether a call sits inside a function-local import's range: that import binds the name in its own function only. */
function inside(call: CallRef, imp: Import): boolean {
  const { start, end } = imp.range;
  const at = call.range.start;
  return (start.line < at.line || (start.line === at.line && start.column <= at.column)) && end.line > at.line;
}

/**
 * A bare call to a function defined in the same file: the nearest visible definition, or ambiguous. Python weighs the
 * file's imports here: a module-level import binding the same name may run before or after the definition, which the
 * parse does not prove, so such a call stays name-only.
 */
function sameFileTarget(parsed: ParsedFile, call: CallRef, from: CodeSymbol, lookup: SymbolLookup): SameFile {
  const file = parsed.file.path;
  // Python's `PaymentService(...)` is a class call; a JavaScript class is not called bare.
  const kinds = file.endsWith('.py') ? new Set(['function', 'class']) : new Set(['function']);
  const candidates = lookup.byName(file, call.name).filter((s) => kinds.has(s.kind));
  const visible = candidates.filter((s) => s.path.length === 1 || isPrefix(s.path.slice(0, -1), from.path));
  if (file.endsWith('.py') && visible.length) {
    const moduleImport = parsed.imports.some((imp) => imp.kind === 'import' && (imp.names ?? []).some((n) => n.local === call.name) && !inside(call, imp));
    if (moduleImport) return { kind: 'ambiguous' };
  }
  if (!visible.length) return { kind: 'none' };
  const depth = Math.max(...visible.map((s) => s.path.length));
  const nearest = visible.filter((s) => s.path.length === depth);
  return nearest.length === 1 ? { kind: 'found', symbol: nearest[0]! } : { kind: 'ambiguous' };
}

function withTarget(call: CallRef, target: FoundTarget): CallRef {
  if (target) return { ...call, to: target.id, evidence: 'resolved' };
  const nameOnly = { ...call, evidence: 'name-only' as const };
  delete nameOnly.to;
  return nameOnly;
}

function resolveCall(parsed: ParsedFile, files: Files, call: CallRef, trace: Tracer, lookup: SymbolLookup): CallRef {
  const from = lookup.byId(parsed.file.path, call.from);
  if (!from || !call.via) return withTarget(call, undefined);
  if (call.via === 'bare') {
    const same = sameFileTarget(parsed, call, from, lookup);
    if (same.kind === 'found') return withTarget(call, same.symbol);
    if (same.kind === 'ambiguous') return withTarget(call, undefined);
    return withTarget(call, importedTarget(call, parsed, trace, lookup));
  }
  if (call.via === 'this') return withTarget(call, thisTarget(parsed.file.path, call, from, lookup));
  const dotted = moduleOf(parsed, files, call);
  if (dotted) return withTarget(call, symbolAt(trace(dotted, call.name), lookup));
  return withTarget(
    call,
    namespaceTarget(call, parsed, trace, lookup) ??
      submoduleTarget(call, parsed, files, trace, lookup) ??
      constructedMember(call, parsed, from, trace, lookup),
  );
}

/** Resolves calls in `paths`; every other file keeps its current calls. */
export function resolveCalls(files: Files, paths: ReadonlySet<string>, trace: Tracer): Map<string, CallRef[]> {
  const lookup = new SymbolLookup(files);
  const out = new Map<string, CallRef[]>();
  for (const path of paths) {
    const parsed = files.get(path);
    if (!parsed) continue;
    out.set(
      path,
      parsed.calls.map((call) => resolveCall(parsed, files, call, trace, lookup)),
    );
  }
  return out;
}

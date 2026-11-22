import type { CallRef, CodeSymbol } from '../model.js';
import type { ParsedFile } from '../parse.js';
import type { Found, Tracer } from './trace.js';

type Files = ReadonlyMap<string, ParsedFile>;
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
        byName.set(leaf, [...(byName.get(leaf) ?? []), symbol]);
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

/** A bare call to a function defined in the same file: the nearest visible definition, or ambiguous. */
function sameFileTarget(file: string, call: CallRef, from: CodeSymbol, lookup: SymbolLookup): SameFile {
  const candidates = lookup.byName(file, call.name).filter((s) => s.kind === 'function');
  const visible = candidates.filter((s) => s.path.length === 1 || isPrefix(s.path.slice(0, -1), from.path));
  if (!visible.length) return { kind: 'none' };
  const depth = Math.max(...visible.map((s) => s.path.length));
  const nearest = visible.filter((s) => s.path.length === depth);
  return nearest.length === 1 ? { kind: 'found', symbol: nearest[0]! } : { kind: 'ambiguous' };
}

/** The top-level function a proven export binding points at; anything else proves no call target. */
function symbolAt(found: Found, lookup: SymbolLookup): FoundTarget {
  if (typeof found !== 'object') return undefined;
  const symbols = lookup.byName(found.file, found.binding).filter((s) => s.kind === 'function' && s.path.length === 1);
  return symbols.length === 1 ? symbols[0] : undefined;
}

/** A bare call bound to an imported name, through barrels to the function that defines it. */
function importedTarget(call: CallRef, parsed: ParsedFile, trace: Tracer, lookup: SymbolLookup): FoundTarget {
  const targets = parsed.imports
    .filter((imp) => imp.kind === 'import' && imp.status === 'resolved' && imp.resolved)
    .flatMap((imp) =>
      (imp.names ?? [])
        .filter((name) => name.local === call.name && !name.typeOnly && name.imported !== '*')
        .map((name) => symbolAt(trace(imp.resolved!, name.imported), lookup)),
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

/** `this.name()` to the one method that name in the enclosing class. */
function thisTarget(file: string, call: CallRef, from: CodeSymbol, lookup: SymbolLookup): FoundTarget {
  const owner = classOwner(file, from, lookup);
  if (!owner) return undefined;
  const methods = lookup
    .byName(file, call.name)
    .filter((s) => s.kind === 'method' && s.path.length === owner.path.length + 1 && isPrefix(owner.path, s.path));
  return methods.length === 1 ? methods[0] : undefined;
}

/** `ns.name()` where `ns` is a resolved `import * as ns`. */
function namespaceTarget(call: CallRef, parsed: ParsedFile, trace: Tracer, lookup: SymbolLookup): FoundTarget {
  if (!call.receiver) return undefined;
  const bindings = parsed.imports.flatMap((imp) =>
    imp.kind === 'import' && imp.status === 'resolved' && imp.resolved
      ? (imp.names ?? []).filter((name) => name.local === call.receiver && name.imported === '*' && !name.typeOnly).map((name) => ({ imp, name }))
      : [],
  );
  if (bindings.length !== 1) return undefined;
  return symbolAt(trace(bindings[0]!.imp.resolved!, call.name), lookup);
}

function withTarget(call: CallRef, target: FoundTarget): CallRef {
  if (target) return { ...call, to: target.id, evidence: 'resolved' };
  const nameOnly = { ...call, evidence: 'name-only' as const };
  delete nameOnly.to;
  return nameOnly;
}

function resolveCall(parsed: ParsedFile, call: CallRef, trace: Tracer, lookup: SymbolLookup): CallRef {
  const from = lookup.byId(parsed.file.path, call.from);
  if (!from || !call.via) return withTarget(call, undefined);
  if (call.via === 'bare') {
    const same = sameFileTarget(parsed.file.path, call, from, lookup);
    if (same.kind === 'found') return withTarget(call, same.symbol);
    if (same.kind === 'ambiguous') return withTarget(call, undefined);
    return withTarget(call, importedTarget(call, parsed, trace, lookup));
  }
  if (call.via === 'this') return withTarget(call, thisTarget(parsed.file.path, call, from, lookup));
  return withTarget(call, namespaceTarget(call, parsed, trace, lookup));
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
      parsed.calls.map((call) => resolveCall(parsed, call, trace, lookup)),
    );
  }
  return out;
}

import type { JsMeaning } from '../js-scope.js';
import type { CallRef, ClassInfo, CodeRange, CodeSymbol } from '../model.js';
import type { ParsedFile } from '../parse.js';
import { dispatchOf } from './dispatch.js';
import { pythonCallTarget } from './python-calls.js';
import type { Found, Tracer } from './trace.js';

type Files = ReadonlyMap<string, ParsedFile>;
type FoundTarget = CodeSymbol | undefined;

const OTHER: JsMeaning = { kind: 'other' };

const before = (a: { line: number; column: number }, b: { line: number; column: number }): boolean => a.line < b.line || (a.line === b.line && a.column < b.column);

/** Whether a point is inside a range; the end position is past its last character. */
const inside = (at: { line: number; column: number }, range: { start: { line: number; column: number }; end: { line: number; column: number } }): boolean =>
  !before(at, range.start) && before(at, range.end);

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

/** The one function symbol of this file whose leaf name matches and whose range starts where the binding starts. */
function definedTarget(file: string, name: string, start: { line: number; column: number }, lookup: SymbolLookup): FoundTarget {
  const matches = lookup
    .byName(file, name)
    .filter((s) => s.kind === 'function' && s.range.start.line === start.line && s.range.start.column === start.column);
  return matches.length === 1 ? matches[0] : undefined;
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

/**
 * Whether a `this.name()` in `call` reaches a callable member of the enclosing class: an instance method in an
 * instance context, a `static` one where `this` is the constructor. A getter, an abstract member or a signature has no
 * body, and a computed member whose key is no proven string or symbol may be the name, so none of those proves a
 * target. A name declared twice on the same side is no single target.
 */
function callableThrough(info: ClassInfo, fromStatic: boolean, call: CallRef): boolean {
  if ((fromStatic ? info.unknownStatic : info.unknownInstance) || info.nonCallable?.includes(call.name)) return false;
  const total = info.members.filter((member) => member === call.name).length;
  const statics = info.statics?.filter((member) => member === call.name).length ?? 0;
  return (fromStatic ? statics : total - statics) === 1;
}

/**
 * `this.name()` to the one method of that name in the class whose `this` it is (COD-59 compiler line: what the
 * TypeScript checker resolves), unless a rebind the source states keeps it name-only: the class or a resolved base
 * writes the member through `this`, a prototype write anywhere in the repo names it (an instance call), a write on a
 * constructor or another object names it (a static call), or the member is declared twice or under a computed key.
 */
function thisTarget(files: Files, call: CallRef, from: CodeSymbol, owner: CodeRange['start'] | undefined, lookup: SymbolLookup): FoundTarget {
  const info = owner && files.get(from.file)?.classes?.find((c) => c.range && c.range.start.line === owner.line && c.range.start.column === owner.column);
  const dispatch = dispatchOf(files);
  if (!info || info.writes.includes(call.name) || dispatch.jsBaseWrites(info, call.name)) return undefined;
  const fromStatic = info.staticRanges?.some((range) => inside(call.range.start, range)) ?? false;
  if (!callableThrough(info, fromStatic, call)) return undefined;
  if (fromStatic ? dispatch.js.staticWritten(call.name) : dispatch.js.instanceWritten(call.name)) return undefined;
  const methods = (info.methods ?? []).filter((m) => m.name === call.name && !!m.static === fromStatic);
  return methods.length === 1 ? lookup.byId(from.file, methods[0]!.id) : undefined;
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

function resolveCall(parsed: ParsedFile, files: Files, call: CallRef, index: number, trace: Tracer, lookup: SymbolLookup): CallRef {
  const from = lookup.byId(parsed.file.path, call.from);
  if (!from || !call.via) return withTarget(call, undefined);
  if (parsed.file.lang === 'python') return withTarget(call, pythonCallTarget(parsed, files, call, from, trace));
  const scope = parsed.scopes?.[index];
  const meaning = scope?.callee ?? OTHER;
  if (call.via === 'bare') {
    if (meaning.kind === 'def') return withTarget(call, definedTarget(parsed.file.path, call.name, meaning.start, lookup));
    return withTarget(call, meaning.kind === 'import' ? importedTarget(call, parsed, trace, lookup) : undefined);
  }
  if (call.via === 'this') return withTarget(call, thisTarget(files, call, from, scope?.owner, lookup));
  return withTarget(call, scope?.receiver?.kind === 'import' ? namespaceTarget(call, parsed, trace, lookup) : undefined);
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
      parsed.calls.map((call, index) => resolveCall(parsed, files, call, index, trace, lookup)),
    );
  }
  return out;
}

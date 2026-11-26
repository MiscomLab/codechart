import type { CallRef, CodeSymbol, Import, ImportedName } from '../model.js';
import type { ParsedFile } from '../parse.js';
import type { PyBinding } from '../python/module-scope.js';
import { submoduleIn, type Found, type Tracer } from './trace.js';

type Files = ReadonlyMap<string, ParsedFile>;

/** What a name means at a call site, from the one binding Python would use; undefined when that is not provable. */
type Meaning =
  | { kind: 'def'; scope: string }
  | { kind: 'import'; imp: Import; name: ImportedName }
  | { kind: 'dotted'; imports: Import[] }
  | { kind: 'built'; ctor: string; chain: string[] }
  | undefined;

const isPrefix = (prefix: readonly string[], path: readonly string[]) => prefix.length <= path.length && prefix.every((part, i) => path[i] === part);
const holds = (outer: CodeSymbol, inner: CodeSymbol) =>
  (outer.range.start.line < inner.range.start.line || (outer.range.start.line === inner.range.start.line && outer.range.start.column <= inner.range.start.column)) &&
  (outer.range.end.line > inner.range.end.line || (outer.range.end.line === inner.range.end.line && outer.range.end.column >= inner.range.end.column));

/**
 * The scopes a name is looked up in from a caller, innermost first: the caller's own body, then each enclosing
 * function, then the module. Class bodies are skipped, as Python skips them for code inside their methods.
 */
function scopeChain(parsed: ParsedFile, caller: CodeSymbol, at: CallRef['range']['start']): string[] {
  const body = parsed.defs?.find((def) => def.id === caller.id)?.body;
  const header = !!body && before(at, body);
  const deferred = parsed.deferred?.some((range) => inside(at, range)) ?? false;
  const owner = executingOwner(parsed, caller);
  // A deferred expression in a class body or a class-executed header is unprovable: the class body it would skip may
  // still hold a same-named binding, and the nested scope is not modelled. Only the enclosing type-parameter/function
  // scopes remain; the module is not claimed either.
  if (deferred && (caller.kind === 'class' || (header && owner?.kind === 'class'))) return headerChain(parsed, caller, true).slice(0, -1);
  if (header) return headerChain(parsed, caller, deferred);
  const chain = [caller.id];
  for (let depth = caller.path.length - 1; depth >= 1; depth--) {
    const outer = parsed.symbols.find((s) => s.path.length === depth && isPrefix(s.path, caller.path) && holds(s, caller));
    if (outer && outer.kind !== 'class') chain.push(outer.id);
  }
  return [...chain, ''];
}

/** The def or class whose body executes `caller`'s statement: its parent by path and range, whatever the caller's kind. */
function executingOwner(parsed: ParsedFile, caller: CodeSymbol): CodeSymbol | undefined {
  const parent = caller.path.slice(0, -1);
  if (!parent.length) return undefined;
  return parsed.symbols.find((s) => s.path.length === parent.length && isPrefix(s.path, parent) && holds(s, caller) && (s.kind === 'class' || s.kind === 'function' || s.kind === 'method'));
}

/**
 * A def's header (parameter defaults, annotations) or class header (bases, keywords) runs before its body, in the
 * scope that executes the statement: the nearest enclosing def/class's scope. For a class owner that is its body,
 * order-filtered by binding starts; for a def owner it is the function's body. A deferred expression skips a class
 * owner's body.
 */
function headerChain(parsed: ParsedFile, caller: CodeSymbol, deferred: boolean): string[] {
  const owner = executingOwner(parsed, caller);
  const chain = [`${caller.id}#typeparams`];
  const from = owner ?? caller;
  if (owner && !(deferred && owner.kind === 'class')) chain.push(owner.id);
  for (let depth = from.path.length - 1; depth >= 1; depth--) {
    const outer = parsed.symbols.find((s) => s.path.length === depth && isPrefix(s.path, from.path) && holds(s, from));
    if (outer && outer.kind !== 'class') chain.push(outer.id);
  }
  return [...chain, ''];
}

function meaning(parsed: ParsedFile, name: string, chain: readonly string[], at: CallRef['range']['start'] | undefined): Meaning {
  const bindings: readonly PyBinding[] = parsed.bindings ?? [];
  for (let i = 0; i < chain.length; i++) {
    // A star import can rebind any name of its scope, at a point the parse does not order.
    if (bindings.some((b) => b.scope === chain[i] && b.name === '*')) return undefined;
    const scoped = bindings.filter((b) => b.scope === chain[i] && b.name === name);
    if (!scoped.length) continue;
    // A class body binds names in order: a later binding cannot be what an earlier header or body call reaches.
    const classScope = parsed.symbols.some((s) => s.id === chain[i] && s.kind === 'class');
    const ordered = classScope && at ? scoped.filter((b) => !b.start || before(b.start, at)) : scoped;
    if (classScope && !ordered.length) return undefined;
    const found = ordered.filter((b) => visible(b, at));
    if (!found.length) continue;
    // `import a.b` and `import a.c` both bind the package `a`; the dotted path decides which module a call reaches.
    if (found.every((b) => b.dotted)) return { kind: 'dotted', imports: found.map((b) => parsed.imports[b.import!]!) };
    if (found.length !== 1) return undefined;
    const [b] = found as [PyBinding];
    if (b.kind === 'def') return { kind: 'def', scope: b.scope };
    if (b.kind === 'other') return b.built ? { kind: 'built', ctor: b.built, chain: chain.slice(i) } : undefined;
    const imp = parsed.imports[b.import!];
    const bound = imp?.names?.find((n) => n.local === name);
    return imp && bound ? { kind: 'import', imp, name: bound } : undefined;
  }
  return undefined;
}

/** Whether a binding is in scope at a call: type parameters have per-binding visibility windows (PEP 695). */
const visible = (binding: PyBinding, at: CallRef['range']['start'] | undefined): boolean => {
  if (!at) return true;
  if (binding.within && !binding.within.some((range) => inside(at, range))) return false;
  return !binding.except?.some((range) => inside(at, range));
};

/** Whether a point is inside a tree-sitter range; the end position is past its last character. */
const inside = (at: CallRef['range']['start'], range: { start: CallRef['range']['start']; end: CallRef['range']['start'] }): boolean =>
  !before(at, range.start) && before(at, range.end);

const before = (a: { line: number; column: number }, b: { line: number; column: number }): boolean =>
  a.line < b.line || (a.line === b.line && a.column < b.column);

/** The `def` or `class` a scope binds under `name`. */
function defIn(parsed: ParsedFile, scope: string, name: string): CodeSymbol | undefined {
  const owner = scope ? parsed.symbols.find((s) => s.id === scope) : undefined;
  if (scope && !owner) return undefined;
  const path = [...(owner?.path ?? []), name];
  const found = parsed.symbols.filter((s) => s.path.length === path.length && isPrefix(path, s.path) && (!owner || holds(owner, s)) && s.kind !== 'constant');
  return found.length === 1 ? found[0] : undefined;
}

/** The top-level function or class a proven export binding points at. */
function topLevel(files: Files, found: Found, kinds: readonly string[] = ['function', 'class']): CodeSymbol | undefined {
  if (typeof found !== 'object' || found.binding === '*') return undefined;
  const symbols = (files.get(found.file)?.symbols ?? []).filter((s) => s.path.length === 1 && s.path[0] === found.binding && kinds.includes(s.kind));
  return symbols.length === 1 ? symbols[0] : undefined;
}

/** The module file an import binding stands for, when the bound name is a module. */
function moduleOf(m: Meaning, trace: Tracer): string | undefined {
  if (m?.kind !== 'import') return undefined;
  if (m.name.imported === '*') return m.imp.status === 'resolved' ? m.imp.resolved : undefined;
  if (m.imp.packageFolder !== undefined) return m.name.definedIn;
  if (m.imp.status !== 'resolved' || !m.imp.resolved) return undefined;
  const found = trace(m.imp.resolved, m.name.imported);
  return typeof found === 'object' && found.binding === '*' ? found.file : undefined;
}

/** `a.b.c` from a module file: each further part must be a submodule of a package. */
function submodulePath(files: Files, file: string, parts: readonly string[]): string | undefined {
  let current = file;
  for (const part of parts) {
    const folder = current.match(/^(.*)\/__init__\.pyi?$/)?.[1];
    const next = folder === undefined ? undefined : submoduleIn(files, folder, part);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/** The class a constructed receiver was built from, and its one method `name`. */
function builtMethod(parsed: ParsedFile, files: Files, m: Meaning, name: string, at: CallRef['range']['start'], trace: Tracer): CodeSymbol | undefined {
  if (m?.kind !== 'built') return undefined;
  const ctor = meaning(parsed, m.ctor, m.chain, at);
  const cls =
    ctor?.kind === 'def'
      ? defIn(parsed, ctor.scope, m.ctor)
      : ctor?.kind === 'import' && ctor.name.imported !== '*' && ctor.imp.status === 'resolved' && ctor.imp.resolved
        ? topLevel(files, trace(ctor.imp.resolved, ctor.name.imported), ['class'])
        : undefined;
  if (cls?.kind !== 'class') return undefined;
  const methods = (files.get(cls.file)?.symbols ?? []).filter((s) => s.kind === 'method' && s.path.length === cls.path.length + 1 && isPrefix(cls.path, s.path) && s.path.at(-1) === name);
  return methods.length === 1 ? methods[0] : undefined;
}

/** The class whose method holds this call; a call in a class body belongs to the class. */
function classOwner(parsed: ParsedFile, from: CodeSymbol): CodeSymbol | undefined {
  if (from.kind === 'class') return from;
  if (from.kind !== 'method') return undefined;
  return parsed.symbols.find((s) => s.kind === 'class' && s.path.length === from.path.length - 1 && isPrefix(s.path, from.path) && holds(s, from));
}

function thisTarget(parsed: ParsedFile, call: CallRef, from: CodeSymbol): CodeSymbol | undefined {
  const owner = classOwner(parsed, from);
  if (!owner) return undefined;
  const methods = parsed.symbols.filter((s) => s.kind === 'method' && s.path.length === owner.path.length + 1 && isPrefix(owner.path, s.path) && s.path.at(-1) === call.name && holds(owner, s));
  return methods.length === 1 ? methods[0] : undefined;
}

/**
 * A Python call's target, proven from the binding Python itself would use at the call site: the nearest scope that binds
 * the name, which must bind it exactly once. Anything else (a parameter, a reassignment, two branches, a name no scope
 * binds) leaves the call name-only.
 */
export function pythonCallTarget(parsed: ParsedFile, files: Files, call: CallRef, from: CodeSymbol, trace: Tracer): CodeSymbol | undefined {
  if (call.via === 'this') return thisTarget(parsed, call, from);
  const chain = scopeChain(parsed, from, call.range.start);
  const at = call.range.start;
  if (call.via === 'bare') return bareTarget(parsed, files, call.name, chain, at, trace);
  return call.receiver ? memberTarget(parsed, files, call, chain, at, trace) : undefined;
}

function bareTarget(parsed: ParsedFile, files: Files, name: string, chain: readonly string[], at: CallRef['range']['start'], trace: Tracer): CodeSymbol | undefined {
  const m = meaning(parsed, name, chain, at);
  if (m?.kind === 'def') {
    const def = defIn(parsed, m.scope, name);
    return def && (def.kind === 'function' || def.kind === 'class') ? def : undefined;
  }
  if (m?.kind !== 'import' || m.name.imported === '*' || m.imp.status !== 'resolved' || !m.imp.resolved) return undefined;
  return topLevel(files, trace(m.imp.resolved, m.name.imported));
}

function memberTarget(parsed: ParsedFile, files: Files, call: CallRef, chain: readonly string[], at: CallRef['range']['start'], trace: Tracer): CodeSymbol | undefined {
  const receiver = call.receiver!;
  const m = meaning(parsed, receiver, chain, at);
  let module: string | undefined;
  if (call.receiverPath) {
    const dotted = call.receiverPath.join('.');
    if (m?.kind === 'dotted') module = m.imports.find((imp) => imp.spec === dotted && imp.status === 'resolved')?.resolved;
    else {
      const root = moduleOf(m, trace);
      module = root && submodulePath(files, root, call.receiverPath.slice(1));
    }
  } else {
    module = moduleOf(m, trace);
    if (!module) return builtMethod(parsed, files, m, call.name, at, trace);
  }
  return module ? topLevel(files, trace(module, call.name)) : undefined;
}

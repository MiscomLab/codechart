import type { CallRef, ClassInfo, CodeSymbol, Import, ImportedName } from '../model.js';
import type { ParsedFile } from '../parse.js';
import type { PyBinding } from '../python/module-scope.js';
import { dispatchOf } from './dispatch.js';
import { inheritedBase } from './python-inherit.js';
import { submoduleIn, type Found, type Tracer } from './trace.js';

type Files = ReadonlyMap<string, ParsedFile>;

/** Where a call sits, and whether it runs while its module is being imported. */
interface Site {
  at: CallRef['range']['start'];
  eager: boolean;
}

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

/**
 * A class or function body runs as ordinary code: a binding is provable only if it is the one unconditional binding of
 * the name and starts before the call, whichever scope the call sits in. The module scope allows several (dotted
 * imports) and orders only calls that run at import time: a function body runs after the module defined everything.
 * Otherwise the name may or may not exist at runtime: undefined, name-only.
 */
function scopedBindings(parsed: ParsedFile, scope: string, scoped: PyBinding[], site: Site | undefined): PyBinding[] | undefined {
  if (scoped.some((b) => b.conditional)) return undefined;
  const local = !!scope && parsed.symbols.some((s) => s.id === scope);
  if (local && scoped.length !== 1) return undefined;
  const at = site?.at;
  const ordered = at && (local || (!scope && site.eager)) ? scoped.filter((b) => !b.start || before(b.start, at)) : scoped;
  return ordered.length ? ordered : undefined;
}

function meaning(parsed: ParsedFile, name: string, chain: readonly string[], site: Site | undefined): Meaning {
  const at = site?.at;
  const bindings: readonly PyBinding[] = parsed.bindings ?? [];
  for (let i = 0; i < chain.length; i++) {
    // A star import can rebind any name of its scope, at a point the parse does not order.
    if (bindings.some((b) => b.scope === chain[i] && b.name === '*')) return undefined;
    const all = bindings.filter((b) => b.scope === chain[i] && b.name === name && !b.attr && visible(b, at));
    // An inherited type parameter is only what a method body sees when the method binds nothing of its own: a `def`,
    // an assignment or a parameter of the name wins (PEP 695).
    const scoped = all.some((b) => !b.inherited) ? all.filter((b) => !b.inherited) : all;
    if (!scoped.length) continue;
    const found = scopedBindings(parsed, chain[i]!, scoped, site);
    if (!found) return undefined;
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

/**
 * The top-level function or class a proven export binding points at. The file must bind the name exactly once, and the
 * binding must be a definition: a decorated name is the decorator's result, and one under `if False:` never ran, so an
 * import of it fails before any call. A module attribute call (`strict`) also needs the binding to have run at all: an
 * attribute read of one that never ran raises rather than calling anything.
 */
function topLevel(files: Files, found: Found, kinds: readonly string[] = ['function', 'class'], strict = false): CodeSymbol | undefined {
  if (typeof found !== 'object' || found.binding === '*') return undefined;
  const parsed = files.get(found.file);
  const bindings = (parsed?.bindings ?? []).filter((b) => b.scope === '' && b.name === found.binding && !b.alias);
  if (bindings.length !== 1) return undefined;
  const bound = bindings[0]!;
  if (bound.kind !== 'def' || bound.never || (strict && bound.conditional)) return undefined;
  const symbols = (parsed?.symbols ?? []).filter((s) => s.path.length === 1 && s.path[0] === found.binding && kinds.includes(s.kind));
  const symbol = symbols.length === 1 ? symbols[0] : undefined;
  return symbol && !submoduleShadowed(files, symbol) ? symbol : undefined;
}

/** The package folder a `__init__` module sits in, or undefined for a file that cannot own submodules. */
const packageFolder = (file: string): string | undefined => (file.endsWith('/__init__.py') ? file.slice(0, -'/__init__.py'.length) : undefined);

/**
 * Whether a top-level name of a package `__init__.py` is the package's attribute at run time: any file of the repo that
 * imports the submodule of that name makes CPython set it on the package, replacing the function or class.
 */
function submoduleShadowed(files: Files, target: CodeSymbol): boolean {
  const folder = packageFolder(target.file);
  const name = target.path.at(-1)!;
  const submodule = folder === undefined ? undefined : submoduleIn(files, folder, name);
  return submodule !== undefined && dispatchOf(files).pythonSubmoduleImported(submodule);
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

/**
 * The class a constructed receiver was built from, and its one method `name`. A `metaclass=` keyword or a `__new__`
 * anywhere in the class's chain may return an object that is not an instance, so such a receiver proves no method.
 */
function builtMethod(parsed: ParsedFile, files: Files, m: Meaning, name: string, site: Site, trace: Tracer): CodeSymbol | undefined {
  if (m?.kind !== 'built') return undefined;
  const ctor = meaning(parsed, m.ctor, m.chain, site);
  const cls =
    ctor?.kind === 'def'
      ? defIn(parsed, ctor.scope, m.ctor)
      : ctor?.kind === 'import' && ctor.name.imported !== '*' && ctor.imp.status === 'resolved' && ctor.imp.resolved
        ? topLevel(files, trace(ctor.imp.resolved, ctor.name.imported), ['class'])
        : undefined;
  if (cls?.kind !== 'class') return undefined;
  const classFile = files.get(cls.file);
  const info = classFile?.classes?.find((c) => c.id === cls.id);
  if (!info || !plainConstructor(files, info)) return undefined;
  const methods = (classFile?.symbols ?? []).filter((s) => s.kind === 'method' && s.path.length === cls.path.length + 1 && isPrefix(cls.path, s.path) && s.path.at(-1) === name);
  return methods.length === 1 && undisturbed(files, classFile, cls, name) ? methods[0] : undefined;
}

/** Whether constructing the class provably runs its own `__init__`: no `metaclass=`, no `__new__`, and no outside write. */
function plainConstructor(files: Files, info: ClassInfo): boolean {
  const dispatch = dispatchOf(files);
  if (dispatch.pythonMemberWritten('__new__')) return false;
  return !dispatch.chainSatisfies(info, (found) => !!found.metaclass || found.members.includes('__new__'));
}

/** The class whose method holds this call; a call in a class body belongs to the class. */
function classOwner(parsed: ParsedFile, from: CodeSymbol): CodeSymbol | undefined {
  if (from.kind === 'class') return from;
  if (from.kind !== 'method') return undefined;
  return parsed.symbols.find((s) => s.kind === 'class' && s.path.length === from.path.length - 1 && isPrefix(s.path, from.path) && holds(s, from));
}

/** A class's one binding of `name` is a plain `def`: not rebound, deleted, decorated, conditional or set on an instance. */
function plainMethod(parsed: ParsedFile | undefined, cls: CodeSymbol, name: string): boolean {
  const scoped = (parsed?.bindings ?? []).filter((b) => b.scope === cls.id && b.name === name);
  return scoped.length === 1 && scoped[0]!.kind === 'def' && !scoped[0]!.conditional;
}

/**
 * Whether `name` on an instance of `cls` is that class's plain method: also not written on any object in the repo
 * (`K.f = …`, `k.f = …`, `setattr(k, 'f', …)`), not bound by a class extending it by name or sitting before it in a
 * subclass's MRO, not written through `self` by a base class, not taken from another class with an opaque base, and not
 * intercepted by a `__getattribute__`, `__new__` or `__class__` written anywhere. A base the repo does not hold may bind
 * or intercept it, so an unresolved base leaves the call name-only.
 */
function undisturbed(files: Files, parsed: ParsedFile | undefined, cls: CodeSymbol, name: string): boolean {
  const dispatch = dispatchOf(files);
  if (!parsed || !plainMethod(parsed, cls, name) || dispatch.pythonMemberWritten(name)) return false;
  if (dispatch.pythonMemberWritten('__getattribute__') || dispatch.pythonMemberWritten('__class__') || dispatch.pythonMemberWritten('__new__')) return false;
  if (dispatch.pythonOpaqueBound(name)) return false;
  const info = parsed.classes?.find((c) => c.id === cls.id);
  if (!info || dispatch.chainSatisfies(info, (found) => found.members.includes('__getattribute__'))) return false;
  return !dispatch.subclassBinds(info.name, name) && !dispatch.baseWrites(info, name);
}

/** Whether a call runs while its module is being imported: in module code, class bodies and the headers of both. */
function runsAtImport(parsed: ParsedFile, symbol: CodeSymbol): boolean {
  const owner = executingOwner(parsed, symbol);
  return !owner || (owner.kind === 'class' && runsAtImport(parsed, owner));
}

function eagerCall(parsed: ParsedFile, caller: CodeSymbol, at: CallRef['range']['start']): boolean {
  if (parsed.lambdas?.some((range) => inside(at, range))) return false;
  const body = parsed.defs?.find((def) => def.id === caller.id)?.body;
  if (body && before(at, body)) return runsAtImport(parsed, caller);
  return (caller.kind === 'class' || caller.kind === 'module' || caller.kind === 'constant') && runsAtImport(parsed, caller);
}

/** The one method `name` of a class. */
function methodOf(parsed: ParsedFile, cls: CodeSymbol, name: string): CodeSymbol | undefined {
  const methods = parsed.symbols.filter((s) => s.kind === 'method' && s.path.length === cls.path.length + 1 && isPrefix(cls.path, s.path) && s.path.at(-1) === name && holds(cls, s));
  return methods.length === 1 ? methods[0] : undefined;
}

function thisTarget(parsed: ParsedFile, files: Files, call: CallRef, from: CodeSymbol): CodeSymbol | undefined {
  // `self` and `cls` are bound in a method's body only: not in a class body, nor in the method's own header.
  const body = parsed.defs?.find((def) => def.id === from.id)?.body;
  if (from.kind !== 'method' || (body && before(call.range.start, body))) return undefined;
  const owner = classOwner(parsed, from);
  // A method object read as a value elsewhere may be called with another `self`, so nothing in it is provable.
  if (!owner || dispatchOf(files).pythonEscaped(from.path.at(-1)!)) return undefined;
  if (!parsed.classes?.find((c) => c.id === owner.id)?.members.includes(call.name)) {
    const base = inheritedBase(parsed, files, owner, call.name);
    return base && undisturbed(files, parsed, base, call.name) ? methodOf(parsed, base, call.name) : undefined;
  }
  if (!undisturbed(files, parsed, owner, call.name)) return undefined;
  return methodOf(parsed, owner, call.name);
}

/**
 * A Python call's target, proven from the binding Python itself would use at the call site: the nearest scope that binds
 * the name, which must bind it exactly once. Anything else (a parameter, a reassignment, two branches, a name no scope
 * binds) leaves the call name-only.
 */
export function pythonCallTarget(parsed: ParsedFile, files: Files, call: CallRef, from: CodeSymbol, trace: Tracer): CodeSymbol | undefined {
  if (call.via === 'this') return thisTarget(parsed, files, call, from);
  const chain = scopeChain(parsed, from, call.range.start);
  const at = call.range.start;
  const site = { at, eager: eagerCall(parsed, from, at) };
  if (call.via === 'bare') return bareTarget(parsed, files, call.name, chain, site, trace);
  return call.receiver ? memberTarget(parsed, files, call, chain, site, trace) : undefined;
}

function bareTarget(parsed: ParsedFile, files: Files, name: string, chain: readonly string[], site: Site, trace: Tracer): CodeSymbol | undefined {
  const m = meaning(parsed, name, chain, site);
  if (m?.kind === 'def') {
    const def = defIn(parsed, m.scope, name);
    if (!def || (def.kind !== 'function' && def.kind !== 'class')) return undefined;
    // A top-level name of a package `__init__.py` is not what `import pkg.name` leaves on the package.
    if (def.path.length !== 1) return def;
    if (submoduleShadowed(files, def)) return undefined;
    return def.kind === 'function' && dispatchOf(files).pythonModuleWritten(parsed.file.path, name) ? undefined : def;
  }
  if (m?.kind !== 'import' || m.name.imported === '*' || m.imp.status !== 'resolved' || !m.imp.resolved) return undefined;
  const target = topLevel(files, trace(m.imp.resolved, m.name.imported));
  // `from b import f` reaches a module function only if no file rebinds a module's attribute f.
  return target && target.kind === 'function' && dispatchOf(files).pythonModuleWritten(target.file, name) ? undefined : target;
}

function memberTarget(parsed: ParsedFile, files: Files, call: CallRef, chain: readonly string[], site: Site, trace: Tracer): CodeSymbol | undefined {
  const receiver = call.receiver!;
  const m = meaning(parsed, receiver, chain, site);
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
    if (!module) return builtMethod(parsed, files, m, call.name, site, trace);
  }
  if (!module) return undefined;
  const target = topLevel(files, trace(module, call.name), undefined, true);
  // A module attribute call reaches the function only if no file rebinds that module's attribute of that name.
  return target && target.kind === 'function' && dispatchOf(files).pythonModuleWritten(module, call.name) ? undefined : target;
}

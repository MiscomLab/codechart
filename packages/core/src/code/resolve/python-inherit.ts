import type { ClassInfo, CodeRange, CodeSymbol } from '../model.js';
import type { ParsedFile } from '../parse.js';
import type { PyBinding } from '../python/module-scope.js';
import { dispatchOf, type Dispatch } from './dispatch.js';

type Files = ReadonlyMap<string, ParsedFile>;

const before = (a: CodeRange['start'], b: CodeRange['start']): boolean => a.line < b.line || (a.line === b.line && a.column < b.column);

const binds = (info: ClassInfo, name: string): boolean => info.members.includes(name) || info.members.includes('*') || info.writes.includes(name) || info.writes.includes('*');

/**
 * What a metaclass must not define or have written, or it could change the class a base list builds or what it binds.
 * Its `__getattribute__` and `__getattr__` only intercept reads on the class object, never `self.f()`, which walks the MRO.
 */
const META_HOOKS = ['__new__', '__init__', '__prepare__', '__call__'];

/** The one binding of a module-scope name, when nothing else binds it. */
const soleBinding = (parsed: ParsedFile, name: string): PyBinding | undefined => {
  const all = (parsed.bindings ?? []).filter((b) => b.scope === '' && b.name === name && !b.attr && !b.alias);
  return all.length === 1 && !all[0]!.conditional && !all[0]!.never ? all[0] : undefined;
};

/** Whether a decorator is the stdlib `dataclass`: `from dataclasses import dataclass` or `import dataclasses`, never rebound. */
function stdlibDataclass(parsed: ParsedFile, decorator: string): boolean {
  const name = decorator.startsWith('dataclasses.') ? 'dataclasses' : decorator;
  const bound = soleBinding(parsed, name);
  const imp = bound?.kind === 'import' ? parsed.imports[bound.import!] : undefined;
  const imported = imp?.names?.find((n) => n.local === name);
  if (!imp || imp.spec !== 'dataclasses' || imp.status !== 'external' || !imported || bound?.dotted) return false;
  return decorator === 'dataclasses.dataclass' ? imported.imported === '*' : decorator === 'dataclass' && imported.imported === 'dataclass';
}

/** Whether a metaclass is a local class whose chain is local up to `type` and that hooks nothing of class creation. */
function plainMetaclass(dispatch: Dispatch, name: string, seen = new Set<ClassInfo>()): boolean {
  const found = dispatch.classesNamed(name);
  if (found.length !== 1 || seen.has(found[0]!)) return false;
  const [meta] = found as [ClassInfo];
  seen.add(meta);
  if (meta.metaclass || meta.opaqueBase || meta.qualifiedBase || meta.decorators?.length) return false;
  if (META_HOOKS.some((hook) => binds(meta, hook) || dispatch.pythonMemberWritten(hook))) return false;
  return meta.bases.every((base) => base === 'type' || plainMetaclass(dispatch, base, seen));
}

/** Whether a class of `info`'s resolved base chain is built by a metaclass that could shape its subclasses. */
function metaclassed(dispatch: Dispatch, info: ClassInfo, seen = new Set<ClassInfo>()): boolean {
  if (seen.has(info)) return false;
  seen.add(info);
  if (info.metaclass && !(info.metaclassName && plainMetaclass(dispatch, info.metaclassName))) return true;
  return info.bases.some((base) => dispatch.classesNamed(base).some((found) => metaclassed(dispatch, found, seen)));
}

/**
 * The local class the one plain-identifier base of `cls` names, when the binding of that name live at the class statement
 * is provable: every module-scope binding of it before the statement is unconditional and the last is a plain `class`.
 * Later rebinds do not matter (the base is evaluated once), a binding that is an import, a value or a star import leaves it
 * name-only. A decorator other than the stdlib `dataclass` may return another class, so a decorated `cls` is name-only.
 */
function localBase(parsed: ParsedFile, cls: CodeSymbol, info: ClassInfo): CodeSymbol | undefined {
  if (cls.path.length !== 1 || info.bases.length !== 1 || info.qualifiedBase || info.metaclass || info.opaqueBase) return undefined;
  if (info.decorators?.some((decorator) => !stdlibDataclass(parsed, decorator))) return undefined;
  const name = info.bases[0]!;
  const all = (parsed.bindings ?? []).filter((b) => b.scope === '' && !b.attr && !b.alias);
  if (all.some((b) => b.name === '*')) return undefined;
  const live = all.filter((b) => b.name === name && (!b.start || before(b.start, cls.range.start)));
  if (live.at(-1)?.kind !== 'def' || live.some((b) => b.conditional || b.never || !b.start)) return undefined;
  const found = parsed.symbols.filter((s) => s.path.length === 1 && s.path[0] === name && s.kind !== 'constant');
  return found.length === 1 && found[0]!.kind === 'class' && before(found[0]!.range.start, cls.range.start) ? found[0] : undefined;
}

/**
 * The local class `owner` inherits `name` from when `self.name()` is provably looked up there: `owner` binds nothing of
 * that name, no `__getattribute__` sits in its chain, nothing writes `__bases__`, no metaclass in its chain can shape a
 * subclass, and its one base is a local class the module never rebinds by write.
 */
export function inheritedBase(parsed: ParsedFile, files: Files, owner: CodeSymbol, name: string): CodeSymbol | undefined {
  const info = parsed.classes?.find((c) => c.id === owner.id);
  const dispatch = dispatchOf(files);
  if (!info || binds(info, name) || dispatch.pythonMemberWritten('__getattribute__') || dispatch.pythonMemberWritten('__bases__')) return undefined;
  if (dispatch.chainSatisfies(info, (found) => found.members.includes('__getattribute__')) || metaclassed(dispatch, info)) return undefined;
  const base = localBase(parsed, owner, info);
  return base && !dispatch.pythonModuleWritten(parsed.file.path, base.path[0]!) ? base : undefined;
}

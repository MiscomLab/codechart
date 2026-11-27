import { CONTAINER_BASES } from '../js-types.js';
import type { ClassInfo } from '../model.js';
import type { ParsedFile } from '../parse.js';
import { createTracer, submoduleIn, type Tracer } from './trace.js';

type Files = ReadonlyMap<string, ParsedFile>;

/**
 * Which classes extend which, by name, across the linked files, and which member names any file writes. A base is
 * matched by its last identifier alone, so the index over-approximates: a same-named class elsewhere counts as a
 * subclass. That can only turn a proven call into a name-only one, never the reverse.
 */
export class Dispatch {
  private readonly named = new Map<string, ClassInfo[]>();
  private readonly extending = new Map<string, ClassInfo[]>();
  private readonly fileOf = new Map<ClassInfo, string>();
  private readonly langOf = new Map<ClassInfo, string>();
  private readonly pythonWrites = new Set<string>();
  private readonly pythonModuleWrites = new Map<string, Set<string>>();
  private readonly pythonAnyModuleWrites = new Set<string>();
  /** Every module a Python import anywhere names, and every folder above one, so a submodule a package gains is known. */
  private readonly pythonImportedModules = new Set<string>();
  private readonly pythonImportedFolders = new Set<string>();
  private readonly pythonEscapes = new Set<string>();
  private readonly jsWrites = new Set<string>();
  private readonly jsEscapes = new Set<string>();
  private readonly pythonOpaque = new Set<string>();
  private readonly jsOpaque = new Set<string>();
  private readonly subclassCache = new Map<string, boolean>();
  /** A class extends a container or has an opaque base: a container-typed slot can hold one. */
  private jsContainerUnsafe = false;
  /** A class declares an index signature: a `Record`-typed slot can hold one. */
  private jsRecordUnsafe = false;

  constructor(private readonly files: Files) {
    for (const parsed of files.values()) if (parsed.file.lang === 'python') this.addSubmoduleImports(parsed);
    const trace = createTracer(files);
    for (const parsed of files.values()) this.addFile(parsed);
    for (const infos of this.named.values()) for (const info of infos) this.addExtending(info, trace);
    this.markOpaque();
    this.markExemptions();
  }

  /** Indexes one file's classes, writes, module writes and escaped names. */
  private addFile(parsed: ParsedFile): void {
    const python = parsed.file.lang === 'python';
    for (const info of parsed.classes ?? []) {
      this.fileOf.set(info, parsed.file.path);
      this.langOf.set(info, parsed.file.lang);
      push(this.named, info.name, info);
    }
    // A write anywhere rebinds the member on objects of any class: the resolver may only prove a method no code of the
    // repo replaces. `*` stands for a name no parse could read (a computed one).
    const written = python ? parsed.attrWrites : parsed.memberWrites;
    for (const name of written ?? []) (python ? this.pythonWrites : this.jsWrites).add(name);
    if (python) this.addModuleWrites(parsed);
    for (const name of parsed.escapes ?? []) (python ? this.pythonEscapes : this.jsEscapes).add(name);
  }

  /** Puts each class under every base name it extends, resolved through its file's imports and re-exports. */
  private addExtending(info: ClassInfo, trace: Tracer): void {
    for (const base of info.bases) push(this.extending, this.canonicalBase(info, base, trace), info);
  }

  /** Records each module a Python import names and the folders above it, so a submodule can be known from any file. */
  private addSubmoduleImports(parsed: ParsedFile): void {
    for (const imp of parsed.imports) {
      if (imp.status !== 'resolved' || !imp.resolved) continue;
      this.pythonImportedModules.add(imp.resolved);
      const parts = imp.resolved.split('/');
      for (let i = 1; i < parts.length; i++) this.pythonImportedFolders.add(parts.slice(0, i).join('/'));
    }
  }

  /** Whether any Python file imports `file` or a module inside its package: CPython then sets it on the parent package. */
  pythonSubmoduleImported(file: string): boolean {
    if (this.pythonImportedModules.has(file)) return true;
    const folder = file.endsWith('/__init__.py') ? file.slice(0, -'/__init__.py'.length) : undefined;
    return folder !== undefined && this.pythonImportedFolders.has(folder);
  }

  /** Whether a JS/TS class can sit in a `Record`- or container-typed slot, so that computed-write exemption proves nothing. */
  private markExemptions(): void {
    for (const infos of this.named.values()) {
      for (const info of infos) {
        if (this.langOf.get(info) === 'python') continue;
        if (info.indexSignature) this.jsRecordUnsafe = true;
        if (info.opaqueBase || info.bases.some((base) => CONTAINER_BASES.has(base))) this.jsContainerUnsafe = true;
      }
    }
  }

  /** Records the names an opaque-base class binds, so any instance could sit in front of a same-named method. */
  private markOpaque(): void {
    for (const infos of this.named.values()) {
      for (const info of infos) {
        const opaque = info.opaqueBase || (this.langOf.get(info) !== 'python' && this.unresolvedBase(info));
        if (!opaque) continue;
        const target = this.langOf.get(info) === 'python' ? this.pythonOpaque : this.jsOpaque;
        for (const member of [...info.members, ...info.writes]) target.add(member);
      }
    }
  }

  /** The classes called `name`, wherever they are defined. */
  classesNamed(name: string): readonly ClassInfo[] {
    return this.named.get(name) ?? [];
  }

  /** Whether any Python file of the repo writes the attribute `member`, or writes an attribute it cannot name. */
  pythonMemberWritten(member: string): boolean {
    return this.pythonWrites.has(member) || this.pythonWrites.has('*');
  }

  /** Whether `file`'s module namespace binds `member` through an attribute write elsewhere, or through an unreadable one. */
  pythonModuleWritten(file: string | undefined, member: string): boolean {
    const written = file === undefined ? undefined : this.pythonModuleWrites.get(file);
    return this.pythonAnyModuleWrites.has(member) || this.pythonAnyModuleWrites.has('*') || (!!written && (written.has(member) || written.has('*')));
  }

  /** Records each module attribute write against the file the written module resolves to; an unprovable one counts for all. */
  private addModuleWrites(parsed: ParsedFile): void {
    if (!parsed.moduleWrites?.length) return;
    const modules = moduleBindings(parsed);
    for (const { receiver, name, import: index, dotted } of parsed.moduleWrites) {
      // Without an import, a receiver naming no module binding is unprovable, never a proven value.
      const file = index === undefined ? (modules.get(receiver) ?? null) : importModule(this.files, parsed, index, receiver, !!dotted);
      // A write on a module outside the repo (stdlib, site-packages) cannot touch a module here; a value binds no module.
      if (file === EXTERNAL || file === undefined) continue;
      if (!file) {
        this.pythonAnyModuleWrites.add(name);
        continue;
      }
      const names = this.pythonModuleWrites.get(file);
      if (names) names.add(name);
      else this.pythonModuleWrites.set(file, new Set([name]));
    }
  }

  /** Whether any Python file reads the method object `member` as a value, or any method object at all (`*`). */
  pythonEscaped(member: string): boolean {
    return this.pythonEscapes.has(member) || this.pythonEscapes.has('*');
  }

  /** Whether any Python class with an opaque base binds `member`: it may sit in front of any class in an MRO. */
  pythonOpaqueBound(member: string): boolean {
    return this.pythonOpaque.has(member) || this.pythonOpaque.has('*');
  }

  /**
   * Whether any JS/TS file of the repo writes the member `member`, or writes a member it cannot name. A typed computed
   * write (`*record`, `*container`) counts as `*` only when its repo-wide guard trips: a class can then sit in the slot.
   */
  jsMemberWritten(member: string): boolean {
    if (this.jsWrites.has(member) || this.jsWrites.has('*')) return true;
    return (this.jsRecordUnsafe && this.jsWrites.has('*record')) || (this.jsContainerUnsafe && this.jsWrites.has('*container'));
  }

  /** Whether any JS/TS file reads the method object `member` as a value, or any method object at all (`*`). */
  jsEscaped(member: string): boolean {
    return this.jsEscapes.has(member) || this.jsEscapes.has('*');
  }

  /** Whether any JS/TS class with an opaque base binds `member`: it may sit in front of any class in a prototype chain. */
  jsOpaqueBound(member: string): boolean {
    return this.jsOpaque.has(member) || this.jsOpaque.has('*');
  }

  /**
   * Whether a class that extends `name`, directly or through others, binds `member`; also whether any class in such a
   * subclass's whole base chain, other than `name` and its own ancestors, does. An earlier base in the MRO wins.
   */
  subclassBinds(name: string, member: string): boolean {
    const key = `${name}\0${member}`;
    let found = this.subclassCache.get(key);
    if (found === undefined) {
      found = this.computeSubclassBinds(name, member);
      this.subclassCache.set(key, found);
    }
    return found;
  }

  private computeSubclassBinds(name: string, member: string): boolean {
    if (!this.classesNamed(name).length) return false;
    const allowed = new Set<ClassInfo>();
    for (const root of this.classesNamed(name)) this.addChain(root, allowed);
    return this.subclassesOf(name).some((sub) => this.chainBinds(sub, member, allowed));
  }

  /** `info` and every class of its base chain the repo holds. */
  private addChain(info: ClassInfo, out: Set<ClassInfo>, seen = new Set<ClassInfo>()): void {
    if (seen.has(info)) return;
    seen.add(info);
    out.add(info);
    for (const base of info.bases) for (const found of this.classesNamed(base)) this.addChain(found, out, seen);
  }

  /** Every class whose base chain reaches `name`, directly or through others. */
  private subclassesOf(name: string, seen = new Set<ClassInfo>()): ClassInfo[] {
    const out: ClassInfo[] = [];
    for (const sub of this.extending.get(name) ?? []) {
      if (seen.has(sub)) continue;
      seen.add(sub);
      out.push(sub);
      out.push(...this.subclassesOf(sub.name, seen));
    }
    return out;
  }

  /** Whether `info` or a base reaches `member`, ignoring the classes `allowed` (the class itself and its ancestors). */
  private chainBinds(info: ClassInfo, member: string, allowed: ReadonlySet<ClassInfo>, seen = new Set<ClassInfo>()): boolean {
    if (allowed.has(info) || seen.has(info)) return false;
    seen.add(info);
    if (binds(info, member)) return true;
    return info.bases.some((base) => {
      if (base === 'object') return false;
      const found = this.classesNamed(base);
      return !found.length || found.some((b) => this.chainBinds(b, member, allowed, seen));
    });
  }

  /** A base name resolved through an import or re-export of the class's own file, when that is provable. */
  private canonicalBase(info: ClassInfo, base: string, trace: Tracer): string {
    const parsed = this.files.get(this.fileOf.get(info) ?? '');
    if (!parsed) return base;
    const bindings = parsed.imports.filter(
      (imp) => imp.kind === 'import' && imp.status === 'resolved' && imp.resolved && (imp.names ?? []).some((n) => n.local === base && !n.typeOnly && n.imported !== '*'),
    );
    if (bindings.length !== 1) return base;
    const imp = bindings[0]!;
    const name = imp.names!.find((n) => n.local === base)!;
    const found = trace(imp.resolved!, name.imported);
    return typeof found === 'object' && found.binding !== '*' ? found.binding : base;
  }

  /** Whether a JS/TS class's base names no class of the repo, so its real ancestors are unknown. */
  private unresolvedBase(info: ClassInfo): boolean {
    return info.bases.some((base) => base && base !== 'object' && !this.classesNamed(base).length);
  }

  /** Whether a class named `name` or one it extends, directly or through others, writes `member`; unresolved bases count. */
  baseWrites(info: ClassInfo, member: string, seen = new Set<ClassInfo>()): boolean {
    if (seen.has(info)) return false;
    seen.add(info);
    return info.bases.some((base) => {
      if (base === 'object') return false;
      const found = this.classesNamed(base);
      return !found.length || found.some((b) => b.writes.includes(member) || this.baseWrites(b, member, seen));
    });
  }

  /** Whether `info` or a class it extends, directly or through others, satisfies `test`; an unresolved base counts. */
  chainSatisfies(info: ClassInfo, test: (found: ClassInfo) => boolean, seen = new Set<ClassInfo>()): boolean {
    if (seen.has(info)) return false;
    seen.add(info);
    if (test(info)) return true;
    return info.bases.some((base) => {
      if (base === 'object') return false;
      const found = this.classesNamed(base);
      return !found.length || found.some((b) => this.chainSatisfies(b, test, seen));
    });
  }
}

const binds = (info: ClassInfo, member: string): boolean => info.members.includes(member) || info.members.includes('*') || info.writes.includes(member);

/** A module binding whose import is known to sit outside the repo: writing to it cannot rebind a module here. */
const EXTERNAL = '\0external';

/**
 * The module file an import binding names: the imported module, a submodule a from-import binds, EXTERNAL, undefined
 * when the binding holds a value, or null when the parse cannot prove which.
 */
function importModule(files: Files, parsed: ParsedFile, index: number, name: string, dotted: boolean): string | null | undefined {
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
function dottedPackage(files: Files, imp: ParsedFile['imports'][number]): string | undefined {
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

/** The module file each module-scope import binding names, `EXTERNAL` for one outside the repo, null when unprovable. */
function moduleBindings(parsed: ParsedFile): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const b of parsed.bindings ?? []) {
    if (b.scope !== '' || b.kind !== 'import' || b.import === undefined) continue;
    const imp = parsed.imports[b.import];
    const module = b.dotted || !imp ? null : imp.status === 'resolved' && imp.resolved ? imp.resolved : imp.status === 'external' ? EXTERNAL : null;
    const known = out.get(b.name);
    if (known === undefined) out.set(b.name, module);
    else if (known !== module) out.set(b.name, null);
  }
  return out;
}

function push(map: Map<string, ClassInfo[]>, key: string, info: ClassInfo): void {
  const list = map.get(key);
  if (list) list.push(info);
  else map.set(key, [info]);
}

const cache = new WeakMap<Files, Dispatch>();

/** The class index of one link pass; `files` is fresh for each pass, so the index never outlives its snapshot. */
export function dispatchOf(files: Files): Dispatch {
  let found = cache.get(files);
  if (!found) cache.set(files, (found = new Dispatch(files)));
  return found;
}

import { CONTAINER_BASES } from '../js-types.js';
import type { ClassInfo } from '../model.js';
import type { ParsedFile } from '../parse.js';
import { bindingModules, escapeClosure } from './python-escapes.js';
import { EXTERNAL_MODULE, createTracer, importModule, moduleBindings, modulesNamed, submoduleFile, unresolvedNames, type Tracer } from './trace.js';

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
  /** Modules `'*'`-written because they escape, whose reachable modules are written too. */
  private readonly pythonEscapedModules = new Set<string>();
  /** Every module a Python import anywhere names, and every folder above one, so a submodule a package gains is known. */
  private readonly pythonImportedModules = new Set<string>();
  private readonly pythonImportedFolders = new Set<string>();
  private readonly pythonEscapes = new Set<string>();
  private readonly jsWrites = new Set<string>();
  private readonly jsEscapes = new Set<string>();
  private readonly pythonOpaque = new Set<string>();
  private readonly jsOpaque = new Set<string>();
  private readonly subclassCache = new Map<string, boolean>();
  /** A class declares an index signature: a `Record`-typed slot can hold one. */
  private jsRecordUnsafe = false;

  constructor(private readonly files: Files) {
    for (const parsed of files.values()) if (parsed.file.lang === 'python') this.addSubmoduleImports(parsed);
    const trace = createTracer(files);
    for (const parsed of files.values()) this.addFile(parsed);
    // Every module an escaped module reaches is written too, once every module write of the pass is known.
    for (const file of escapeClosure(files, this.pythonEscapedModules, trace)) this.addModuleWrite(file, '*');
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

  /** Whether a JS/TS class can sit in a `Record`-typed slot, so that the record exemption proves nothing. */
  private markExemptions(): void {
    for (const infos of this.named.values()) {
      for (const info of infos) {
        if (this.langOf.get(info) === 'python') continue;
        if (info.indexSignature) this.jsRecordUnsafe = true;
      }
    }
  }

  /** Whether a container-typed slot can hold an instance of `info`: its own chain names a container or an unknown base. */
  private containerUnsafe(info: ClassInfo): boolean {
    // A JS instance has one chain, so only the dispatched class's own ancestors can sit in its container-typed slot.
    return this.chainSatisfies(info, (found) => !!found.opaqueBase || found.bases.some((base) => CONTAINER_BASES.has(base)));
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

  /**
   * Records each module attribute write against the file the written module resolves to; an unprovable one counts for
   * all. A literal `sys.modules` key or an unresolved import is resolved to every repo module of that name, since CPython
   * can load any file whose path matches it; an external module touches nothing here.
   */
  private addModuleWrites(parsed: ParsedFile): void {
    if (!parsed.moduleWrites?.length) return;
    const modules = moduleBindings(parsed);
    for (const write of parsed.moduleWrites) {
      const files = this.writtenModules(parsed, modules, write);
      // A module's new `__class__` replaces every attribute, so it is a `*` write.
      const name = write.name === '__class__' ? '*' : write.name;
      // A write on a module outside the repo (stdlib, site-packages) cannot touch a module here; a value binds no module.
      if (files === undefined) continue;
      if (files === null) {
        this.pythonAnyModuleWrites.add(name);
        continue;
      }
      for (const file of files) {
        this.addModuleWrite(file, name);
        if (write.escaped && name === '*') this.pythonEscapedModules.add(file);
      }
    }
  }

  /** The files a module write can land on, `null` when it cannot name one, `undefined` when it names no repo module. */
  private writtenModules(
    parsed: ParsedFile,
    modules: ReadonlyMap<string, string | null>,
    write: NonNullable<ParsedFile['moduleWrites']>[number],
  ): string[] | null | undefined {
    // A literal `sys.modules` key names its module like an absolute import; `__name__` is this file.
    if (write.module !== undefined) return modulesNamed(this.files, write.module);
    if (write.current) return [parsed.file.path];
    // A from-import names the module it imports from, or the submodule its name binds.
    if (write.binding) return bindingModules(this.files, parsed, write);
    if (write.import === undefined) return this.boundModules(modules, write.receiver);
    const imp = parsed.imports[write.import];
    if (!imp || imp.status === 'external') return undefined;
    if (imp.status !== 'resolved' || !imp.resolved) {
      const names = unresolvedNames(imp, parsed.file.path, write.receiver, !!write.dotted);
      if (names === null) return null;
      // The chain below the binding names submodules of the module the binding could be: `plugin.run` is no module.
      const modules = write.chain?.length ? names.map((name) => `${name}.${write.chain!.join('.')}`) : names;
      return modules.flatMap((name) => modulesNamed(this.files, name));
    }
    const root = importModule(this.files, parsed, write.import, write.receiver, !!write.dotted);
    if (root === undefined) return undefined;
    if (root === EXTERNAL_MODULE) return undefined;
    if (!root) return null;
    const file = write.chain?.length ? submoduleFile(this.files, root, write.chain) : root;
    return file === undefined ? undefined : [file];
  }

  /** The files a module-scope binding names: its module, none for a value, `null` when the name is not provable. */
  private boundModules(modules: ReadonlyMap<string, string | null>, receiver: string): string[] | null | undefined {
    const file = modules.get(receiver);
    return file === undefined || file === null ? null : file === EXTERNAL_MODULE ? undefined : [file];
  }

  private addModuleWrite(file: string, name: string): void {
    const names = this.pythonModuleWrites.get(file);
    if (names) names.add(name);
    else this.pythonModuleWrites.set(file, new Set([name]));
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
   * write (`*record`, `*container`) counts as `*` only when its guard trips: the record one repo-wide, the container
   * one only when the dispatched class's own chain can hold a container instance. An `*assign` marker counts as `*`
   * only while a file can give an object an own `__proto__` property (`*ownproto`), which `Object.assign` copies.
   */
  jsMemberWritten(member: string, info: ClassInfo): boolean {
    if (this.jsWrites.has(member) || this.jsWrites.has('*')) return true;
    if (this.jsWrites.has('*assign') && this.jsWrites.has('*ownproto')) return true;
    if (this.jsRecordUnsafe && this.jsWrites.has('*record')) return true;
    return this.jsWrites.has('*container') && this.containerUnsafe(info);
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

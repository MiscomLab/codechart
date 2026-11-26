import type { ClassInfo } from '../model.js';
import type { ParsedFile } from '../parse.js';

type Files = ReadonlyMap<string, ParsedFile>;

/**
 * Which classes extend which, by name, across the linked files, and which member names any file writes. A base is
 * matched by its last identifier alone, so the index over-approximates: a same-named class elsewhere counts as a
 * subclass. That can only turn a proven call into a name-only one, never the reverse.
 */
export class Dispatch {
  private readonly named = new Map<string, ClassInfo[]>();
  private readonly extending = new Map<string, ClassInfo[]>();
  private readonly pythonWrites = new Set<string>();
  private readonly jsWrites = new Set<string>();

  constructor(files: Files) {
    for (const parsed of files.values()) {
      for (const info of parsed.classes ?? []) {
        push(this.named, info.name, info);
        for (const base of info.bases) push(this.extending, base, info);
      }
      // A write anywhere rebinds the member on objects of any class: the resolver may only prove a method no
      // code of the repo replaces. `*` stands for a name no parse could read (a computed one).
      const written = parsed.file.lang === 'python' ? parsed.attrWrites : parsed.memberWrites;
      for (const name of written ?? []) (parsed.file.lang === 'python' ? this.pythonWrites : this.jsWrites).add(name);
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

  /** Whether any JS/TS file of the repo writes the member `member`, or writes a member it cannot name. */
  jsMemberWritten(member: string): boolean {
    return this.jsWrites.has(member) || this.jsWrites.has('*');
  }

  /** Whether a class that extends `name`, directly or through others, declares or writes `member`. */
  subclassBinds(name: string, member: string, seen = new Set<string>()): boolean {
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return (this.extending.get(name) ?? []).some((sub) => binds(sub, member) || this.subclassBinds(sub.name, member, seen));
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

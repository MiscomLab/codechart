import type { MemberWrite, ProtoBind } from '../js-protos.js';
import type { ClassInfo } from '../model.js';
import type { ParsedFile } from '../parse.js';

type Files = ReadonlyMap<string, ParsedFile>;

/** The names reachable from `seeds` through `from → name` bindings, seeds included. */
function closure(seeds: Iterable<string>, dependents: ReadonlyMap<string, string[]>): Set<string> {
  const found = new Set(seeds);
  const queue = [...found];
  for (const name of queue) {
    for (const next of dependents.get(name) ?? []) {
      if (found.has(next)) continue;
      found.add(next);
      queue.push(next);
    }
  }
  return found;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** An imported or re-exported name is the name the other module exports it as. */
function importEdges(parsed: ParsedFile): ProtoBind[] {
  return parsed.imports
    .filter((imp) => !imp.typeOnly && (imp.kind === 'import' || imp.kind === 'export'))
    .flatMap((imp) => (imp.names ?? []).filter((name) => !name.typeOnly && name.imported !== '*' && name.local !== '*').map((name) => ({ name: name.local, from: name.imported })));
}

/** What a plain write's receiver is once the repo's prototype names are known: a getter's, a prototype's, or neither. */
function receiverKind(receiver: string | undefined, names: ReadonlySet<string>, parents: ReadonlySet<string>): 'proto' | 'getter' | 'plain' {
  if (receiver === undefined) return 'plain';
  return parents.has(receiver) ? 'getter' : names.has(receiver) ? 'proto' : 'plain';
}

/**
 * The member writes of the repo's JS/TS files, as the compiler line reads them (COD-59). Computed writes record
 * nothing. A named write is `proto` when it is written on a prototype expression or on a name bound to one anywhere
 * in the repo, `plain` otherwise, and both when the receiver is a prototype getter. A `proto` write rebinds the
 * member on instances (so it vetoes an instance `this.f()`); a `plain` one on a constructor or any other object can
 * only reach a static `this.f()`, and a getter's result may be a constructor's parent, so it reaches both.
 */
export class JsWrites {
  private readonly instance = new Set<string>();
  private readonly statics = new Set<string>();

  constructor(files: Files) {
    const dependents = new Map<string, string[]>();
    const direct: string[] = [];
    const getters: string[] = [];
    const writes: MemberWrite[] = [];
    for (const parsed of files.values()) {
      if (parsed.file.lang === 'python') continue;
      writes.push(...(parsed.memberWrites ?? []));
      for (const edge of [...(parsed.protoBinds ?? []), ...importEdges(parsed)]) {
        if (edge.from !== undefined) push(dependents, edge.from, edge.name);
        else {
          direct.push(edge.name);
          if (edge.getter) getters.push(edge.name);
        }
      }
    }
    const names = closure(direct, dependents);
    const parents = closure(getters, dependents);
    for (const write of writes) {
      const kind = write.kind === 'plain' ? receiverKind(write.receiver, names, parents) : write.kind;
      if (kind !== 'plain') this.instance.add(write.name);
      if (kind !== 'proto') this.statics.add(write.name);
    }
  }

  /** Whether any write rebinds `member` on a prototype, so an instance `this.member()` can reach something else. */
  instanceWritten(member: string): boolean {
    return this.instance.has(member);
  }

  /** Whether any write rebinds `member` on a constructor or another object, which a static `this.member()` can reach. */
  staticWritten(member: string): boolean {
    return this.statics.has(member);
  }
}

/** Whether a resolved base of `info`, or one of its resolved bases, writes `member` through `this`; unresolved bases count for nothing. */
export function resolvedBaseWrites(info: ClassInfo, member: string, classesNamed: (name: string) => readonly ClassInfo[], seen = new Set<ClassInfo>()): boolean {
  if (seen.has(info)) return false;
  seen.add(info);
  return info.bases.some((base) => classesNamed(base).some((found) => found.writes.includes(member) || resolvedBaseWrites(found, member, classesNamed, seen)));
}

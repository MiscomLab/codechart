import type { ParsedFile } from './parse.js';

/** Reverse indexes for one snapshot of the code layer (Live map #8). */
export interface ReverseIndex {
  /** Resolved target file → files importing it. */
  importers: Map<string, Set<string>>;
  /** Call or import name → files using it. */
  names: Map<string, Set<string>>;
}

function add(map: Map<string, Set<string>>, key: string, file: string): void {
  const files = map.get(key);
  if (files) files.add(file);
  else map.set(key, new Set([file]));
}

export function buildReverse(files: Iterable<ParsedFile>): ReverseIndex {
  const importers = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  for (const parsed of files) {
    const file = parsed.file.path;
    for (const imp of parsed.imports) {
      if (imp.status === 'resolved' && imp.resolved) add(importers, imp.resolved, file);
      for (const name of imp.names ?? []) add(names, name.local, file);
    }
    for (const call of parsed.calls) add(names, call.name, file);
  }
  return { importers, names };
}

/** The files that import something in `seeds`, transitively: a barrel passes a change on to its importers. */
export function importerClosure(index: ReverseIndex, seeds: Iterable<string>): Set<string> {
  const affected = new Set(seeds);
  const queue = [...affected];
  for (const path of queue) {
    for (const importer of index.importers.get(path) ?? []) {
      if (affected.has(importer)) continue;
      affected.add(importer);
      queue.push(importer);
    }
  }
  return affected;
}

/** Files using any of `names` in a call or an import binding. */
export function nameUsers(index: ReverseIndex, names: Iterable<string>): Set<string> {
  const files = new Set<string>();
  for (const name of names) for (const file of index.names.get(name) ?? []) files.add(file);
  return files;
}

/**
 * The definition, export and member names a file contributes to the name index: a class's members and the members its
 * code writes decide what a member call elsewhere reaches, like the class's own symbols.
 */
export function namesOf(parsed: ParsedFile | undefined): Set<string> {
  const names = new Set<string>();
  if (!parsed) return names;
  for (const symbol of parsed.symbols) names.add(symbol.path[symbol.path.length - 1]!);
  for (const exported of parsed.exports.names) names.add(exported.name);
  for (const info of parsed.classes ?? []) for (const name of [...info.members, ...info.writes]) names.add(name);
  for (const name of parsed.attrWrites ?? []) names.add(name);
  for (const name of parsed.memberWrites ?? []) names.add(name);
  for (const write of parsed.moduleWrites ?? []) names.add(write.name);
  for (const name of parsed.escapes ?? []) names.add(name);
  return names;
}

/**
 * The repo paths each file's import resolution checked for, and the reverse. A file appearing or leaving changes a
 * resolution only if the resolver asked about it: an unknown import, a `.ts` shadowing a `.js`, an earlier `paths`
 * target or an ambiguous package source all show up here.
 */
export class Probes {
  private readonly byFile = new Map<string, Set<string>>();
  private readonly byPath = new Map<string, Set<string>>();

  /** Replaces what `file` checked for. */
  set(file: string, paths: ReadonlySet<string>): void {
    this.delete(file);
    this.byFile.set(file, new Set(paths));
    for (const path of paths) add(this.byPath, path, file);
  }

  delete(file: string): void {
    for (const path of this.byFile.get(file) ?? []) {
      const files = this.byPath.get(path)!;
      files.delete(file);
      if (!files.size) this.byPath.delete(path);
    }
    this.byFile.delete(file);
  }

  /** Files whose resolution checked for any of `paths`. */
  users(paths: Iterable<string>): Set<string> {
    const files = new Set<string>();
    for (const path of paths) for (const file of this.byPath.get(path) ?? []) files.add(file);
    return files;
  }
}

import type { ParsedFile } from './parse.js';

/** Reverse indexes for one snapshot of the code layer (Live map #8). */
export interface ReverseIndex {
  /** Resolved target file → files importing it. */
  importers: Map<string, Set<string>>;
  /** Unresolved import specifier → files that wrote it. */
  unknown: Map<string, Set<string>>;
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
  const unknown = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  for (const parsed of files) {
    const file = parsed.file.path;
    for (const imp of parsed.imports) {
      if (imp.status === 'resolved' && imp.resolved) add(importers, imp.resolved, file);
      if (imp.status === 'unknown') add(unknown, imp.spec, file);
      for (const name of imp.names ?? []) add(names, name.local, file);
    }
    for (const call of parsed.calls) add(names, call.name, file);
  }
  return { importers, unknown, names };
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

/** The definition and export names a file contributes to the name index. */
export function namesOf(parsed: ParsedFile | undefined): Set<string> {
  const names = new Set<string>();
  if (!parsed) return names;
  for (const symbol of parsed.symbols) names.add(symbol.path[symbol.path.length - 1]!);
  for (const exported of parsed.exports.names) names.add(exported.name);
  return names;
}

/** Files whose unknown imports are worth retrying when a file appears. */
export function unknownUsers(index: ReverseIndex): Set<string> {
  const files = new Set<string>();
  for (const users of index.unknown.values()) for (const file of users) files.add(file);
  return files;
}

const withoutExtension = (path: string): string => path.replace(/\.[^/.]+$/, '');

/**
 * Importers of resolved files an added file could shadow. Resolving `./foo` prefers `foo.ts` to `foo/index.ts`, so a
 * new `foo.ts` can change an import that already pointed at `foo/index.ts`; the reverse index finds those importers.
 */
export function shadowImporters(index: ReverseIndex, added: readonly string[]): Set<string> {
  const targets = [...index.importers.keys()];
  const files = new Set<string>();
  for (const path of added) {
    const stem = withoutExtension(path);
    for (const target of targets) {
      const targetStem = withoutExtension(target);
      if (targetStem !== stem && targetStem !== `${stem}/index`) continue;
      for (const importer of index.importers.get(target) ?? []) files.add(importer);
    }
  }
  return files;
}

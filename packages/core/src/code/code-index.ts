import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseCode, type ParsedFile } from './parse.js';
import { listCodeFiles, parseRepo, readCodeFile } from './repo.js';
import { buildReverse, importerClosure, nameUsers, namesOf, shadowImporters, unknownUsers, type ReverseIndex } from './reverse.js';
import { linkResolved, resolveImports } from './resolve/link.js';
import { createResolver } from './resolve/resolver.js';
import { isRelative } from './resolve/files.js';

export interface CodeIndexOptions {
  /** The config's `ignore` globs, as `parseRepo` takes them. */
  ignore?: readonly string[];
}

/** What one update touched; every path is repo-relative with `/`. */
export interface CodeUpdate {
  /** Files added, edited or removed by content hash. */
  changed: string[];
  /** Changed files parsed again: one file on the live path, more in bulk. */
  parsed: string[];
  /** Files outside `parsed` whose imports or calls changed through the ripple. */
  relinked: string[];
  /** Files that left the repo or became unreadable. */
  removed: string[];
}

export interface CodeIndex {
  readonly root: string;
  /** Every readable file of the code layer, sorted by path. */
  readonly files: readonly ParsedFile[];
  file(path: string): ParsedFile | undefined;
  /**
   * Re-reads `paths` (repo-relative or absolute) and the repo's file list, parses only files whose hash changed, and
   * re-matches only the files the change affects. With no paths, hashes every listed file (bulk mode).
   */
  update(paths?: readonly string[]): Promise<CodeUpdate>;
}

const CONFIG_FILE = /(^|\/)(package\.json|pnpm-workspace\.ya?ml|(?:ts|js)config[^/]*\.json)$/;
const sorted = (set: Iterable<string>): string[] => [...set].sort();

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

const emptyUpdate = (): CodeUpdate => ({ changed: [], parsed: [], relinked: [], removed: [] });

function repoPaths(root: string, paths: readonly string[]): Set<string> {
  const base = resolve(root);
  const out = new Set<string>();
  for (const path of paths) {
    const rel = relative(base, resolve(base, path)).split(sep).join('/');
    if (rel && rel !== '..' && !rel.startsWith('../')) out.add(rel);
  }
  return out;
}

/** The parts of an import that resolution decides; `definedIn` and line ranges do not count as a new resolution. */
const importShape = (imp: ParsedFile['imports'][number]) =>
  [imp.kind, imp.spec, imp.status, imp.resolved ?? '', imp.typeOnly ?? false, (imp.names ?? []).map((n) => [n.imported, n.local, n.typeOnly ?? false])] as const;

const sameImports = (a: readonly ParsedFile['imports'][number][], b: readonly ParsedFile['imports'][number][]): boolean =>
  isDeepStrictEqual(a.map(importShape), b.map(importShape));

const sameLinks = (a: ParsedFile | undefined, b: ParsedFile | undefined): boolean =>
  !!a && !!b && isDeepStrictEqual(a.imports, b.imports) && isDeepStrictEqual(a.calls, b.calls);

/** What other files can observe: the symbol identities, export bindings and whether the export list is complete. */
const surface = (parsed: ParsedFile): string =>
  JSON.stringify([
    parsed.symbols.map((s) => [s.id, s.kind]),
    parsed.exports.names.map((n) => [n.name, n.local ?? '']),
    parsed.exports.complete,
  ]);

class Index implements CodeIndex {
  private byPath: Map<string, ParsedFile>;
  private reverse: ReverseIndex;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly ignore: readonly string[],
    files: Map<string, ParsedFile>,
  ) {
    this.byPath = files;
    this.reverse = buildReverse(files.values());
  }

  get files(): readonly ParsedFile[] {
    return [...this.byPath.values()].sort((a, b) => (a.file.path < b.file.path ? -1 : 1));
  }

  file(path: string): ParsedFile | undefined {
    return this.byPath.get(path);
  }

  update(paths?: readonly string[]): Promise<CodeUpdate> {
    const run = this.queue.then(() => this.runUpdate(paths));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runUpdate(paths?: readonly string[]): Promise<CodeUpdate> {
    const listed = listCodeFiles(this.root, this.ignore);
    const listedSet = new Set(listed);
    const before = this.byPath;
    const next = new Map(before);
    const first = this.collect(listed, before, next);
    await this.parseChanged(paths, listed, listedSet, before, next, first);
    if (!first.changed.size) return emptyUpdate();
    return this.relink(listed, before, next, first);
  }

  /** Files added and removed since the last snapshot, and the removed ones deleted from `next`. */
  private collect(listed: readonly string[], before: Map<string, ParsedFile>, next: Map<string, ParsedFile>) {
    const listedSet = new Set(listed);
    const removed = new Set<string>();
    const added: string[] = [];
    for (const path of before.keys()) {
      if (listedSet.has(path)) continue;
      next.delete(path);
      removed.add(path);
    }
    for (const path of listed) if (!before.has(path)) added.push(path);
    const changed = new Set([...removed, ...added]);
    return { added, removed, changed, parsed: new Set<string>() };
  }

  /** Reads `paths` and the new files, parses the ones whose hash changed, and records what was removed. */
  private async parseChanged(
    paths: readonly string[] | undefined,
    listed: readonly string[],
    listedSet: ReadonlySet<string>,
    before: Map<string, ParsedFile>,
    next: Map<string, ParsedFile>,
    update: { added: string[]; removed: Set<string>; changed: Set<string>; parsed: Set<string> },
  ): Promise<void> {
    const touched = paths === undefined ? listed : [...repoPaths(this.root, paths)].filter((p) => listedSet.has(p));
    for (const path of new Set([...update.added, ...touched])) {
      const text = readCodeFile(this.root, path);
      if (text === undefined) {
        if (next.delete(path)) {
          update.removed.add(path);
          update.changed.add(path);
        }
        continue;
      }
      if (before.get(path)?.file.hash === hashOf(text)) continue;
      const parsed = await parseCode(path, text, before.get(path));
      if (!parsed) continue;
      next.set(path, parsed);
      update.parsed.add(path);
      update.changed.add(path);
    }
  }

  /** Re-resolves imports for the files a change can reach, then calls, and stores the new snapshot. */
  private relink(
    listed: readonly string[],
    before: Map<string, ParsedFile>,
    next: Map<string, ParsedFile>,
    update: { added: string[]; removed: Set<string>; changed: Set<string>; parsed: Set<string> },
  ): CodeUpdate {
    const resolver = createResolver(listed, (path) => readCodeFile(this.root, path));
    const configChanged = [...update.changed].some((path) => CONFIG_FILE.test(path));
    const imports = this.importCandidates(update, configChanged, next);
    const resolved = resolveImports([...next.values()], resolver, imports);
    const importChanged = this.importChanged(resolved, before, imports);
    const affected = this.affected(before, next, update.changed, importChanged);
    const definitions = new Set([...imports, ...affected]);
    const linked = linkResolved(resolved, { definitions, calls: affected });
    const after = new Map(linked.map((f) => [f.file.path, f]));
    const touched = new Set([...affected, ...definitions]);
    const relinked = sorted([...touched].filter((path) => !update.parsed.has(path) && next.has(path) && !sameLinks(before.get(path), after.get(path))));
    this.byPath = after;
    this.reverse = buildReverse(after.values());
    return {
      changed: sorted(update.changed),
      parsed: sorted(update.parsed),
      relinked,
      removed: sorted(update.removed),
    };
  }

  /** Files whose imports may resolve differently after this update. */
  private importCandidates(
    update: { added: string[]; removed: Set<string>; changed: Set<string>; parsed: Set<string> },
    configChanged: boolean,
    next: Map<string, ParsedFile>,
  ): Set<string> {
    const present = (path: string) => next.has(path);
    if (configChanged) return new Set([...next.keys()]);
    const imports = new Set([...update.parsed].filter(present));
    for (const path of update.removed) for (const importer of this.reverse.importers.get(path) ?? []) if (present(importer)) imports.add(importer);
    if (update.added.length) {
      for (const path of unknownUsers(this.reverse)) if (present(path)) imports.add(path);
      for (const path of shadowImporters(this.reverse, update.added)) if (present(path)) imports.add(path);
      // A paths alias or workspace entry can have several targets: an earlier missing target can appear anywhere.
      for (const parsed of next.values()) {
        if (parsed.imports.some((imp) => imp.status === 'resolved' && imp.resolved && !isRelative(imp.spec))) imports.add(parsed.file.path);
      }
    }
    // Changed files that are still present, including config files and files the ripple does not reach.
    for (const path of update.changed) if (present(path) && !update.removed.has(path)) imports.add(path);
    return imports;
  }

  /** Files whose import shape changed after re-resolution (line moves and `definedIn` do not count). */
  private importChanged(resolved: readonly ParsedFile[], before: Map<string, ParsedFile>, imports: ReadonlySet<string>): Set<string> {
    const changed = new Set<string>();
    for (const parsed of resolved) {
      if (!imports.has(parsed.file.path)) continue;
      if (!sameImports(before.get(parsed.file.path)?.imports ?? [], parsed.imports)) changed.add(parsed.file.path);
    }
    return changed;
  }

  /** Changed files, the files whose imports changed, their importers, and files using a name that changed. */
  private affected(before: Map<string, ParsedFile>, next: Map<string, ParsedFile>, changed: ReadonlySet<string>, importChanged: ReadonlySet<string>): Set<string> {
    const seeds = new Set(importChanged);
    for (const path of changed) {
      const old = before.get(path);
      const now = next.get(path);
      // A body or line edit changes no symbol identity and no export: importers cannot see it.
      if (!old || !now || surface(old) !== surface(now)) seeds.add(path);
    }
    const affected = importerClosure(this.reverse, seeds);
    for (const path of changed) if (next.has(path)) affected.add(path);
    const names = new Set<string>();
    for (const path of seeds) {
      for (const name of namesOf(before.get(path))) names.add(name);
      for (const name of namesOf(next.get(path))) names.add(name);
    }
    for (const path of nameUsers(this.reverse, names)) affected.add(path);
    for (const path of [...affected]) if (!next.has(path)) affected.delete(path);
    return affected;
  }
}

/** Opens the code layer of `root` and keeps it ready for one-file updates. */
export async function openCodeIndex(root: string, opts: CodeIndexOptions = {}): Promise<CodeIndex> {
  const files = await parseRepo(root, opts);
  return new Index(root, opts.ignore ?? [], new Map(files.map((f) => [f.file.path, f])));
}

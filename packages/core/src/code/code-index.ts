import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { parseCode, type ParsedFile } from './parse.js';
import type { PatternSets } from './patterns.js';
import { listCodeFiles, parseFiles, readCodeFile } from './repo.js';
import { buildReverse, importerClosure, nameUsers, namesOf, Probes, type ReverseIndex } from './reverse.js';
import { linkResolved, resolveImports } from './resolve/link.js';
import { pythonProbeKeys } from './resolve/python.js';
import { packageInits, sameImports, sameLinks, surface } from './surface.js';
import { createResolver, type Resolver } from './resolve/resolver.js';

export interface CodeIndexOptions {
  /** The config's `ignore` globs, as `parseRepo` takes them. */
  ignore?: readonly string[];
  /** Sets from `compilePatterns`, run on every parse, updates too. In use until the index is dropped; new patterns need a new index. */
  patterns?: PatternSets;
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

const configHash = (root: string, path: string): string | null => {
  const text = readCodeFile(root, path);
  return text === undefined ? null : hashOf(text);
};

const emptyUpdate = (): CodeUpdate => ({ changed: [], parsed: [], relinked: [], removed: [] });

/** An update in progress: what was added, removed, changed by hash and parsed again. */
interface Pending {
  added: string[];
  removed: Set<string>;
  changed: Set<string>;
  parsed: Set<string>;
}

interface Recording {
  resolver: Resolver;
  /** Per importing file, every path its resolutions checked for. */
  recorded: Map<string, Set<string>>;
  /** Every path a cached config lookup checked for or read, whichever file's resolution triggered it. */
  config: Set<string>;
}

function recordingResolver(root: string, listed: readonly string[]): Recording {
  const recorded = new Map<string, Set<string>>();
  const config = new Set<string>();
  let current: Set<string> | undefined;
  const inner = createResolver(listed, (path) => readCodeFile(root, path), { path: (path) => current?.add(path), config: (path) => config.add(path) });
  const recording = <T>(from: string, run: () => T): T => {
    recorded.set(from, (current = recorded.get(from) ?? new Set()));
    try {
      return run();
    } finally {
      current = undefined;
    }
  };
  const resolver: Resolver = {
    resolve: (from, spec, kind, context) => recording(from, () => inner.resolve(from, spec, kind, context)),
    ref: (ref) => recording(ref.file, () => inner.ref(ref)),
  };
  return { resolver, recorded, config };
}

function repoPaths(root: string, paths: readonly string[]): Set<string> {
  const base = resolve(root);
  const out = new Set<string>();
  for (const path of paths) {
    const rel = relative(base, resolve(base, path)).split(sep).join('/');
    if (rel && rel !== '..' && !rel.startsWith('../')) out.add(rel);
  }
  return out;
}

class Index implements CodeIndex {
  private byPath: Map<string, ParsedFile>;
  private reverse: ReverseIndex;
  private readonly probes = new Probes();
  /** Paths config lookups depend on; never shrinks between full re-resolves, so a stale entry costs time, not truth. */
  private configDeps: Set<string>;
  /** The content hash of each config path last time it was read, null when absent; catches edits to unlisted files. */
  private configHashes = new Map<string, string | null>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    private readonly ignore: readonly string[],
    private readonly patterns: PatternSets | undefined,
    files: Map<string, ParsedFile>,
    probed: ReadonlyMap<string, ReadonlySet<string>>,
    configDeps: Set<string>,
  ) {
    this.byPath = files;
    this.configDeps = configDeps;
    this.configHashes = new Map([...this.configDeps].map((path) => [path, configHash(root, path)]));
    this.reverse = buildReverse(files.values());
    for (const path of files.keys()) this.probes.set(path, probed.get(path) ?? new Set());
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
    const pending = this.collect(listed, listedSet, before, next);
    await this.parseChanged(paths, listed, listedSet, before, next, pending);
    // A project file such as pyproject.toml is not a code file, so only its hash shows it changed.
    for (const [path, hash] of this.configHashes) if (configHash(this.root, path) !== hash) pending.changed.add(path);
    if (!pending.changed.size) return emptyUpdate();
    return this.relink(listed, before, next, pending);
  }

  /** Files added and removed since the last snapshot, and the removed ones deleted from `next`. */
  private collect(listed: readonly string[], listedSet: ReadonlySet<string>, before: Map<string, ParsedFile>, next: Map<string, ParsedFile>): Pending {
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
    update: Pending,
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
      const parsed = await parseCode(path, text, before.get(path), { patterns: this.patterns });
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
    update: Pending,
  ): CodeUpdate {
    const { resolver, recorded, config } = recordingResolver(this.root, listed);
    const configChanged = [...update.changed].some((path) => CONFIG_FILE.test(path) || this.configDeps.has(path));
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
    for (const path of update.removed) this.probes.delete(path);
    for (const path of imports) this.probes.set(path, recorded.get(path) ?? new Set());
    this.configDeps = configChanged ? config : new Set([...this.configDeps, ...config]);
    this.configHashes = new Map([...this.configDeps].map((path) => [path, configHash(this.root, path)]));
    return {
      changed: sorted(update.changed),
      parsed: sorted(update.parsed),
      relinked,
      removed: sorted(update.removed),
    };
  }

  /** Files whose imports may resolve differently after this update. */
  private importCandidates(
    update: Pending,
    configChanged: boolean,
    next: Map<string, ParsedFile>,
  ): Set<string> {
    const present = (path: string) => next.has(path);
    if (configChanged) return new Set([...next.keys()]);
    const imports = new Set([...update.parsed].filter(present));
    // Only a resolution that checked for an added or removed path can come out differently.
    const keys = [...update.added, ...update.removed].flatMap((path) => [path, ...pythonProbeKeys(path)]);
    for (const path of this.probes.users(keys)) if (present(path)) imports.add(path);
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
    const beforeKeys = new Set(before.keys());
    const nextKeys = new Set(next.keys());
    for (const path of changed) {
      const old = before.get(path);
      const now = next.get(path);
      // A body or line edit changes no symbol identity and no export: importers cannot see it.
      if (!old || !now || surface(old, beforeKeys) !== surface(now, nextKeys)) seeds.add(path);
      // A module appearing under a package changes what `from pkg import name` finds, though the package file did not edit.
      for (const init of packageInits(path)) {
        const start = before.get(init);
        const now = next.get(init);
        if (start && now && surface(start, beforeKeys) !== surface(now, nextKeys)) seeds.add(init);
      }
    }
    const affected = importerClosure(this.reverse, seeds);
    for (const path of changed) if (next.has(path)) affected.add(path);
    const names = new Set<string>();
    for (const path of seeds) {
      for (const name of namesOf(before.get(path))) names.add(name);
      for (const name of namesOf(next.get(path))) names.add(name);
    }
    // A member write the parse cannot name (`*`) or a prototype binding (`*proto`), which can turn a write in any file
    // into a prototype write, can rebind any member, so every file with a member call is re-resolved.
    if ([...names].some((name) => name.startsWith('*'))) for (const path of next.keys()) affected.add(path);
    for (const path of nameUsers(this.reverse, names)) affected.add(path);
    for (const path of [...affected]) if (!next.has(path)) affected.delete(path);
    return affected;
  }
}

/** Opens the code layer of `root` and keeps it ready for one-file updates; links as `parseRepo` does, recording probes. */
export async function openCodeIndex(root: string, opts: CodeIndexOptions = {}): Promise<CodeIndex> {
  const listed = listCodeFiles(root, opts.ignore);
  const parsed = await parseFiles(root, listed, opts.patterns);
  const { resolver, recorded, config } = recordingResolver(root, listed);
  const resolved = resolveImports(parsed, resolver);
  const paths = new Set(resolved.map((f) => f.file.path));
  const files = linkResolved(resolved, { definitions: paths, calls: paths });
  return new Index(root, opts.ignore ?? [], opts.patterns, new Map(files.map((f) => [f.file.path, f])), recorded, config);
}

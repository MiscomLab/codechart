import { isDeepStrictEqual } from 'node:util';
import type { ParsedFile } from './parse.js';

/** What another file's linking reads of a parse: the surface a live update compares, and the shapes that prove it unchanged. */

/** The package `__init__.py` files whose submodule list a change to `path` can alter: its folder's, and a package's parent. */
export function packageInits(path: string): string[] {
  const parts = path.split('/');
  const name = parts.pop()!;
  const dirs = name === '__init__.py' ? [parts.join('/'), parts.slice(0, -1).join('/')] : [parts.join('/')];
  return dirs.filter(Boolean).map((dir) => `${dir}/__init__.py`);
}

/** The submodules a package `__init__.py` has: a file or folder directly under it, either of which can shadow its names. */
function submodulesOf(file: string, files: ReadonlySet<string>): string[] {
  const folder = file.endsWith('/__init__.py') ? file.slice(0, -'/__init__.py'.length) : undefined;
  if (folder === undefined) return [];
  const prefix = `${folder}/`;
  const names = new Set<string>();
  for (const path of files) {
    if (!path.startsWith(prefix) || path === file) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash > 0) names.add(rest.slice(0, slash));
    else if (rest.endsWith('.py')) names.add(rest.slice(0, -3));
  }
  return [...names].sort();
}

/**
 * What other files can observe: the symbol identities, export bindings, whether the export list is complete, the
 * top-level bindings `from … import` reads, and the class, member-write, escaped-name and submodule indexes call
 * resolution reads across files. A body or line edit changes none of these.
 */
export function surface(parsed: ParsedFile, files: ReadonlySet<string>): string {
  return JSON.stringify([
    parsed.symbols.map((s) => [s.id, s.kind]),
    [parsed.exports.names.map((n) => [n.name, n.local ?? '']), parsed.exports.complete],
    (parsed.bindings ?? []).filter((b) => b.scope === '').map((b) => [b.name, b.kind, !!b.conditional, !!b.dotted, !!b.alias, !!b.never]),
    (parsed.classes ?? []).map((c) => [c.id ?? '', c.name, c.bases, c.members, c.writes, c.metaclass ?? false, c.opaqueBase ?? false, c.statics ?? [], c.nonCallable ?? []]),
    [parsed.attrWrites ?? [], parsed.memberWrites ?? [], parsed.moduleWrites ?? [], parsed.escapes ?? []],
    submodulesOf(parsed.file.path, files),
  ]);
}

/** The parts of an import that resolution decides; `definedIn` and line ranges do not count as a new resolution. */
const importShape = (imp: ParsedFile['imports'][number]) =>
  [imp.kind, imp.spec, imp.status, imp.resolved ?? '', imp.packageFolder ?? '', imp.typeOnly ?? false, (imp.names ?? []).map((n) => [n.imported, n.local, n.typeOnly ?? false])] as const;

export const sameImports = (a: readonly ParsedFile['imports'][number][], b: readonly ParsedFile['imports'][number][]): boolean =>
  isDeepStrictEqual(a.map(importShape), b.map(importShape));

export const sameLinks = (a: ParsedFile | undefined, b: ParsedFile | undefined): boolean =>
  !!a && !!b && isDeepStrictEqual(a.imports, b.imports) && isDeepStrictEqual(a.calls, b.calls) && isDeepStrictEqual(a.refs, b.refs);

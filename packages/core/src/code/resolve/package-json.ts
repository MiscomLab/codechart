/** The `package.json` fields resolution reads. */
export interface PackageJson {
  name?: string;
  exports?: unknown;
  imports?: unknown;
  /** Entry fields in the order tried when there is no `exports`: `source`, `module`, `main`, `types`. */
  entries: string[];
  /** The config `extends: "<this package>"` reads when there is no `exports`. */
  tsconfig?: string;
  /** Names in `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`. */
  deps: Set<string>;
  workspaces: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

export function toPackageJson(raw: unknown): PackageJson | undefined {
  if (!isObject(raw)) return undefined;
  const entries = ['source', 'module', 'main', 'types', 'typings'].map((k) => raw[k]).filter((v): v is string => typeof v === 'string');
  const deps = new Set(
    ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => (isObject(raw[k]) ? Object.keys(raw[k]) : [])),
  );
  const ws = raw.workspaces;
  return {
    ...(typeof raw.name === 'string' && { name: raw.name }),
    ...('exports' in raw && { exports: raw.exports }),
    ...(typeof raw.tsconfig === 'string' && { tsconfig: raw.tsconfig }),
    ...(isObject(raw.imports) && { imports: raw.imports }),
    entries,
    deps,
    workspaces: isObject(ws) ? strings(ws.packages) : strings(ws),
  };
}

/** How a module is loaded: by `require()`, or by `import`, `export … from` and `import()`. */
export type LoadKind = 'import' | 'require';

/**
 * Conditions tried in `exports` and `imports`, best first: source-ish ones lead to the file a repo edits, then the
 * loader's own condition, `types` last because it usually names a declaration file. Other conditions (`browser`,
 * `worker`, custom ones) are not followed.
 */
const CONDITIONS: Record<LoadKind, readonly string[]> = {
  import: ['source', 'development', 'import', 'module', 'node', 'default', 'require', 'types'],
  require: ['source', 'development', 'require', 'node', 'default', 'import', 'module', 'types'],
};

function targets(target: unknown, star: string | undefined, conditions: readonly string[], depth = 0): string[] {
  if (typeof target === 'string') return [star === undefined ? target : target.replaceAll('*', star)];
  if (depth > 8) return [];
  if (Array.isArray(target)) return target.flatMap((t) => targets(t, star, conditions, depth + 1));
  if (!isObject(target)) return [];
  return conditions.flatMap((c) => (c in target ? targets(target[c], star, conditions, depth + 1) : []));
}

/** `exports` written as one target or as conditions only stands for `{ ".": … }`. */
function subpathMap(map: unknown): Record<string, unknown> {
  if (isObject(map) && Object.keys(map).some((k) => k.startsWith('.') || k.startsWith('#'))) return map;
  return { '.': map };
}

/** The `*` pattern key matching `key`, longest prefix first as Node orders them. */
function patternMatch(map: Record<string, unknown>, key: string): { pattern: string; star: string } | undefined {
  let best: { pattern: string; star: string } | undefined;
  for (const pattern of Object.keys(map)) {
    const at = pattern.indexOf('*');
    if (at < 0 || pattern.indexOf('*', at + 1) >= 0) continue;
    const [prefix, suffix] = [pattern.slice(0, at), pattern.slice(at + 1)];
    if (key.length < pattern.length || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    if (!best || prefix.length > best.pattern.indexOf('*') || (prefix.length === best.pattern.indexOf('*') && pattern.length > best.pattern.length)) {
      best = { pattern, star: key.slice(prefix.length, key.length - suffix.length) };
    }
  }
  return best;
}

/**
 * The targets an `exports` or `imports` map gives `key` (`.`, `./sub`, `#name`), best condition first.
 * Empty when no key matches or the match is `null` (the package hides that path).
 */
export function mapTargets(map: unknown, key: string, kind: LoadKind = 'import'): string[] {
  const subpaths = subpathMap(map);
  if (Object.hasOwn(subpaths, key) && !key.includes('*')) return targets(subpaths[key], undefined, CONDITIONS[kind]);
  const match = patternMatch(subpaths, key);
  return match ? targets(subpaths[match.pattern], match.star, CONDITIONS[kind]) : [];
}

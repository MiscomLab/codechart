import type { ParsedFile } from '../parse.js';
import type { ModuleEscape } from '../python/module-escapes.js';
import { EXTERNAL_MODULE, importModule, type Tracer } from './trace.js';

type Files = ReadonlyMap<string, ParsedFile>;

/** The files a from-import `__globals__` write lands on: the submodule the name binds, or the module it imports from. */
export function bindingModules(files: Files, parsed: ParsedFile, write: ModuleEscape): string[] | null | undefined {
  if (write.import === undefined) return undefined;
  const imp = parsed.imports[write.import];
  if (!imp || imp.status === 'external') return undefined;
  if (imp.status !== 'resolved' || !imp.resolved) return null;
  const module = importModule(files, parsed, write.import, write.receiver, false);
  return module && module !== EXTERNAL_MODULE ? [module] : [imp.resolved];
}

/** Every repo module an escaped module reaches, transitively: its submodules and the modules its import bindings name. */
export function escapeClosure(files: Files, escaped: ReadonlySet<string>, trace: Tracer): Set<string> {
  const seen = new Set<string>();
  const queue = [...escaped];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...reachableModules(files, file, trace));
  }
  return seen;
}

/** The modules reachable from `file`: the files under its package folder, and the modules its module-scope imports bind. */
function reachableModules(files: Files, file: string, trace: Tracer): string[] {
  const parsed = files.get(file);
  return [...submodules(files, file), ...(parsed ? importedModules(files, parsed, trace) : [])];
}

/** The files under a package `__init__.py`'s folder, however deep. */
function submodules(files: Files, file: string): string[] {
  const folder = file.endsWith('/__init__.py') ? file.slice(0, -'/__init__.py'.length) : undefined;
  return folder === undefined ? [] : [...files.keys()].filter((path) => path !== file && path.startsWith(`${folder}/`));
}

/** The repo modules a file's module-scope import bindings name; a from-import of a value names no module. */
function importedModules(files: Files, parsed: ParsedFile, trace: Tracer): string[] {
  const out: string[] = [];
  for (const binding of parsed.bindings ?? []) {
    if (binding.scope !== '' || binding.kind !== 'import' || binding.import === undefined) continue;
    const module = importModule(files, parsed, binding.import, binding.name, !!binding.dotted);
    if (module === EXTERNAL_MODULE) continue;
    if (module) {
      out.push(module);
      continue;
    }
    if (module === null) continue;
    const imp = parsed.imports[binding.import];
    if (!imp || imp.status !== 'resolved' || !imp.resolved) continue;
    const entry = imp.names?.find((name) => name.local === binding.name && name.imported !== '*');
    const found = entry ? trace(imp.resolved, entry.imported) : undefined;
    if (typeof found === 'object' && found.binding === '*') out.push(found.file);
  }
  return out;
}

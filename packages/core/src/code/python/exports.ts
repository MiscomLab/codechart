import type { ModuleExports } from '../imports.js';
import type { Import } from '../model.js';
import type { PyBinding } from './module-scope.js';

/** What a Python module exports, and which `TYPE_CHECKING` guards made a binding conditional. */

const TYPING = new Set(['typing', 'typing_extensions']);

/** Whether a guard's `TYPE_CHECKING` is typing's constant: its one binding is the import, and nothing rewrites it. */
function typingConstant(guard: string, bindings: readonly PyBinding[], imports: readonly Pick<Import, 'spec' | 'names'>[], attrWrites: ReadonlySet<string>): boolean {
  const [name, attribute] = guard.split('.') as [string, string | undefined];
  const bound = bindings.filter((b) => b.name === name && !b.attr);
  const imp = bound.length === 1 && bound[0]!.kind === 'import' && !bound[0]!.dotted && !bound[0]!.scope ? imports[bound[0]!.import!] : undefined;
  const entry = imp?.names?.find((n) => n.local === name);
  if (!imp || !entry || !TYPING.has(imp.spec)) return false;
  return attribute ? entry.imported === '*' && !attrWrites.has('TYPE_CHECKING') : entry.imported === 'TYPE_CHECKING';
}

/**
 * Settles the `if not TYPE_CHECKING:` guards once the whole file is bound: the body always runs only if every guard names
 * typing's constant. Otherwise `TYPE_CHECKING` is any value, so the bindings under it may never have run.
 */
export function settleGuards(bindings: PyBinding[], imports: readonly Pick<Import, 'spec' | 'names'>[], attrWrites: ReadonlySet<string>): void {
  for (const b of bindings) {
    if (!b.guards) continue;
    if (!b.guards.every((g) => typingConstant(g, bindings, imports, attrWrites))) b.conditional = true;
    delete b.guards;
  }
}

/**
 * The names a module exports: each name bound once at module scope. A name bound more than once (two branches, an
 * import and a definition, a reassignment) has no provable binding, so it is left out and the list is not complete.
 * A wildcard import, a module `__getattr__` or a run-time module write (`exec`, `globals()[…]`) can add names nobody
 * lists, so `*` makes the list incomplete too and is never an export.
 */
export function moduleExports(bindings: readonly PyBinding[], wildcard: boolean): ModuleExports {
  const byName = new Map<string, PyBinding[]>();
  // A star import, or a write through `globals()`/`exec`, can rebind any module name after the line that defines it:
  // no name is provable.
  if (wildcard || bindings.some((b) => b.scope === '' && b.name === '*')) return { names: [], complete: false };
  for (const b of bindings) if (b.scope === '' && !b.alias && b.name !== '*') byName.set(b.name, [...(byName.get(b.name) ?? []), b]);
  const names: ModuleExports['names'] = [];
  let complete = !byName.has('__getattr__');
  for (const [name, list] of byName) {
    if (list.length > 1 && !list.every((b) => b.dotted)) {
      complete = false;
      continue;
    }
    // An import binding names its own local, which the tracer follows through the import that binds it.
    names.push(list[0]!.kind === 'import' && !list[0]!.dotted ? { name, local: name } : { name });
  }
  return { names, complete };
}

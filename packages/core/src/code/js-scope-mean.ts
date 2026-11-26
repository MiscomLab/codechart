import type { Binding, Scope } from './js-scope-model.js';
import type { JsMeaning } from './js-scope.js';

export const OTHER_MEANING: JsMeaning = { kind: 'other' };
const IMPORT_MEANING: JsMeaning = { kind: 'import' };
export const NONE_MEANING: JsMeaning = { kind: 'none' };

const meaningOf = (binding: Binding): JsMeaning =>
  binding.kind === 'def' ? { kind: 'def', start: binding.start! } : binding.kind === 'import' ? IMPORT_MEANING : OTHER_MEANING;

/**
 * Whether entries are one TS overload group: signatures followed by at most one implementation, as `symbols.ts` merges
 * them into one symbol starting at the first signature.
 */
function isOverloadGroup(entries: readonly Binding[]): boolean {
  if (!entries.every((entry) => entry.kind === 'def' && entry.func)) return false;
  if (!entries.slice(0, -1).every((entry) => entry.signature)) return false;
  return entries[entries.length - 1]!.signature || !entries.some((entry) => !entry.signature && entry !== entries[entries.length - 1]);
}

/** The first scope that declares `name` decides; a written binding, or one bound more than once, proves no single value. */
export function meaningIn(scope: Scope, name: string): JsMeaning | undefined {
  const entries = scope.decls.get(name);
  if (!entries) return undefined;
  if (entries.some((entry) => entry.written)) return OTHER_MEANING;
  if (entries.length === 1) return meaningOf(entries[0]!);
  return isOverloadGroup(entries) ? { kind: 'def', start: entries[0]!.start! } : OTHER_MEANING;
}

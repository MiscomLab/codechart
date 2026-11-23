import type { CodeRef } from '../model.js';
import type { FileSet } from './files.js';

export type RefResolution = Pick<CodeRef, 'status' | 'resolved'>;

/** An http(s) URL or a network path (`//host/x`): a file on the web, not in the repo. */
const WEB = /^(?:https?:)?\/\//i;

/** Where a reference leads: the listed file its candidate path names, the web, or unknown. */
export function resolveRef(listed: FileSet, ref: CodeRef): RefResolution {
  if (WEB.test(ref.spec)) return { status: 'external' };
  if (ref.candidate !== undefined && listed.has(ref.candidate)) return { status: 'resolved', resolved: ref.candidate };
  return { status: 'unknown' };
}

import { joinRepo } from '../resolve/files.js';
import type { CodeRef } from '../model.js';
import { changesFolder, runTarget } from './commands.js';
import { shellCommands } from './shell.js';
import type { Decoded, Lines } from './text.js';

type RefKind = CodeRef['kind'];

/** A reference as parsed: unknown until the link pass resolves it. */
export function makeRef(file: string, spec: string, kind: RefKind, candidate: string | undefined, range: CodeRef['range'], from?: string): CodeRef {
  return { file, ...(from !== undefined && { from }), spec, kind, ...(candidate && { candidate }), status: 'unknown', range };
}

/** The repo path a shell word names from folder `base`; undefined when the shell decides it (expansions, `~`, absolute). */
function shellCandidate(base: string | undefined, value: string): string | undefined {
  if (base === undefined || value.startsWith('/') || value.startsWith('~')) return undefined;
  return joinRepo(base, value) || undefined;
}

/** A URL with a scheme (`https:`, `mailto:`, `data:`) or a network path (`//host/x`). */
const hasScheme = (spec: string): boolean => /^[a-z][a-z\d+.-]*:/i.test(spec) || spec.startsWith('//');

/**
 * The repo path an HTML or CSS URL names from folder `dir`, read as a browser does: no query or fragment, `\` as `/`,
 * percent-decoded. Undefined for a URL with a scheme, a root-relative path (the web root is not in the repo), template
 * syntax, or when `dir` is unknown (`<base href>`).
 */
export function urlCandidate(dir: string | undefined, spec: string): string | undefined {
  if (dir === undefined || hasScheme(spec) || /[{}<>$]/.test(spec)) return undefined;
  let path = spec.replace(/[?#].*$/s, '').replace(/\\/g, '/');
  if (!path || path.startsWith('/')) return undefined;
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  return joinRepo(dir, path) || undefined;
}

/**
 * The files the commands in `value` run, from folder `base` (undefined when no folder is fixed). After a `cd`, `pushd`
 * or `popd` no folder is fixed: which one the shell is in then is not tracked.
 */
export function commandRefs(file: string, value: Decoded, lines: Lines, base: string | undefined, from: string | undefined): CodeRef[] {
  const refs: CodeRef[] = [];
  let folder = base;
  for (const words of shellCommands(value.text)) {
    if (changesFolder(words)) folder = undefined;
    const target = runTarget(words);
    if (!target || !target.word.value) continue;
    const { word } = target;
    const candidate = target.searched || word.expands ? undefined : shellCandidate(folder, word.value);
    const [start, end] = value.span(word.start, word.end);
    refs.push(makeRef(file, word.value, 'run', candidate, lines.range(start, end), from));
  }
  return refs;
}

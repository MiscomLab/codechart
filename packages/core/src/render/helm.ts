// A template name is a Go string constant: "…" or `…`.
const NAME = String.raw`(?:"((?:\\.|[^"\\])*)"|` + '`([^`]*)`)';
const ACTION = /\{\{([\s\S]*?)\}\}/g;
// `block` defines a template too, and runs it in place.
const DEFINE = new RegExp(String.raw`^-?\s*(?:define|block)\s+${NAME}`);
const CALL = new RegExp(String.raw`(?<![\w.$-])(?:include|template)\s+${NAME}`, 'g');

const actions = (code: string) => [...code.matchAll(ACTION)].map((m) => m[1]!);

/** Whether `source` includes, by exact name, a template `target` defines; both without comments. */
export function includesTemplateOf(source: string, target: string): boolean {
  const defined = new Set(actions(target).flatMap((a) => {
    const m = DEFINE.exec(a);
    return m ? [m[1] ?? m[2]!] : [];
  }));
  if (!defined.size) return false;
  return actions(source).some((a) => [...a.matchAll(CALL)].some((m) => defined.has(m[1] ?? m[2]!)));
}

/** A Go string at `i`, `"…"` or `` `…` ``: where it ends and its value; undefined when none starts there. */
function goString(text: string, i: number): { end: number; value: string } | undefined {
  const quote = text[i];
  if (quote === '`') {
    const close = text.indexOf('`', i + 1);
    const end = close < 0 ? text.length : close + 1;
    return { end, value: text.slice(i + 1, close < 0 ? end : close) };
  }
  if (quote !== '"') return undefined;
  let j = i + 1;
  while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
  const raw = text.slice(i + 1, j);
  return { end: text[j] === '"' ? j + 1 : j, value: decode(raw) };
}

// Go's \xHH and \OOO escapes, spelled as JSON's \u00HH, so "a\x2eb" and "a.b" are one name.
function decode(raw: string): string {
  const json = raw
    .replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')
    .replace(/\\([0-7]{3})/g, (_, o: string) => `\\u${parseInt(o, 8).toString(16).padStart(4, '0')}`);
  try {
    return JSON.parse(`"${json}"`) as string;
  } catch {
    return raw;
  }
}

/** Index just past the `}}` closing the action that opens at `i`, skipping `}}` inside its strings. */
export function actionEnd(text: string, i: number): number {
  let j = i + 2;
  while (j < text.length) {
    if (text.startsWith('}}', j)) return j + 2;
    j = goString(text, j)?.end ?? j + 1;
  }
  return text.length;
}

/** Each `{{ … }}` action's body. */
function actions(code: string): string[] {
  const bodies: string[] = [];
  for (let i = code.indexOf('{{'); i >= 0; i = code.indexOf('{{', i)) {
    const end = actionEnd(code, i);
    bodies.push(code.slice(i + 2, Math.max(i + 2, end - 2)));
    i = end;
  }
  return bodies;
}

const KEYWORD = /(?<![\w.$-])(define|block|include|template)\s+/y;

/** The names an action passes to `define`/`block` (`defines`) or `include`/`template`, keywords outside its strings. */
function named(body: string, defines: boolean): string[] {
  const names: string[] = [];
  for (let j = 0; j < body.length; ) {
    const str = goString(body, j);
    if (str) {
      j = str.end;
      continue;
    }
    KEYWORD.lastIndex = j;
    const m = KEYWORD.exec(body);
    const name = m && goString(body, KEYWORD.lastIndex);
    // `define` and `block` are the action's keyword: `{{ define "x" }}`, `{{- block "x" . }}`.
    const wanted = m && (m[1] === 'define' || m[1] === 'block' ? defines && /^-?\s*$/.test(body.slice(0, j)) : !defines);
    if (name && wanted) names.push(name.value);
    j = name ? name.end : j + 1;
  }
  return names;
}

/** Whether `source` includes, by exact name, a template `target` defines; both without comments. */
export function includesTemplateOf(source: string, target: string): boolean {
  const defined = new Set(actions(target).flatMap((a) => named(a, true)));
  if (!defined.size) return false;
  return actions(source).some((a) => named(a, false).some((n) => defined.has(n)));
}

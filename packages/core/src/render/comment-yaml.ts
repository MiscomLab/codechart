import { blank, stringEnd } from './comment-scan.js';
import { actionEnd } from './helm.js';

// Go templates: `{{/*` or `{{- /*` up to `*/}}` or `*/ -}}`.
const TEMPLATE_COMMENT = /\{\{(?:-\s)?\/\*[\s\S]*?\*\/(?:\s-)?\}\}/g;
const BLOCK_SCALAR = /(?:^\s*|[:?-]\s+)[|>]([-+1-9]{0,2})\s*$/;
// The column a block scalar's key starts at, after any `- ` entries: `- run: |`.
const KEY = /^(\s*(?:-\s+)*)[^\s#-][^#]*?:\s+[|>]/;
const indentOf = (s: string) => s.length - s.trimStart().length;

type Scalar = { parent: number; content?: number } | undefined;

/** Whether `line` is still inside the `|` or `>` block scalar: the key line's indent, and its content's once a line sets it. */
function inScalar(scalar: Scalar, line: string): Scalar {
  if (!scalar || line.trim() === '') return scalar;
  const indent = indentOf(line);
  const content = scalar.content ?? (indent > scalar.parent ? indent : undefined);
  return content !== undefined && indent >= content ? { ...scalar, content } : undefined;
}

/** Where the `|` or `>` block scalar on `line` starts its content: at the explicit indent (`|2`), else at the next line indented past its key. */
function scalarOf(line: string, raw: string): Scalar {
  const m = BLOCK_SCALAR.exec(line);
  if (!m) return undefined;
  const parent = KEY.exec(line)?.[1]!.length ?? indentOf(raw);
  const explicit = /[1-9]/.exec(m[1]!);
  return explicit ? { parent, content: parent + Number(explicit[0]) } : { parent };
}

/**
 * A quote opens a scalar only where one starts: `a: "x"`, `- 'x'`, `[ "x"`, after an anchor or tag (`&a "x"`, `!!str "x"`), not `don't`.
 * `token` is the first character of the word before the quote.
 */
const opensScalar = (prev: string, before: string, token: string) =>
  prev === '' || '[{,'.includes(prev) || (/\s/.test(before) && (':?-'.includes(prev) || '&!'.includes(token)));

/** End of the template action or quoted scalar that starts at `i`, if one does. */
function skipAt(text: string, i: number, prev: string, token: string): number | undefined {
  if (text.startsWith('{{', i)) return actionEnd(text, i);
  const ch = text[i]!;
  if ((ch !== '"' && ch !== "'") || !opensScalar(prev, text[i - 1] ?? '', token)) return undefined;
  return stringEnd(text, i + 1, ch, { open: /./y, close: ch, escape: ch === '"' ? 'backslash' : 'double', lines: true });
}

/** The YAML from `i` to its line end, or past it through a quoted scalar or action, with its comment blanked; and where it stopped. */
function yamlLine(text: string, i: number): [string, number] {
  let out = '';
  let prev = '';
  let token = '';
  while (i < text.length && text[i] !== '\n') {
    const ch = text[i]!;
    const end = skipAt(text, i, prev, token);
    if (!/\s/.test(ch) && /^\s?$/.test(text[i - 1] ?? '')) token = ch;
    if (end !== undefined) {
      out += text.slice(i, end);
      prev = ch === '{' ? '}' : ch;
      i = end;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      const nl = text.indexOf('\n', i);
      return [`${out} `, nl < 0 ? text.length : nl];
    } else {
      out += ch;
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
  }
  return [out, i];
}

/** YAML: `#` at a word start, outside quoted scalars, block scalars and `{{ }}` template actions. */
export function yaml(text: string): string {
  let out = '';
  let i = 0;
  let scalar: Scalar;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const eol = nl < 0 ? text.length : nl;
    const raw = text.slice(i, eol);
    scalar = inScalar(scalar, raw);
    if (scalar) {
      out += text.slice(i, eol + 1);
      i = eol + 1;
      continue;
    }
    const [line, end] = yamlLine(text, i);
    out += end < text.length ? `${line}\n` : line;
    scalar = scalarOf(line, raw);
    i = end + 1;
  }
  return out;
}

export const withoutTemplateComments = (text: string) => text.replace(TEMPLATE_COMMENT, blank);

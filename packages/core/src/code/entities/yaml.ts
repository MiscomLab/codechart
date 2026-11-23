import type { Node } from 'web-tree-sitter';
import { Decoded } from './text.js';

/** A YAML document as plain values; anchors, tags and aliases are left out, so an alias reads as `other`. */
export type YValue = YMap | YSeq | YScalar | { kind: 'other'; node: Node };
interface YPair {
  key: string;
  node: Node;
  value: YValue | undefined;
}
export interface YMap {
  kind: 'map';
  node: Node;
  pairs: YPair[];
}
interface YSeq {
  kind: 'seq';
  node: Node;
  items: { node: Node; value: YValue | undefined }[];
}
interface YScalar {
  kind: 'scalar';
  node: Node;
  value: Decoded;
}

const ESCAPES: Record<string, string> = { '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };
const HEX: Record<string, number> = { x: 2, u: 4, U: 8 };

/** Skips a line break (LF or CRLF) and the blank lines after it; how many line breaks it crossed. */
function lineBreaks(source: string, i: number, end: number): { next: number; breaks: number } {
  let breaks = 0;
  let j = i;
  while (j < end) {
    if (source[j] === '\n') breaks++;
    else if (source[j] !== ' ' && source[j] !== '\t' && source[j] !== '\r') break;
    j++;
  }
  return { next: j, breaks };
}

/** A flow scalar (plain, single- or double-quoted) as YAML reads it: quotes and escapes removed, line breaks folded. */
function flowScalar(source: string, node: Node): Decoded {
  const quote = node.type === 'double_quote_scalar' ? '"' : node.type === 'single_quote_scalar' ? "'" : '';
  const out = new Decoded();
  const end = node.endIndex - quote.length;
  let i = node.startIndex + quote.length;
  while (i < end) {
    const ch = source[i]!;
    if (ch === '\n' || (ch === '\r' && source[i + 1] === '\n')) {
      out.trimEnd();
      const { next, breaks } = lineBreaks(source, i, end);
      out.push(breaks > 1 ? '\n'.repeat(breaks - 1) : ' ', i, i + 1);
      i = next;
    } else if (quote === "'" && ch === "'" && source[i + 1] === "'") {
      out.push("'", i, i + 2);
      i += 2;
    } else if (quote === '"' && ch === '\\') {
      i = escape(source, i, end, out);
    } else {
      out.push(ch, i, i + 1);
      i++;
    }
  }
  return out;
}

/** Reads the escape at `i` of a double-quoted scalar into `out`; the index after it. */
function escape(source: string, i: number, end: number, out: Decoded): number {
  const code = source[i + 1] ?? '';
  if (code === '\n' || code === '\r') return lineBreaks(source, i + 1, end).next;
  const digits = HEX[code];
  if (digits) {
    const hex = source.slice(i + 2, i + 2 + digits);
    out.push(String.fromCodePoint(parseInt(hex, 16) || 0), i, i + 2 + digits);
    return i + 2 + digits;
  }
  out.push(ESCAPES[code] ?? code, i, i + 2);
  return i + 2;
}

/** A `|` or `>` block scalar: indentation stripped; `>` folds lines that are neither empty nor more indented. */
function blockScalar(source: string, node: Node): Decoded {
  const out = new Decoded();
  const header = source.slice(node.startIndex, node.endIndex).split('\n', 1)[0]!;
  const folded = header.startsWith('>');
  let i = node.startIndex + header.length + 1;
  const lines: { start: number; end: number }[] = [];
  while (i <= node.endIndex) {
    const eol = source.indexOf('\n', i);
    const stop = eol < 0 || eol > node.endIndex ? node.endIndex : eol;
    lines.push({ start: i, end: source[stop - 1] === '\r' ? stop - 1 : stop });
    i = stop + 1;
  }
  const first = lines.find((l) => source.slice(l.start, l.end).trim());
  const indent = first ? /^ */.exec(source.slice(first.start, first.end))![0].length : 0;
  let previous: 'normal' | 'other' | 'empty' | undefined;
  for (const [n, line] of lines.entries()) {
    const text = source.slice(line.start + indent, line.end);
    const kind = !text.trim() ? 'empty' : text.startsWith(' ') || text.startsWith('\t') ? 'other' : 'normal';
    const at = line.start - 1;
    if (n > 0 && !folded) out.push('\n', at, at + 1);
    // `>` folds the break between two adjacent normal lines into a space; any other break stays a line break.
    if (n > 0 && folded && kind !== 'empty') out.push(previous === 'normal' && kind === 'normal' ? ' ' : '\n', at, at + 1);
    for (let k = 0; k < text.length; k++) out.push(text[k]!, line.start + indent + k, line.start + indent + k + 1);
    previous = kind;
  }
  return out;
}

const CONTENT = new Set(['block_mapping', 'block_sequence', 'block_scalar', 'flow_mapping', 'flow_sequence', 'plain_scalar', 'double_quote_scalar', 'single_quote_scalar', 'alias']);

const content = (node: Node | null): Node | undefined => {
  if (!node) return undefined;
  if (CONTENT.has(node.type)) return node;
  return node.namedChildren.find((c): c is Node => !!c && CONTENT.has(c.type));
};

function pairOf(source: string, pair: Node): YPair | undefined {
  const key = toValue(source, pair.childForFieldName('key'));
  if (key?.kind !== 'scalar') return undefined;
  return { key: key.value.text, node: pair, value: toValue(source, pair.childForFieldName('value')) };
}

/** The value a block or flow node holds. */
function toValue(source: string, node: Node | null): YValue | undefined {
  const inner = content(node);
  if (!inner) return undefined;
  switch (inner.type) {
    case 'block_mapping':
    case 'flow_mapping': {
      const pairs = inner.namedChildren.filter((c): c is Node => c?.type === 'block_mapping_pair' || c?.type === 'flow_pair');
      return { kind: 'map', node: inner, pairs: pairs.map((p) => pairOf(source, p)).filter((p): p is YPair => !!p) };
    }
    case 'block_sequence':
    case 'flow_sequence': {
      const items = inner.namedChildren.filter((c): c is Node => !!c && c.type !== 'comment');
      return {
        kind: 'seq',
        node: inner,
        items: items.map((item) => {
          // `[a: 1]` is a sequence of one-pair mappings.
          if (item.type === 'flow_pair') {
            const pair = pairOf(source, item);
            return { node: item, value: { kind: 'map', node: item, pairs: pair ? [pair] : [] } };
          }
          return { node: item, value: toValue(source, item.type === 'block_sequence_item' ? item.namedChildren.find((c) => c?.type.endsWith('_node')) ?? null : item) };
        }),
      };
    }
    case 'block_scalar':
      return { kind: 'scalar', node: inner, value: blockScalar(source, inner) };
    case 'alias':
      return { kind: 'other', node: inner };
    default:
      return { kind: 'scalar', node: inner, value: flowScalar(source, inner) };
  }
}

/** The first document's top-level value. */
export function yamlRoot(source: string, root: Node): YValue | undefined {
  const document = root.namedChildren.find((c) => c?.type === 'document');
  return document ? toValue(source, document.namedChildren.find((c) => c?.type.endsWith('_node')) ?? null) : undefined;
}

/** The value of the last `key` in a mapping. */
export function get(value: YValue | undefined, key: string): YValue | undefined {
  if (value?.kind !== 'map') return undefined;
  let found: YPair | undefined;
  for (const pair of value.pairs) if (pair.key === key) found = pair;
  return found?.value;
}

/** A scalar's text, or undefined for anything else. */
export const text = (value: YValue | undefined): string | undefined => (value?.kind === 'scalar' ? value.value.text : undefined);

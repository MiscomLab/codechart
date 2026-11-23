import type { Node, Tree } from 'web-tree-sitter';
import { dirOf } from '../resolve/files.js';
import type { CodeRef } from '../model.js';
import { makeRef, urlCandidate } from './refs.js';
import type { Lines } from './text.js';

/** Every node of `types` under `node`, in source order. */
function* descendants(node: Node, types: ReadonlySet<string>): Generator<Node> {
  if (types.has(node.type)) yield node;
  for (const child of node.namedChildren) if (child) yield* descendants(child, types);
}

const TAGS = new Set(['start_tag', 'self_closing_tag']);
/** The attribute each tag loads a file from, and the reference kind. */
const LOADS: Record<string, { attribute: string; kind: CodeRef['kind'] }> = { script: { attribute: 'src', kind: 'script' }, link: { attribute: 'href', kind: 'link' } };

/** A tag's attributes by lower-cased name: the node holding the value (quotes left out). */
function attributes(tag: Node): Map<string, Node | undefined> {
  const out = new Map<string, Node | undefined>();
  for (const attribute of tag.namedChildren) {
    if (attribute?.type !== 'attribute') continue;
    const name = attribute.namedChildren.find((c) => c?.type === 'attribute_name')?.text.toLowerCase();
    const raw = attribute.namedChildren.find((c) => c?.type === 'attribute_value' || c?.type === 'quoted_attribute_value');
    const value = raw?.type === 'quoted_attribute_value' ? raw.namedChildren.find((c) => c?.type === 'attribute_value') : raw;
    if (name && !out.has(name)) out.set(name, value ?? undefined);
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** An attribute value as the browser reads it: character references decoded. */
const decodeEntities = (value: string): string =>
  value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

const tagName = (tag: Node): string | undefined => tag.namedChildren.find((c) => c?.type === 'tag_name')?.text.toLowerCase();

/** `<script src>` and `<link href>`, relative to the page; a `<base href>` moves the base, so then no path is fixed. */
export function htmlRefs(file: string, tree: Tree, lines: Lines): CodeRef[] {
  const tags = [...descendants(tree.rootNode, TAGS)];
  const based = tags.some((t) => tagName(t) === 'base' && attributes(t).get('href'));
  const dir = based ? undefined : dirOf(file);
  const refs: CodeRef[] = [];
  for (const tag of tags) {
    const load = LOADS[tagName(tag) ?? ''];
    const value = load && attributes(tag).get(load.attribute);
    if (!load || !value?.text.trim()) continue;
    refs.push(makeRef(file, value.text, load.kind, urlCandidate(dir, decodeEntities(value.text.trim())), lines.range(value.startIndex, value.endIndex)));
  }
  return refs;
}

/** Statements that may come before `@import`; after any other rule, browsers ignore an `@import`. */
const BEFORE_IMPORT = new Set(['import_statement', 'charset_statement', 'comment']);

/** The URL node of an `@import`: a string, or the argument of `url()`. */
function importTarget(statement: Node): Node | undefined {
  const first = statement.namedChildren[0];
  if (first?.type === 'string_value') return first;
  if (first?.type !== 'call_expression' || first.namedChildren.find((c) => c?.type === 'function_name')?.text !== 'url') return undefined;
  return first.namedChildren.find((c) => c?.type === 'arguments')?.namedChildren.find((c) => c?.type === 'string_value' || c?.type === 'plain_value') ?? undefined;
}

/** `@import` references, relative to the stylesheet. */
export function cssRefs(file: string, tree: Tree, lines: Lines): CodeRef[] {
  const refs: CodeRef[] = [];
  for (const statement of tree.rootNode.namedChildren) {
    if (!statement) continue;
    const layer = statement.type === 'at_rule' && /^@layer\s[^{]*;$/.test(statement.text);
    if (!BEFORE_IMPORT.has(statement.type) && !layer) break;
    if (statement.type !== 'import_statement') continue;
    const target = importTarget(statement);
    // A string's content sits inside its quotes; an empty string has none.
    const content = target?.type === 'string_value' ? target.namedChildren.find((c) => c?.type === 'string_content') : target;
    if (!content?.text) continue;
    refs.push(makeRef(file, content.text, 'import', urlCandidate(dirOf(file), content.text), lines.range(content.startIndex, content.endIndex)));
  }
  return refs;
}

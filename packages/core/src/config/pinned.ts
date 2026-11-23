import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isScalar, parseAllDocuments, stringify, visit, type Node, type Pair, type YAMLMap } from 'yaml';
import { parsePinned, type Pinned } from './schema.js';

type Range = [number, number, number];

const lineStart = (text: string, i: number) => text.lastIndexOf('\n', i - 1) + 1;
// A BOM before the first key is not indentation.
const columnOf = (text: string, i: number) => i - lineStart(text, i) - (text[lineStart(text, i)] === '﻿' ? 1 : 0);
const rangeOf = (node: unknown) => (node as { range?: Range } | null)?.range;
const keyIs = (pair: Pair, name: string) => isScalar(pair.key) && pair.key.value === name;
const endOf = (pair: Pair) => (rangeOf(pair.value) ?? rangeOf(pair.key)!)[1];

/** Just past the line break that ends the line holding the last non-space character before `end`. */
function lineEndAfter(text: string, end: number): number {
  let i = end;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  const nl = text.indexOf('\n', i);
  return nl < 0 ? text.length : nl + 1;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `pinned:` and its entries, sorted by id in code-unit order, `name` before `reason`, `indent` deep with `step`. Written
 * with YAML 1.1's rules, so `yes`, `on` or `2024-01-01` get quotes and read as text in 1.1 tools as well as in 1.2.
 */
function renderPinned(pinned: Pinned, indent: number, step: number, eol: string): string {
  const sorted = Object.fromEntries(
    Object.keys(pinned)
      .sort(byCodeUnit)
      .map((id) => {
        const { name, reason } = pinned[id]!;
        return [id, reason === undefined ? { name } : { name, reason }];
      }),
  );
  return indentLines(stringify({ pinned: sorted }, { indent: step, lineWidth: 0, minContentWidth: 0, version: '1.1' }), indent, eol);
}

const indentLines = (block: string, indent: number, eol: string) =>
  block
    .trimEnd()
    .split('\n')
    .map((line) => ' '.repeat(indent) + line + eol)
    .join('');

function parseRoot(text: string): YAMLMap | undefined {
  const docs = parseAllDocuments(text);
  if (!Array.isArray(docs)) return undefined;
  if (docs.length > 1) throw new Error('the config must be one YAML document');
  const doc = docs[0];
  if (!doc) return undefined;
  if (doc.errors.length) throw new Error(doc.errors[0]!.message.split('\n')[0]);
  if (doc.directives?.docEnd) throw new Error('the config must be one YAML document, without a ... end marker');
  const root = doc.contents;
  if (isNull(root)) return undefined;
  if (!isMap(root) || root.flow) throw new Error('the config must be a block mapping (key: value lines)');
  return root;
}

function refuseAliases(node: unknown): void {
  if (isAlias(node)) throw new Error('map uses a YAML alias; write it out to let codechart edit it');
  if (node) visit(node as Node, { Alias: () => { throw new Error('map uses a YAML alias or merge key; write it out to let codechart edit it'); } });
}

const omit = (obj: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
const isNull = (node: unknown) => node === null || (isScalar(node) && node.value === null);
const asRecord = (value: unknown) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/** What the file must read as once written, `map: null` and `map: {}` as no map, to check the edit changed nothing else. */
function expectedAfter(before: unknown, pinned: Pinned): Record<string, unknown> {
  const rest = omit(asRecord(before), 'map');
  const mapRest = omit(asRecord(asRecord(before).map), 'pinned');
  const next = Object.keys(pinned).length ? { ...mapRest, pinned } : mapRest;
  return Object.keys(next).length ? { ...rest, map: next } : rest;
}

const withoutEmptyMap = (value: unknown) => {
  const v = asRecord(value);
  return Object.keys(asRecord(v.map)).length ? v : omit(v, 'map');
};

/** `map:` with nothing, or a flow mapping: the whole map value is written again as a block. */
function rewriteMap(text: string, mapStart: number, mapEnd: number, value: unknown, pins: Pinned, eol: string): string {
  const rest = omit(asRecord(isMap(value) ? value.toJSON() : {}), 'pinned');
  const empty = Object.keys(pins).length === 0;
  if (empty && Object.keys(rest).length === 0) return text.slice(0, mapStart) + text.slice(mapEnd);
  const others = Object.keys(rest).length ? indentLines(stringify(rest, { indent: 2, lineWidth: 0 }), 2, eol) : '';
  return text.slice(0, mapStart) + `map:${eol}${others}${empty ? '' : renderPinned(pins, 2, 2, eol)}` + text.slice(mapEnd);
}

/** A block `map`: replace, remove or add its `pinned`, at the map's own indent. */
function editBlockMap(text: string, mapPair: Pair, map: YAMLMap, pins: Pinned, eol: string): string {
  const empty = Object.keys(pins).length === 0;
  const indent = columnOf(text, rangeOf(map.items[0]!.key)![0]);
  const step = indent - columnOf(text, rangeOf(mapPair.key)![0]);
  const pinnedPair = map.items.find((p) => keyIs(p, 'pinned'));
  if (!pinnedPair) {
    if (empty) return text;
    const at = lineEndAfter(text, endOf(map.items[map.items.length - 1]!));
    const sep = at === text.length && !text.endsWith('\n') ? eol : '';
    return text.slice(0, at) + sep + renderPinned(pins, indent, step, eol) + text.slice(at);
  }
  if (!isNull(pinnedPair.value) && !isMap(pinnedPair.value)) throw new Error('map.pinned must be a mapping of ids to names');
  const start = lineStart(text, rangeOf(pinnedPair.key)![0]);
  const end = lineEndAfter(text, endOf(pinnedPair));
  if (!empty) return text.slice(0, start) + renderPinned(pins, indent, step, eol) + text.slice(end);
  // The map holds only pinned, with nothing written between them: it goes too.
  const onlyPinned = map.items.length === 1 && text.slice(lineEndAfter(text, rangeOf(mapPair.key)![1]), start).trim() === '';
  return text.slice(0, onlyPinned ? lineStart(text, rangeOf(mapPair.key)![0]) : start) + text.slice(end);
}

function splice(text: string, root: YAMLMap | undefined, pins: Pinned, eol: string): string {
  const mapPair = root?.items.find((p) => keyIs(p, 'map'));
  if (!mapPair) {
    if (Object.keys(pins).length === 0) return text;
    const sep = text === '' || text.endsWith('\n') ? '' : eol;
    return `${text}${sep}map:${eol}${renderPinned(pins, 2, 2, eol)}`;
  }
  refuseAliases(mapPair.value);
  const value = mapPair.value;
  if (!isNull(value) && !isMap(value)) throw new Error('map must be a mapping (key: value lines)');
  if (isMap(value) && !value.flow && value.items.length) return editBlockMap(text, mapPair, value, pins, eol);
  return rewriteMap(text, lineStart(text, rangeOf(mapPair.key)![0]), lineEndAfter(text, endOf(mapPair)), value, pins, eol);
}

/**
 * `text` (a `.codechart.yaml`) with `map.pinned` set to `pinned`, sorted by id, so the same pins in any order give the
 * same bytes. Only that block is rewritten (comments inside it are not kept); the rest of the file stays byte-identical.
 * New lines indent like the file's `map`, else by 2. No pins removes the block, and `map` when nothing else is in it.
 * Throws on invalid pins, or a file it can't edit safely: not one block mapping, or `map` using aliases.
 */
export function writePinned(text: string, pinned: Pinned): string {
  const checked = parsePinned(pinned);
  if (!checked.ok) throw new Error(checked.errors.join('\n'));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const root = parseRoot(text);
  const out = splice(text, root, checked.pinned, eol);
  const docs = parseAllDocuments(out);
  const after = Array.isArray(docs) && docs.length <= 1 && !docs[0]?.errors.length ? (docs[0]?.toJS() ?? {}) : undefined;
  const before = root ? (parseAllDocuments(text) as unknown as { toJS(): unknown }[])[0]!.toJS() : {};
  if (after === undefined || !isDeepStrictEqual(withoutEmptyMap(after), withoutEmptyMap(expectedAfter(before, checked.pinned)))) {
    throw new Error("couldn't write map.pinned without changing the rest of the file; edit it by hand");
  }
  return out;
}

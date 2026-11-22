import type { Node, Query, Tree } from 'web-tree-sitter';
import type { CallRef, CallVia, CodeSymbol } from './model.js';
import { nodeRange, touches } from './tree.js';

interface Callee {
  via: CallVia;
  receiver?: string;
  receiverPath?: string[];
}

const JS_CALLS = new Set(['call_expression']);
const PY_CALLS = new Set(['call']);

/** The call node a `@reference.call` capture belongs to: the capture is the call itself, or a node in it. */
function callOf(ref: Node, python: boolean): Node | undefined {
  const types = python ? PY_CALLS : JS_CALLS;
  for (let node: Node | null = ref; node; node = node.parent) if (types.has(node.type)) return node;
  return undefined;
}

/** A Python attribute chain's names, outermost first: `a.b.f` → `['a', 'b', 'f']`. */
const attrs = (node: Node | null | undefined): string[] => {
  if (!node) return [];
  if (node.type === 'identifier') return [node.text];
  if (node.type === 'attribute') return [...attrs(node.childForFieldName('object')), ...attrs(node.childForFieldName('attribute'))];
  return [];
};

/** How the callee is written, so linking can tell a bare name from `this.name` and from `receiver.name`. */
function calleeOf(call: Node, python: boolean): Callee {
  const fn = call.childForFieldName('function');
  if (fn?.type === 'identifier') return { via: 'bare' };
  if (python && fn?.type === 'attribute') {
    // `a.b.f()`: the name is the last segment; the chain before it decides what `a` is.
    const path = attrs(fn);
    const receiver = path[0];
    if (receiver === 'self' || receiver === 'cls') return { via: 'this' };
    return { via: 'member', ...(receiver && { receiver }), ...(path.length > 2 && { receiverPath: path.slice(0, -1) }) };
  }
  if (fn?.type === 'member_expression') {
    const object = fn.childForFieldName('object');
    if (object?.type === 'this') return { via: 'this' };
    if (object?.type === 'identifier') return { via: 'member', receiver: object.text };
  }
  return { via: 'member' };
}

const after = (a: { line: number; column: number }, b: { line: number; column: number }) => a.line > b.line || (a.line === b.line && a.column > b.column);
const pointOrder = (a: { line: number; column: number }, b: { line: number; column: number }) => a.line - b.line || a.column - b.column;

/**
 * The innermost symbol whose range holds the call's first character. A symbol kept from the last good parse has its
 * old range, which no longer matches the text: it is never the caller, and when one sits deeper than every parsed
 * symbol around the call, the call has no provable caller.
 */
function fromSymbol(symbols: readonly CodeSymbol[], kept: ReadonlySet<string>, call: Node): CodeSymbol | undefined {
  const at = { line: call.startPosition.row + 1, column: call.startPosition.column };
  const around = symbols.filter((s) => !after(s.range.start, at) && !after(at, s.range.end));
  const parsed = around
    .filter((s) => !kept.has(s.id))
    .sort((a, b) => b.path.length - a.path.length || pointOrder(b.range.start, a.range.start) || pointOrder(a.range.end, b.range.end));
  const keptDepth = Math.max(0, ...around.filter((s) => kept.has(s.id)).map((s) => s.path.length));
  return parsed[0] && parsed[0].path.length >= keptDepth ? parsed[0] : undefined;
}

/**
 * Calls from the grammar's `@reference.call` captures. `from` is the innermost definition around the call; a call at
 * file scope has no symbol to point at and is skipped. Calls in or around a syntax error are not read: the broken text
 * proves nothing. Evidence is `name-only` until the link pass proves a target.
 */
export function extractCalls(
  tree: Tree,
  tags: Query,
  symbols: { symbols: readonly CodeSymbol[]; kept: readonly string[] },
  errors: readonly Node[],
  grammar: 'python' | undefined = undefined,
): CallRef[] {
  const calls: CallRef[] = [];
  const seen = new Set<number>();
  const kept = new Set(symbols.kept);
  const python = grammar === 'python';
  for (const match of tags.matches(tree.rootNode)) {
    const ref = match.captures.find((c) => c.name === 'reference.call')?.node;
    const name = match.captures.find((c) => c.name === 'name')?.node;
    if (!ref || !name || seen.has(ref.id)) continue;
    const call = callOf(ref, python);
    if (!call || call.hasError || errors.some((e) => touches(call, e))) continue;
    seen.add(ref.id);
    const from = fromSymbol(symbols.symbols, kept, call);
    if (!from) continue;
    const { via, receiver, receiverPath } = calleeOf(call, python);
    calls.push({
      from: from.id,
      name: name.text,
      via,
      ...(receiver && { receiver }),
      ...(receiverPath && { receiverPath }),
      evidence: 'name-only',
      range: nodeRange(call),
    });
  }
  return calls;
}

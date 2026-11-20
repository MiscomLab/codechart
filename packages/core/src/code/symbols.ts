import type { Node, Query, Tree } from 'web-tree-sitter';
import { SYMBOL_KINDS, symbolId, type CodeSymbol, type CodeRange, type SymbolKind } from './model.js';

interface Def {
  node: Node;
  name: string;
  kind: SymbolKind;
  path: string[];
  broken: boolean;
}

/** A file's definitions; `broken` holds the ids of those parsed in or around a syntax error. */
export interface Extracted {
  symbols: CodeSymbol[];
  broken: Set<string>;
  errors: CodeRange[];
}

const KINDS = new Set<string>(SYMBOL_KINDS);

const nodeRange = (node: Node): CodeRange => ({
  start: { line: node.startPosition.row + 1, column: node.startPosition.column },
  end: { line: node.endPosition.row + 1, column: node.endPosition.column },
});

/** ERROR and MISSING nodes, descending only into subtrees that hold one. */
function errorNodes(node: Node, out: Node[] = []): Node[] {
  if (node.isError || node.isMissing) {
    out.push(node);
    return out;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.hasError || child?.isMissing) errorNodes(child, out);
  }
  return out;
}

// Overloads share a scope; `export` wraps each declaration on its own.
const scopeOf = (node: Node): number | undefined => (node.parent?.type === 'export_statement' ? node.parent.parent : node.parent)?.id;

// A MISSING node is zero-width: it breaks the definitions it sits in or at the edge of.
const touches = (def: Node, err: Node) =>
  err.startIndex === err.endIndex ? def.startIndex <= err.startIndex && err.startIndex <= def.endIndex : err.startIndex < def.endIndex && err.endIndex > def.startIndex;

function definitions(tree: Tree, tags: Query): Omit<Def, 'path' | 'broken'>[] {
  const seen = new Set<number>();
  const defs: Omit<Def, 'path' | 'broken'>[] = [];
  for (const match of tags.matches(tree.rootNode)) {
    const def = match.captures.find((c) => c.name.startsWith('definition.'));
    const name = match.captures.find((c) => c.name === 'name');
    const kind = def?.name.slice('definition.'.length);
    if (!def || !name || !kind || !KINDS.has(kind) || seen.has(def.node.id)) continue;
    seen.add(def.node.id);
    defs.push({ node: def.node, name: name.node.text, kind: kind as SymbolKind });
  }
  return defs.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex);
}

/** Gives each definition its path from the definitions around it; a definition in a broken one is broken too. */
function nest(defs: Omit<Def, 'path' | 'broken'>[], errors: Node[]): Def[] {
  const stack: Def[] = [];
  return defs.map((d) => {
    while (stack.length && stack[stack.length - 1]!.node.endIndex < d.node.endIndex) stack.pop();
    const parent = stack[stack.length - 1];
    const nested: Def = { ...d, path: [...(parent?.path ?? []), d.name], broken: (parent?.broken ?? false) || errors.some((e) => touches(d.node, e)) };
    stack.push(nested);
    return nested;
  });
}

/**
 * The definitions `tags` finds in `tree`, as symbols of `file`.
 * Overload signatures merge into the implementation that follows in the same scope; any other repeated identity gets `~n`.
 */
export function extractSymbols(file: string, tree: Tree, tags: Query): Extracted {
  const errors = tree.rootNode.hasError ? errorNodes(tree.rootNode) : [];
  const symbols: CodeSymbol[] = [];
  const broken = new Set<string>();
  const byId = new Map<string, { symbol: CodeSymbol; signature: boolean; scope: number | undefined; count: number }>();
  for (const def of nest(definitions(tree, tags), errors)) {
    const base = symbolId(file, def.path, def.kind);
    const prev = byId.get(base);
    if (prev?.signature && prev.scope === scopeOf(def.node)) {
      prev.symbol.range = { start: prev.symbol.range.start, end: nodeRange(def.node).end };
      prev.signature = def.node.type.endsWith('_signature');
      if (def.broken) broken.add(prev.symbol.id);
      continue;
    }
    const id = prev ? `${base}~${++prev.count}` : base;
    const symbol: CodeSymbol = { id, file, path: def.path, kind: def.kind, range: nodeRange(def.node) };
    // The latest group with this identity is the one a following overload can join.
    byId.set(base, { symbol, signature: def.node.type.endsWith('_signature'), scope: scopeOf(def.node), count: prev?.count ?? 1 });
    symbols.push(symbol);
    if (def.broken) broken.add(id);
  }
  return { symbols, broken, errors: errors.map(nodeRange) };
}

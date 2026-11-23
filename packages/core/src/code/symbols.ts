import type { Node, Query, Tree } from 'web-tree-sitter';
import type { Grammar } from './languages.js';
import { SYMBOL_KINDS, symbolId, type CodeSymbol, type CodeRange, type SymbolKind } from './model.js';
import { errorNodes, nodeRange, touches } from './tree.js';

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

const WRAPPERS = new Set(['export_statement', 'ambient_declaration']);

// Overloads share a scope; `export` and `declare` wrap each declaration on its own.
function scopeOf(node: Node): number | undefined {
  let parent = node.parent;
  while (parent && WRAPPERS.has(parent.type)) parent = parent.parent;
  return parent?.id;
}

/** Whether a Python `def` sits directly in a class body, decorated or not: it is a method, not a function. */
function pythonMethod(node: Node): boolean {
  let inner = node;
  if (inner.parent?.type === 'decorated_definition') inner = inner.parent;
  return inner.parent?.type === 'block' && inner.parent.parent?.type === 'class_definition';
}

function definitions(tree: Tree, tags: Query, grammar: Grammar): Omit<Def, 'path' | 'broken'>[] {
  const seen = new Set<number>();
  const defs: Omit<Def, 'path' | 'broken'>[] = [];
  for (const match of tags.matches(tree.rootNode)) {
    const def = match.captures.find((c) => c.name.startsWith('definition.'));
    const name = match.captures.find((c) => c.name === 'name');
    const kind = def?.name.slice('definition.'.length);
    if (!def || !name || !kind || !KINDS.has(kind) || seen.has(def.node.id)) continue;
    // The Python tags query has no method kind; a `def` in a class body is one all the same.
    if (grammar === 'python' && kind === 'function' && pythonMethod(def.node)) {
      seen.add(def.node.id);
      defs.push({ node: def.node, name: name.node.text, kind: 'method' });
      continue;
    }
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
    // `namespace A.B` is `namespace A { namespace B }`.
    const nested: Def = { ...d, path: [...(parent?.path ?? []), ...d.name.split('.')], broken: (parent?.broken ?? false) || errors.some((e) => touches(d.node, e)) };
    stack.push(nested);
    return nested;
  });
}

/** The node a Python method's range starts at: its `def` line, below any decorators. */
function pythonDefinition(node: Node): Node | undefined {
  const inner = node.type === 'decorated_definition' ? node.childForFieldName('definition') : node;
  return inner?.type === 'function_definition' ? inner : undefined;
}

/**
 * The range a symbol covers. A Python method's starts at its `def` line rather than at its decorators: the decorator
 * line is the one place a call inside the method must not be attributed to the class instead.
 */
function definitionRange(grammar: Grammar, node: Node, kind: SymbolKind): CodeRange {
  const range = nodeRange(node);
  if (grammar !== 'python' || kind !== 'method') return range;
  const def = pythonDefinition(node);
  return def ? { start: nodeRange(def).start, end: range.end } : range;
}

/**
 * The definitions `tags` finds in `tree`, as symbols of `file`.
 * Overload signatures merge into the implementation that follows in the same scope; any other repeated identity gets `~n`.
 */
export function extractSymbols(file: string, tree: Tree, tags: Query, grammar: Grammar): Extracted {
  const errors = tree.rootNode.hasError ? errorNodes(tree.rootNode) : [];
  const symbols: CodeSymbol[] = [];
  const broken = new Set<string>();
  const byId = new Map<string, { symbol: CodeSymbol; signature: boolean; scope: number | undefined; count: number }>();
  for (const def of nest(definitions(tree, tags, grammar), errors)) {
    const base = symbolId(file, def.path, def.kind);
    const prev = byId.get(base);
    if (prev?.signature && prev.scope === scopeOf(def.node)) {
      prev.symbol.range = { start: prev.symbol.range.start, end: nodeRange(def.node).end };
      prev.signature = def.node.type.endsWith('_signature');
      if (def.broken) broken.add(prev.symbol.id);
      continue;
    }
    const id = prev ? `${base}~${++prev.count}` : base;
    const symbol: CodeSymbol = { id, file, path: def.path, kind: def.kind, range: definitionRange(grammar, def.node, def.kind) };
    // The latest group with this identity is the one a following overload can join.
    byId.set(base, { symbol, signature: def.node.type.endsWith('_signature'), scope: scopeOf(def.node), count: prev?.count ?? 1 });
    symbols.push(symbol);
    if (def.broken) broken.add(id);
  }
  return { symbols, broken, errors: errors.map(nodeRange) };
}

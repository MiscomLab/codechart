import type { Tree } from 'web-tree-sitter';

/**
 * A read-only mirror of a Python syntax tree in plain JavaScript. Every access to a web-tree-sitter `Node` crosses into
 * WASM and allocates a fresh object, which the many whole-tree passes over a Python file made the cost of parsing it;
 * one cursor walk copies the tree once, and the passes then read plain objects.
 */
export interface PyNode {
  /** Unique within the tree, equal to the id of the web-tree-sitter node it mirrors. */
  readonly id: number;
  readonly type: string;
  /** The source text the node spans. */
  readonly text: string;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly parent: PyNode | null;
  readonly namedChildren: readonly PyNode[];
  /** An ERROR or MISSING node is, or lies in, this subtree. */
  readonly hasError: boolean;
  /** The first child in `field`, or null. */
  childForFieldName(field: string): PyNode | null;
  childrenForFieldName(field: string): PyNode[];
}

/** The source and, once a position is asked for, its line starts: a point is a row and a UTF-16 column, as tree-sitter reports it. */
class Source {
  private starts: number[] | undefined;

  constructor(readonly text: string) {}

  point(index: number): { readonly row: number; readonly column: number } {
    if (!this.starts) {
      this.starts = [0];
      for (let at = this.text.indexOf('\n'); at >= 0; at = this.text.indexOf('\n', at + 1)) this.starts.push(at + 1);
    }
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts[mid]! <= index) low = mid;
      else high = mid - 1;
    }
    return { row: low, column: index - this.starts[low]! };
  }
}

class MirrorNode implements PyNode {
  readonly namedChildren: MirrorNode[] = [];
  private readonly children: MirrorNode[] = [];
  private readonly fields: (string | null)[] = [];
  private error: boolean | undefined;
  private from: PyNode['startPosition'] | undefined;
  private to: PyNode['endPosition'] | undefined;

  constructor(
    readonly id: number,
    readonly type: string,
    private readonly missing: boolean,
    private readonly source: Source,
    private readonly span: { readonly start: number; readonly end: number },
    readonly parent: MirrorNode | null,
  ) {}

  get text(): string {
    return this.source.text.slice(this.span.start, this.span.end);
  }

  get startPosition(): PyNode['startPosition'] {
    return (this.from ??= this.source.point(this.span.start));
  }

  get endPosition(): PyNode['endPosition'] {
    return (this.to ??= this.source.point(this.span.end));
  }

  get hasError(): boolean {
    this.error ??= this.type === 'ERROR' || this.missing || this.children.some((child) => child.hasError);
    return this.error;
  }

  add(child: MirrorNode, named: boolean, field: string | null): void {
    this.children.push(child);
    this.fields.push(field);
    if (named) this.namedChildren.push(child);
  }

  // The mirror differs from web-tree-sitter only on `match_statement.childForFieldName('alternative')`, which core does not use.
  childForFieldName(field: string): MirrorNode | null {
    // An ERROR node has no field map, so tree-sitter finds no single child by field in it, though its children carry fields.
    if (this.type === 'ERROR') return null;
    const at = this.fields.indexOf(field);
    return at < 0 ? null : this.children[at]!;
  }

  childrenForFieldName(field: string): MirrorNode[] {
    return this.children.filter((_, at) => this.fields[at] === field);
  }
}

/** The mirror of a tree and its nodes by id, to map the nodes a query captured. `source` is the text the tree parsed. */
export function mirrorTree(tree: Tree, source: string): { root: PyNode; byId: ReadonlyMap<number, PyNode> } {
  const cursor = tree.walk();
  const byId = new Map<number, MirrorNode>();
  const text = new Source(source);
  // Each cursor read is a call into WASM, so what a node type fixes is read once per type, and a MISSING node (always zero-width) only where one could be.
  const types = new Map<number, { type: string; named: boolean }>();
  const fieldNames = new Map<number, string | null>();
  const make = (parent: MirrorNode | null): MirrorNode => {
    const typeId = cursor.nodeTypeId;
    let kind = types.get(typeId);
    if (!kind) types.set(typeId, (kind = { type: cursor.nodeType, named: cursor.nodeIsNamed }));
    const start = cursor.startIndex;
    const end = cursor.endIndex;
    const node = new MirrorNode(cursor.nodeId, kind.type, start === end && cursor.nodeIsMissing, text, { start, end }, parent);
    if (parent) {
      const fieldId = cursor.currentFieldId;
      let field = fieldNames.get(fieldId);
      if (field === undefined) fieldNames.set(fieldId, (field = cursor.currentFieldName ?? null));
      parent.add(node, kind.named, field);
    }
    byId.set(node.id, node);
    return node;
  };
  try {
    const root = make(null);
    let node = root;
    let down = cursor.gotoFirstChild();
    for (;;) {
      if (down) {
        node = make(node);
        // An anonymous node can have children too (`not in` holds an ERROR or a MISSING token), so every node is entered.
        down = cursor.gotoFirstChild();
        continue;
      }
      // On a leaf: the next sibling, or the next sibling of the nearest ancestor that has one.
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return { root, byId };
        node = node.parent!;
      }
      node = node.parent!;
      down = true;
    }
  } finally {
    cursor.delete();
  }
}

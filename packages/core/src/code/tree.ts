import type { Node } from 'web-tree-sitter';
import type { CodeRange } from './model.js';

/** A tree-sitter node's span (or a mirror's), with 1-based lines and 0-based columns. */
export const nodeRange = (node: Pick<Node, 'startPosition' | 'endPosition'>): CodeRange => ({
  start: { line: node.startPosition.row + 1, column: node.startPosition.column },
  end: { line: node.endPosition.row + 1, column: node.endPosition.column },
});

/** ERROR and MISSING nodes, descending only into subtrees that hold one. */
export function errorNodes(node: Node, out: Node[] = []): Node[] {
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

/** Whether a node is in or at the edge of an error; a MISSING node is zero-width, so both edges count. */
export const touches = (node: Node, error: Node): boolean =>
  error.startIndex === error.endIndex
    ? node.startIndex <= error.startIndex && error.startIndex <= node.endIndex
    : error.startIndex < node.endIndex && error.endIndex > node.startIndex;

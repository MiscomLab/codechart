import type { Node, Tree } from 'web-tree-sitter';

/** `"name"`, `` `name` `` and `[name]` are the name. */
const unquote = (identifier: string): string => identifier.replace(/^(["`])(.*)\1$/s, '$2').replace(/^\[(.*)\]$/s, '$1');

function* tables(node: Node): Generator<Node> {
  if (node.type === 'create_table') yield node;
  for (const child of node.namedChildren) if (child) yield* tables(child);
}

/** Each `CREATE TABLE`: its node and its name parts, database and schema first. */
export function sqlTables(tree: Tree): { path: string[]; node: Node }[] {
  const out: { path: string[]; node: Node }[] = [];
  for (const node of tables(tree.rootNode)) {
    const reference = node.namedChildren.find((c) => c?.type === 'object_reference');
    const path = (reference?.namedChildren ?? []).filter((c) => c?.type === 'identifier').map((c) => unquote(c!.text));
    if (path.length && path.every(Boolean)) out.push({ path, node });
  }
  return out;
}

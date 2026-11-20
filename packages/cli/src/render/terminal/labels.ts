import { flat, marker } from '@codechart/core';
import type { NodeKind, SpecNode, Status } from '@codechart/core';

export { marker };

const SGR: Record<Status, string | undefined> = { new: '32', changed: '33', removed: '31', context: '2', config: '36', existing: undefined, outside: '2' };

export const paint = (node: SpecNode, text: string): string =>
  text && SGR[node.status] ? `\u001b[${SGR[node.status]}m${text}\u001b[0m` : text;

// Tables and files are the default reading; the config marker already says config.
const KINDLESS: ReadonlySet<NodeKind> = new Set(['table', 'file', 'other', 'config']);

/** The node as the map names it: its kind before the label unless the kind is the default reading. */
export const kindLabel = (node: SpecNode): string =>
  KINDLESS.has(node.kind) ? flat(node.label) : `${node.kind} ${flat(node.label)}`;

/** What opens a node's headline: the marker in the first column, a space for an unchanged node, then a space. */
export const gutter = (status: Status): string => `${marker(status) || ' '} `;

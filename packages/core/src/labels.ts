import type { FlowStep } from './spec/flow.js';
import type { SpecNode, Status } from './spec/schema.js';
import { flat } from './render/strip.js';

// Unchanged nodes carry no marker, as unchanged lines in a diff carry none.
const MARKER: Record<Status, string> = { new: '+', changed: '~', removed: '-', context: '', config: '◆', existing: '', outside: '○' };

export const marker = (status: Status): string => MARKER[status];

/** Marker glued to the label, `~orders`: for check messages and the HTML. */
export const plainLabel = (node: SpecNode): string => marker(node.status) + flat(node.label);

const STEP_MARKER: Record<FlowStep['status'], string> = { existing: '', new: '+', changed: '~', planned: '?', removed: '-' };

/** Marker glued to a flow step's label, `+look up the invite`. */
export const stepLabel = (step: FlowStep): string => STEP_MARKER[step.status] + flat(step.label);

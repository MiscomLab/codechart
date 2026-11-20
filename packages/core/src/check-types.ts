export interface Mismatch {
  id: string;
  /** With its status marker, as the diagram shows it. */
  label: string;
  /** A few words for the terminal line. */
  short: string;
  /** The full reason, for the HTML. */
  detail: string;
}

export interface CheckSummary {
  checked: number;
  mismatches: Mismatch[];
  /** Loose claims that don't fail the check: a field or an arrow the code doesn't back up. */
  warnings?: Mismatch[];
  unit: 'node' | 'box' | 'anchor';
  /** Boxes or nodes without a path, which the check can't look at. */
  notCheckable?: number;
  /** An explain map with flows: how many of `checked` are steps, the rest boxes. */
  steps?: number;
  /** Changed files no node covers and `omitted` doesn't name. */
  uncovered?: string[];
  /** A summary rendered in a repo without --git, --since or --commit. */
  diffUnchecked?: boolean;
}

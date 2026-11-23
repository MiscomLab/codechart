import type { CodeRange } from '../model.js';

/**
 * A string value as the program reading it sees it (unquoted, unescaped, folded), with the span in the source text
 * each of its characters came from, so a reference found in the value points at its real characters.
 */
export class Decoded {
  text = '';
  private readonly from: number[] = [];
  private readonly to: number[] = [];

  /** Appends `chars`, all coming from source span `[start, end)`; one entry per UTF-16 unit, as string offsets count. */
  push(chars: string, start: number, end: number): void {
    this.text += chars;
    for (let k = 0; k < chars.length; k++) {
      this.from.push(start);
      this.to.push(end);
    }
  }

  /** Drops trailing spaces and tabs, as YAML line folding does. */
  trimEnd(): void {
    while (this.text.endsWith(' ') || this.text.endsWith('\t')) {
      this.text = this.text.slice(0, -1);
      this.from.pop();
      this.to.pop();
    }
  }

  /** The source span of value characters `[start, end)`. */
  span(start: number, end: number): [number, number] {
    return [this.from[start]!, this.to[end - 1]!];
  }
}

/** Turns source indices into the code layer's 1-based lines and 0-based columns (UTF-16 units, as web-tree-sitter counts). */
export class Lines {
  private readonly starts = [0];

  constructor(source: string) {
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') this.starts.push(i + 1);
  }

  private point(index: number) {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: index - this.starts[lo]! };
  }

  /** The source index of a point. */
  index(point: CodeRange['start']): number {
    return this.starts[point.line - 1]! + point.column;
  }

  range(start: number, end: number): CodeRange {
    return { start: this.point(start), end: this.point(end) };
  }
}

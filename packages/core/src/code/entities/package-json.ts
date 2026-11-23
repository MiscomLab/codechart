import type { Node } from 'web-tree-sitter';
import { dirOf } from '../resolve/files.js';
import type { CodeRef } from '../model.js';
import { commandRefs } from './refs.js';
import { Decoded, type Lines } from './text.js';

const ESCAPES: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** A JSON string's value, mapped to its source characters. */
function jsonString(node: Node): Decoded {
  const out = new Decoded();
  for (const part of node.namedChildren) {
    if (!part) continue;
    if (part.type === 'escape_sequence') {
      const code = part.text[1]!;
      const value = code === 'u' ? String.fromCharCode(parseInt(part.text.slice(2), 16)) : (ESCAPES[code] ?? code);
      out.push(value, part.startIndex, part.endIndex);
    } else {
      for (let k = 0; k < part.text.length; k++) out.push(part.text[k]!, part.startIndex + k, part.startIndex + k + 1);
    }
  }
  return out;
}

/** An object's pairs by key; a repeated key keeps its last pair, as `JSON.parse` does. */
function pairs(object: Node | undefined): Map<string, Node> {
  const out = new Map<string, Node>();
  if (object?.type !== 'object') return out;
  for (const pair of object.namedChildren) {
    const key = pair?.type === 'pair' ? pair.childForFieldName('key') : null;
    if (!key || key.type !== 'string') continue;
    const name = jsonString(key).text;
    // Delete first, so the map keeps source order of the pairs that count.
    out.delete(name);
    out.set(name, pair!);
  }
  return out;
}

/** An npm script as found, before ids are given. */
export interface Script {
  name: string;
  node: Node;
  command: Decoded | undefined;
}

/** Whether a file is an npm package manifest. */
export const isPackageJson = (path: string): boolean => path === 'package.json' || path.endsWith('/package.json');

/** The top-level `scripts` of a package.json. */
export function packageScripts(root: Node): Script[] {
  const top = root.namedChildren.find((c) => c?.type === 'object') ?? undefined;
  const scripts = pairs(top).get('scripts')?.childForFieldName('value') ?? undefined;
  return [...pairs(scripts)].map(([name, pair]) => {
    const value = pair.childForFieldName('value');
    return { name, node: pair, command: value?.type === 'string' ? jsonString(value) : undefined };
  });
}

/** The files an npm script runs; npm runs scripts from the package's folder. */
export function scriptRefs(file: string, script: Script, lines: Lines, from: string | undefined): CodeRef[] {
  return script.command ? commandRefs(file, script.command, lines, dirOf(file), from) : [];
}

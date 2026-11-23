import type { Node, Tree } from 'web-tree-sitter';
import { dirOf, joinRepo } from '../resolve/files.js';
import type { CodeRange, CodeRef, CodeSymbol } from '../model.js';
import { makeRef } from './refs.js';
import type { Lines } from './text.js';

// The script's own path as bash knows it, quotes removed: `$0` when run, `$BASH_SOURCE` when sourced too.
const SELF = String.raw`(?:\$0|\$\{0\}|\$BASH_SOURCE|\$\{BASH_SOURCE(?:\[0\])?\})`;
const DIRNAME = String.raw`\$\(dirname (?:-- )?${SELF}\)`;
const STRIP = String.raw`\$\{(?:0|BASH_SOURCE(?:\[0\])?)%/\*\}`;
const BASE = `(?:${DIRNAME}|${STRIP})`;
const CD = String.raw`\$\(cd (?:-P )?(?:-- )?${BASE} ?(?:&&|;) ?pwd(?: -P)?\)`;
/** The ways to write the script's own folder. */
const SCRIPT_DIR = `(?:${CD}|${BASE})`;
const SCRIPT_DIR_PREFIX = new RegExp(`^${SCRIPT_DIR}/`);
const SCRIPT_DIR_VALUE = new RegExp(`^${SCRIPT_DIR}$`);
const VARIABLE_PREFIX = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})\//;

const unquoted = (text: string): string => text.replace(/["']/g, '');

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of node.namedChildren) if (child) yield* walk(child);
}

/** Where each variable is set: assignments anywhere, declarations, `read` and `for` variables. */
function bindings(tree: Tree): Map<string, Node[]> {
  const out = new Map<string, Node[]>();
  const add = (name: string | undefined, node: Node) => name && out.set(name, [...(out.get(name) ?? []), node]);
  for (const node of walk(tree.rootNode)) {
    if (node.type === 'variable_assignment') {
      add(node.childForFieldName('name')?.text, node);
    } else if (node.type === 'declaration_command') {
      for (const c of node.namedChildren) if (c?.type === 'variable_name') add(c.text, node);
    } else if (node.type === 'for_statement') {
      add(node.childForFieldName('variable')?.text, node);
    } else if (node.type === 'command' && ['read', 'unset', 'mapfile', 'readarray'].includes(node.childForFieldName('name')?.text ?? '')) {
      for (const arg of node.childrenForFieldName('argument')) if (arg && /^[A-Za-z_]\w*$/.test(arg.text)) add(arg.text, node);
    }
  }
  return out;
}

/** Whether `name` holds the script's folder at `use`: set exactly once, by a plain top-level assignment before it. */
function holdsScriptDir(name: string, use: Node, sets: Map<string, Node[]>): boolean {
  const all = sets.get(name) ?? [];
  if (all.length !== 1) return false;
  const only = all[0]!;
  // Inside a command (`D=x cmd`) the assignment lasts for that command only; `export`, `local`… wrap it in a declaration.
  if (only.type !== 'variable_assignment' || only.parent?.type !== 'program' || only.endIndex > use.startIndex) return false;
  const value = only.childForFieldName('value');
  return !!value && SCRIPT_DIR_VALUE.test(unquoted(value.text));
}

/** The repo path a `source` argument names when it starts with the script's own folder. */
function sourceCandidate(file: string, spec: string, use: Node, sets: Map<string, Node[]>): string | undefined {
  const plain = unquoted(spec);
  let rest: string | undefined;
  const direct = SCRIPT_DIR_PREFIX.exec(plain);
  if (direct) rest = plain.slice(direct[0].length);
  const variable = VARIABLE_PREFIX.exec(plain);
  if (!direct && variable && holdsScriptDir(variable[1] ?? variable[2]!, use, sets)) rest = plain.slice(variable[0].length);
  if (rest === undefined || /[$`*?[\]{}~\\]/.test(rest)) return undefined;
  return joinRepo(dirOf(file), rest) || undefined;
}

const before = (a: CodeRange['start'], b: CodeRange['start']) => a.line < b.line || (a.line === b.line && a.column <= b.column);

/** The innermost function around a range. */
function around(symbols: readonly CodeSymbol[], range: CodeRange): string | undefined {
  const holding = symbols.filter((s) => before(s.range.start, range.start) && before(range.end, s.range.end));
  return holding.sort((a, b) => b.path.length - a.path.length)[0]?.id;
}

/** `source` and `.` references; a path is fixed only when it starts with the script's own folder. */
export function bashRefs(file: string, tree: Tree, lines: Lines, symbols: readonly CodeSymbol[]): CodeRef[] {
  const sets = bindings(tree);
  const refs: CodeRef[] = [];
  for (const node of walk(tree.rootNode)) {
    if (node.type !== 'command' || !['source', '.'].includes(node.childForFieldName('name')?.text ?? '')) continue;
    const arg = node.childrenForFieldName('argument')[0];
    if (!arg) continue;
    const inner = arg.type === 'string' || arg.type === 'raw_string';
    const [start, end] = inner ? [arg.startIndex + 1, arg.endIndex - 1] : [arg.startIndex, arg.endIndex];
    const spec = inner ? arg.text.slice(1, -1) : arg.type === 'word' ? arg.text.replace(/\\(.)/g, '$1') : unquoted(arg.text);
    if (!spec) continue;
    const range = lines.range(start, end);
    refs.push(makeRef(file, spec, 'source', sourceCandidate(file, spec, node, sets), range, around(symbols, range)));
  }
  return refs;
}

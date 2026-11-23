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
const ABSOLUTE_VALUE = new RegExp(`^${CD}$`);
const VARIABLE_PREFIX = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})\//;

/**
 * The text with double quotes removed, for matching the script-folder idioms. Single-quoted text is literal, `$` and
 * all, so a word holding one never matches.
 */
const unquoted = (text: string): string => (text.includes("'") ? '' : text.replace(/"/g, ''));

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of node.namedChildren) if (child) yield* walk(child);
}

/** Commands whose arguments can name a variable they set (`read D`, `printf -v D`, `let D=1`). */
const SETTERS = new Set(['read', 'mapfile', 'readarray', 'printf', 'let']);
/** Any variable may be set by these: `eval "D=x"`. */
const ANY = '*';

const variables = (node: Node): string[] => node.namedChildren.filter((c) => c?.type === 'variable_name').map((c) => c!.text);

/** The variables one node sets, or may set. */
function setBy(node: Node): string[] {
  switch (node.type) {
    case 'variable_assignment':
      return [node.childForFieldName('name')?.text ?? ''];
    case 'declaration_command':
    case 'unset_command':
    // `(( D = 1 ))`, `(( D++ ))`: any arithmetic on the name may set it.
    case 'binary_expression':
    case 'postfix_expression':
    case 'unary_expression':
      return variables(node);
    case 'for_statement':
      return [node.childForFieldName('variable')?.text ?? ''];
    case 'command': {
      const name = node.childForFieldName('name')?.text ?? '';
      if (name === 'eval') return [ANY];
      if (!SETTERS.has(name)) return [];
      return node.childrenForFieldName('argument').map((arg) => /^([A-Za-z_]\w*)(?:\+?=|$)/.exec(arg?.text ?? '')?.[1] ?? '');
    }
    default:
      return [];
  }
}

/** Where each variable is set: assignments anywhere, declarations, `unset`, setter commands, arithmetic, `for`. */
function bindings(tree: Tree): Map<string, Node[]> {
  const out = new Map<string, Node[]>();
  for (const node of walk(tree.rootNode)) for (const name of setBy(node)) if (name) out.set(name, [...(out.get(name) ?? []), node]);
  return out;
}

/** Whether a node runs in a subshell (`$(…)`, `(…)`, backticks), whose `cd` leaves the script's folder alone. */
function inSubshell(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'command_substitution' || p.type === 'subshell') return true;
  return false;
}

/** Where the script changes its working directory; after that, a relative `$0` no longer names its folder. */
const folderChanges = (tree: Tree): number[] =>
  [...walk(tree.rootNode)]
    .filter((n) => n.type === 'command' && ['cd', 'pushd', 'popd'].includes(n.childForFieldName('name')?.text ?? '') && !inSubshell(n))
    .map((n) => n.startIndex);

/** What a `source` argument's folder depends on: the variables set in the file and where it changes folder. */
interface Script {
  file: string;
  sets: Map<string, Node[]>;
  cds: number[];
}

const changedBefore = (script: Script, index: number): boolean => script.cds.some((cd) => cd < index);

/**
 * Whether `name` holds the script's folder at `use`: set exactly once, by a plain top-level assignment before it. If the
 * script changes folder between the two, only the absolute form `$(cd "$(dirname "$0")" && pwd)` still holds.
 */
function holdsScriptDir(name: string, use: Node, script: Script): boolean {
  const all = script.sets.get(name) ?? [];
  if (all.length !== 1 || script.sets.has(ANY)) return false;
  const only = all[0]!;
  // Inside a command (`D=x cmd`) the assignment lasts for that command only; `export`, `local`… wrap it in a declaration.
  if (only.type !== 'variable_assignment' || only.parent?.type !== 'program' || only.endIndex > use.startIndex) return false;
  const value = only.childForFieldName('value');
  if (!value || !SCRIPT_DIR_VALUE.test(unquoted(value.text)) || changedBefore(script, only.startIndex)) return false;
  return !changedBefore(script, use.startIndex) || ABSOLUTE_VALUE.test(unquoted(value.text));
}

/** The repo path a `source` argument (as written, quotes included) names when it starts with the script's own folder. */
function sourceCandidate(written: string, use: Node, script: Script): string | undefined {
  const plain = unquoted(written);
  let rest: string | undefined;
  const direct = SCRIPT_DIR_PREFIX.exec(plain);
  // Written in place, the folder is worked out when `source` runs: after a `cd`, from the wrong folder.
  if (direct && !changedBefore(script, use.startIndex)) rest = plain.slice(direct[0].length);
  const variable = VARIABLE_PREFIX.exec(plain);
  if (!direct && variable && holdsScriptDir(variable[1] ?? variable[2]!, use, script)) rest = plain.slice(variable[0].length);
  if (rest === undefined || /[$`*?[\]{}~\\]/.test(rest)) return undefined;
  return joinRepo(dirOf(script.file), rest) || undefined;
}

const before = (a: CodeRange['start'], b: CodeRange['start']) => a.line < b.line || (a.line === b.line && a.column <= b.column);

/** The innermost function around a range. */
function around(symbols: readonly CodeSymbol[], range: CodeRange): string | undefined {
  const holding = symbols.filter((s) => before(s.range.start, range.start) && before(range.end, s.range.end));
  return holding.sort((a, b) => b.path.length - a.path.length)[0]?.id;
}

/** `source` and `.` references; a path is fixed only when it starts with the script's own folder. */
export function bashRefs(file: string, tree: Tree, lines: Lines, symbols: readonly CodeSymbol[]): CodeRef[] {
  const script: Script = { file, sets: bindings(tree), cds: folderChanges(tree) };
  const refs: CodeRef[] = [];
  for (const node of walk(tree.rootNode)) {
    if (node.type !== 'command' || !['source', '.'].includes(node.childForFieldName('name')?.text ?? '')) continue;
    const arg = node.childrenForFieldName('argument')[0];
    if (!arg) continue;
    const inner = arg.type === 'string' || arg.type === 'raw_string';
    const [start, end] = inner ? [arg.startIndex + 1, arg.endIndex - 1] : [arg.startIndex, arg.endIndex];
    const spec = inner ? arg.text.slice(1, -1) : arg.type === 'word' ? arg.text.replace(/\\(.)/g, '$1') : arg.text.replace(/["']/g, '');
    if (!spec) continue;
    const range = lines.range(start, end);
    refs.push(makeRef(file, spec, 'source', sourceCandidate(arg.text, node, script), range, around(symbols, range)));
  }
  return refs;
}

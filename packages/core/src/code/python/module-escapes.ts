import type { Node } from 'web-tree-sitter';
import type { CodeRange, CodeSymbol } from '../model.js';
import { nodeRange } from '../tree.js';
import type { ImportIndex, PyBinding } from './module-scope.js';

/**
 * A write an escaping module value can make: any attribute of the module an import names. `import` is the file's import
 * the value is bound by, which dispatch resolves to the module; absent when the parse cannot name the module at all.
 */
export interface ModuleEscape {
  receiver: string;
  name: string;
  import?: number;
  /** `import a.b` binds the package `a`, which the resolved submodule path still locates. */
  dotted?: boolean;
}

const IMPORT_STATEMENTS = new Set(['import_statement', 'import_from_statement', 'future_import_statement']);

/** Destructuring a write target may sit in: `a, b = …`, `[a, *b] = …`. */
const TARGET_PATTERNS = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'list_splat_pattern', 'as_pattern_target', 'parenthesized_expression']);

const before = (a: CodeRange['start'], b: CodeRange['start']): boolean => a.line < b.line || (a.line === b.line && a.column < b.column);
const inside = (at: CodeRange['start'], range: CodeRange): boolean => !before(at, range.start) && before(at, range.end);

/** Whether an identifier is a write target rather than a read: `x = …`, `for x in …`, `del x`, `x := …`. */
function inTarget(node: Node): boolean {
  let child: Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type === 'assignment' || parent.type === 'augmented_assignment') return parent.childForFieldName('left')?.id === child.id;
    if (parent.type === 'delete_statement' || parent.type === 'for_statement' || parent.type === 'for_in_clause') return parent.namedChildren.some((c) => c?.id === child.id);
    if (parent.type === 'named_expression') return parent.childForFieldName('name')?.id === child.id;
    if (!TARGET_PATTERNS.has(parent.type)) return false;
  }
  return false;
}

/** Whether an identifier is read as a value: not a write target, an attribute's object or name, a keyword's name, or an import. */
function readAsValue(node: Node): boolean {
  // The nearest ancestor outside parentheses decides an attribute or keyword position.
  let child: Node = node;
  let parent = node.parent;
  while (parent?.type === 'parenthesized_expression') {
    child = parent;
    parent = parent.parent;
  }
  if (parent?.type === 'attribute') return false;
  if (parent?.type === 'keyword_argument' && parent.childForFieldName('name')?.id === child.id) return false;
  // An import statement binds the name rather than reading its value.
  for (let up = node.parent; up; up = up.parent) if (IMPORT_STATEMENTS.has(up.type)) return false;
  return !inTarget(node);
}

/** The scopes a name is looked up in at `at`, innermost first; an enclosing class body is skipped as Python skips it. */
function scopesAt(symbols: readonly CodeSymbol[], at: CodeRange['start']): string[] {
  const holders = symbols.filter((symbol) => inside(at, symbol.range)).sort((a, b) => b.path.length - a.path.length);
  return [...holders.flatMap((holder, index) => (index === 0 || holder.kind !== 'class' ? [holder.id] : [])), ''];
}

/** The one binding of `name` the scopes resolve to, when it is an import binding. */
function importAt(bindings: readonly PyBinding[], scopes: readonly string[], name: string): PyBinding | undefined {
  for (const scope of scopes) {
    const scoped = bindings.filter((binding) => binding.scope === scope && binding.name === name && !binding.attr && !binding.alias && !binding.inherited);
    if (!scoped.length) continue;
    return scoped.length === 1 && scoped[0]!.kind === 'import' ? scoped[0] : undefined;
  }
  return undefined;
}

/** Whether a call is `importlib.import_module(…)` or `__import__(…)`, whose result is a module object. */
function importCall(node: Node): boolean {
  const fn = node.childForFieldName('function');
  if (fn?.type === 'identifier') return fn.text === '__import__';
  return (
    fn?.type === 'attribute' &&
    fn.childForFieldName('object')?.type === 'identifier' &&
    fn.childForFieldName('object')?.text === 'importlib' &&
    fn.childForFieldName('attribute')?.text === 'import_module'
  );
}

/** Whether a call's result is handed on: not the right side of a plain `name = …`, nor an attribute's object. */
function escapesCall(node: Node): boolean {
  let child: Node = node;
  let parent = node.parent;
  while (parent?.type === 'parenthesized_expression') {
    child = parent;
    parent = parent.parent;
  }
  if (parent?.type === 'attribute' && parent.childForFieldName('object')?.id === child.id) return false;
  return !(parent?.type === 'assignment' && parent.childForFieldName('right')?.id === child.id && parent.childForFieldName('left')?.type === 'identifier');
}

/**
 * The module writes an escaping module value makes (COD-59 round 3): an identifier that resolves through the file's
 * scopes to an import binding, used anywhere but as an attribute's object, and an import call whose result is handed
 * on. Each records `*` against the import that binds it, which dispatch resolves to the module; a non-literal import
 * call names no module, so its `*` counts for every module.
 */
export function moduleEscapes(root: Node, symbols: readonly CodeSymbol[], bindings: readonly PyBinding[], index: ImportIndex): ModuleEscape[] {
  const out = new Map<string, ModuleEscape>();
  const add = (escape: ModuleEscape): void => void out.set(`${escape.import ?? ''}\0${escape.receiver}`, escape);
  const visit = (node: Node): void => {
    if (node.type === 'identifier' && readAsValue(node)) {
      const binding = importAt(bindings, scopesAt(symbols, nodeRange(node).start), node.text);
      if (binding?.import !== undefined) add({ receiver: binding.name, name: '*', import: binding.import, ...(binding.dotted && { dotted: true }) });
    } else if (node.type === 'call' && importCall(node) && escapesCall(node)) {
      const at = index.get(node.id)?.at;
      add(at === undefined ? { receiver: '', name: '*' } : { receiver: '', name: '*', import: at });
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return [...out.values()];
}

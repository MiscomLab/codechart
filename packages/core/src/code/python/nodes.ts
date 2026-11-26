import type { Node } from 'web-tree-sitter';
import type { ImportedName } from '../model.js';

/** The text of a plain string literal (no f-string, no bytes, no interpolation, no escapes), or undefined. */
function literal(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'string') return undefined;
  const start = node.namedChildren.find((c) => c?.type === 'string_start')?.text ?? '';
  const prefix = start.replace(/['"]+$/, '').toLowerCase();
  // `b'x'` is bytes, which import functions reject; `f'x'` is computed at run time.
  if (prefix.includes('b') || prefix.includes('f') || prefix.includes('t')) return undefined;
  if (node.namedChildren.some((c) => c?.type === 'interpolation')) return undefined;
  const content = node.namedChildren.filter((c) => c?.type === 'string_content');
  if (content.some((c) => c!.namedChildren.some((e) => e?.type === 'escape_sequence'))) return undefined;
  return content.map((c) => c!.text).join('');
}

/** The identifiers of a dotted name or attribute chain; empty for anything else. */
function dotted(node: Node | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'identifier') return [node.text];
  if (node.type === 'dotted_name' || node.type === 'attribute') return node.namedChildren.flatMap((c) => dotted(c));
  return [];
}

/** The module a from-import names, as a spec: `a.b`, `.a.b` or `..`. */
function fromSpec(node: Node): string | undefined {
  const name = node.childForFieldName('module_name');
  if (!name) return undefined;
  if (name.type !== 'relative_import') return dotted(name).join('.') || undefined;
  let level = 0;
  let rest = '';
  for (const child of name.namedChildren) {
    if (child?.type === 'import_prefix') level += child.text.length;
    else rest = dotted(child).join('.');
  }
  return '.'.repeat(level) + rest;
}

/** The names a from-import binds: only the `name` fields, never the module it imports from. */
function fromNames(node: Node): ImportedName[] {
  return node.childrenForFieldName('name').flatMap((child): ImportedName[] => {
    if (child?.type === 'dotted_name') {
      const name = dotted(child).join('.');
      return name ? [{ imported: name, local: name }] : [];
    }
    if (child?.type === 'aliased_import') {
      const name = dotted(child.childForFieldName('name')).join('.');
      const alias = child.childForFieldName('alias')?.text;
      return name && alias ? [{ imported: name, local: alias }] : [];
    }
    return [];
  });
}

/** One module an `import` statement names. `dotted` is `import a.b` without an alias, which binds `a`, not `a.b`. */
export interface ImportedModule {
  spec: string;
  names: ImportedName[];
  kind: 'import' | 'dynamic';
  dotted?: string;
  /** `importlib.import_module('.x', 'pkg')`: the absolute module the relative name means. */
  anchored?: string;
}

/** `import a, b.c as d`: one module per name; a one-part name or an alias binds the module itself. */
function importModules(node: Node): ImportedModule[] {
  return node.childrenForFieldName('name').flatMap((child): ImportedModule[] => {
    if (child?.type === 'aliased_import') {
      const spec = dotted(child.childForFieldName('name')).join('.');
      const alias = child.childForFieldName('alias')?.text;
      return spec && alias ? [{ spec, kind: 'import', names: [{ imported: '*', local: alias }] }] : [];
    }
    const parts = dotted(child);
    if (!parts.length) return [];
    const spec = parts.join('.');
    return parts.length === 1 ? [{ spec, kind: 'import', names: [{ imported: '*', local: spec }] }] : [{ spec, kind: 'import', names: [], dotted: parts[0]! }];
  });
}

/** `.x` anchored at package `a.b` (`importlib.import_module('.x', 'a.b')`) as an absolute name; undefined above `a`. */
function anchored(spec: string, pkg: string): string | undefined {
  const level = spec.length - spec.replace(/^\.+/, '').length;
  const parts = pkg.split('.');
  if (level - 1 >= parts.length) return undefined;
  return [...parts.slice(0, parts.length - (level - 1)), ...(spec.slice(level) ? [spec.slice(level)] : [])].join('.');
}

/**
 * A module a call names at run time, and the name its result is bound to. `importlib.import_module('a.b')` returns
 * `a.b`, and a relative name is anchored at its literal `package` argument. `__import__('a.b')` returns the top-level
 * package `a`, so only a one-part `__import__` binds the module; any further `__import__` argument (fromlist, level)
 * changes what it returns, as does a keyword argument, so those are not read.
 */
function dynamicModule(node: Node): ImportedModule | undefined {
  const args = node.childForFieldName('arguments')?.namedChildren.filter((c): c is Node => !!c) ?? [];
  const isDunder = node.childForFieldName('function')?.type === 'identifier';
  const spec = literal(args[0]);
  if (!spec || args.some((a) => a.type === 'keyword_argument') || args.length > (isDunder ? 1 : 2)) return undefined;
  const pkg = spec.startsWith('.') ? literal(args[1]) : undefined;
  const absolute = pkg ? anchored(spec, pkg) : undefined;
  if (spec.startsWith('.') && !absolute) return undefined;
  const left = node.parent?.type === 'assignment' ? node.parent.childForFieldName('left') : undefined;
  const binds = left?.type === 'identifier' && !(isDunder && spec.includes('.'));
  return { spec, kind: 'dynamic', names: binds ? [{ imported: '*', local: left.text }] : [], ...(absolute && { anchored: absolute }) };
}

/** The modules one import statement or import call states. */
export function statedModules(main: Node, capture: string): ImportedModule[] {
  if (main.type === 'future_import_statement') return [{ spec: '__future__', names: [], kind: 'import' }];
  if (main.type === 'call') {
    const found = dynamicModule(main);
    return found ? [found] : [];
  }
  if (capture === 'from') {
    const spec = fromSpec(main);
    return spec === undefined ? [] : [{ spec, names: fromNames(main), kind: 'import' }];
  }
  return importModules(main);
}

export const isTypeChecking = (test: Node | null): boolean =>
  test?.type === 'identifier' ? test.text === 'TYPE_CHECKING' : test?.type === 'attribute' && test.childForFieldName('attribute')?.text === 'TYPE_CHECKING';

const SCOPES = new Set(['function_definition', 'class_definition', 'lambda']);

/** Whether a node runs only under a type checker: inside the body of `if TYPE_CHECKING:`, not its `else`. */
export function typeGuarded(node: Node): boolean {
  let child: Node = node;
  for (let up = node.parent; up; child = up, up = up.parent) {
    if (up.type === 'if_statement' && isTypeChecking(up.childForFieldName('condition')) && up.childForFieldName('consequence')?.id === child.id) return true;
    if (SCOPES.has(up.type)) return false;
  }
  return false;
}

const SYS_PATH_EDITS = new Set(['insert', 'append', 'extend', 'remove', 'pop', 'clear', '__setitem__', '__delitem__', '__iadd__', 'reverse', 'sort']);

const isSysPath = (node: Node | null | undefined): boolean => node?.type === 'attribute' && node.text.replace(/\s/g, '') === 'sys.path';

/** Whether the target of a write is `sys.path` itself or an item or slice of it. */
const writesSysPath = (target: Node | null | undefined): boolean =>
  !!target && (isSysPath(target) || (target.type === 'subscript' && isSysPath(target.childForFieldName('value'))));

/**
 * Whether a file changes `sys.path`: assigns or augments it or an item of it, deletes from it, or calls a mutating
 * method on it (`insert`, `append`, …), or adds a site directory. Reading `sys.path` changes nothing.
 */
export function editsSysPath(root: Node): boolean {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if ((node.type === 'assignment' || node.type === 'augmented_assignment') && writesSysPath(node.childForFieldName('left'))) return true;
    if (node.type === 'delete_statement' && node.namedChildren.some((c) => writesSysPath(c))) return true;
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'attribute' && isSysPath(fn.childForFieldName('object')) && SYS_PATH_EDITS.has(fn.childForFieldName('attribute')?.text ?? '')) return true;
      if (fn?.type === 'attribute' && fn.text.replace(/\s/g, '') === 'site.addsitedir') return true;
    }
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
  return false;
}

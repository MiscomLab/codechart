import type { Node } from 'web-tree-sitter';
import type { ImportedName } from '../model.js';

/** The text of a plain string literal, or undefined for anything else. */
export function literal(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'string') return undefined;
  const text = node.text;
  const quote = text.match(/^(?:[rbuf]{0,2})('''|"""|'|")/i)?.[1];
  if (!quote || !text.endsWith(quote)) return undefined;
  const body = text.slice(quote.length, -quote.length);
  return body.includes('\\') ? undefined : body;
}

/** The identifiers of a dotted name or attribute chain; empty for anything else. */
export function dotted(node: Node | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'identifier') return [node.text];
  if (node.type === 'dotted_name' || node.type === 'attribute') return node.namedChildren.flatMap((c) => dotted(c));
  return [];
}

/** The number of dots a `relative_import` starts with and the module after them. */
function relative(node: Node): { level: number; rest: string } {
  let level = 0;
  let rest = '';
  for (const child of node.namedChildren) {
    if (child?.type === 'import_prefix') level += child.text.length;
    else rest = dotted(child).join('.');
  }
  return { level, rest };
}

/** The module a from-import names, as a spec: `a.b`, `.a.b` or `..`. */
export function fromSpec(node: Node): string | undefined {
  const name = node.childForFieldName('module_name');
  if (!name) return undefined;
  if (name.type === 'relative_import') {
    const { level, rest } = relative(name);
    return '.'.repeat(level) + rest;
  }
  const parts = dotted(name);
  return parts.length ? parts.join('.') : undefined;
}

/** The names a from-import binds: `name` and `name as alias` after the module. */
export function fromNames(node: Node): ImportedName[] {
  return node.namedChildren.flatMap((child) => {
    if (child?.type === 'dotted_name') {
      const [first] = dotted(child);
      return first ? [{ imported: first, local: first }] : [];
    }
    if (child?.type === 'aliased_import') {
      const name = dotted(child.childForFieldName('name'))[0];
      const alias = dotted(child.childForFieldName('alias'))[0];
      return name && alias ? [{ imported: name, local: alias }] : [];
    }
    return [];
  });
}

/**
 * The names `import a.b as c` binds. `import a.b` binds the package `a` while the import resolves to `a/b.py`, so only
 * a one-segment module or an alias binds the module itself; the rest gets no binding and stays name-only.
 */
export function importNames(node: Node): ImportedName[] {
  return node.namedChildren.flatMap((child) => {
    if (child?.type === 'dotted_name') {
      const parts = dotted(child);
      return parts.length === 1 ? [{ imported: '*', local: parts[0]! }] : [];
    }
    if (child?.type === 'aliased_import') {
      const alias = dotted(child.childForFieldName('alias'))[0];
      return alias ? [{ imported: '*', local: alias }] : [];
    }
    return [];
  });
}

const SCOPES = new Set(['function_definition', 'lambda', 'class_definition']);

/** The nearest function, lambda or class around a node: undefined in module scope, `if`, `try` and `with` included. */
export function owner(node: Node | null | undefined): Node | undefined {
  for (let up = node?.parent; up; up = up.parent) if (SCOPES.has(up.type)) return up;
  return undefined;
}

const isTypeChecking = (test: Node | null): boolean =>
  test?.type === 'identifier' ? test.text === 'TYPE_CHECKING' : test?.type === 'attribute' && test.childForFieldName('attribute')?.text === 'TYPE_CHECKING';

/** Whether a node sits where only a type checker runs it: `if TYPE_CHECKING:` or an `except ImportError:` body. */
export function typeGuarded(node: Node): boolean {
  for (let up = node.parent; up; up = up.parent) {
    if (up.type === 'if_statement' && isTypeChecking(up.childForFieldName('condition'))) return true;
    if (up.type === 'except_clause') {
      const type = up.namedChildren[0];
      if (type?.text === 'ImportError' || (type?.type === 'tuple' && type.namedChildren.some((c) => c?.text === 'ImportError'))) return true;
    }
    if (SCOPES.has(up.type)) break;
  }
  return false;
}

/** A module spec a call names at run time, and the name its result is bound to. */
export function dynamic(node: Node): { spec: string; bind?: string } | undefined {
  const args = node.childForFieldName('arguments');
  const spec = literal(args?.namedChildren.find((c) => c?.type === 'string'));
  if (!spec) return undefined;
  const parent = node.parent;
  const bind = parent?.type === 'assignment' ? dotted(parent.childForFieldName('left'))[0] : undefined;
  return { spec, ...(bind && { bind }) };
}

/** Whether a file edits `sys.path`, which makes every absolute import's target unprovable. */
export function editsSysPath(root: Node): boolean {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'attribute' && node.childForFieldName('object')?.text === 'sys' && node.childForFieldName('attribute')?.text === 'path') return true;
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
  return false;
}

/** What one import statement states, once its spec and bindings are read. */
export function stated(main: Node, capture: string): { spec: string; names: ImportedName[]; kind: 'import' | 'dynamic' } | undefined {
  if (main.type === 'future_import_statement') return { spec: '__future__', names: [], kind: 'import' };
  if (main.type === 'call') {
    const found = dynamic(main);
    return found ? { spec: found.spec, names: found.bind ? [{ imported: '*', local: found.bind }] : [], kind: 'dynamic' } : undefined;
  }
  if (capture === 'from') {
    const spec = fromSpec(main);
    return spec === undefined ? undefined : { spec, names: fromNames(main), kind: 'import' };
  }
  const spec = dotted(main.childForFieldName('name')).join('.');
  return spec ? { spec, names: importNames(main), kind: 'import' } : undefined;
}

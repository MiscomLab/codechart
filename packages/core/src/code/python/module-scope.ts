import type { Node } from 'web-tree-sitter';
import type { ModuleExports } from '../imports.js';
import { dotted, literal } from './nodes.js';

const ASSIGNMENTS = new Set(['assignment', 'typed_assignment']);
/** Statements whose body runs at module scope, so the names it binds are the module's. */
const BLOCKS = new Set(['if_statement', 'try_statement', 'with_statement', 'for_statement', 'while_statement']);

/** The name a `def` or `class` declares, through the `decorated_definition` that may wrap it. */
function definitionName(node: Node): string | undefined {
  const inner = node.childForFieldName('definition');
  return inner ? definitionName(inner) : node.childForFieldName('name')?.text;
}

/** The names a literal `__all__ = ["a", "b"]` lists, or undefined when the list is computed. */
function literalAll(node: Node): string[] | undefined {
  const value = node.type === 'assignment' ? node.childForFieldName('right') : node.namedChildren[1];
  const list = value?.type === 'list' || value?.type === 'tuple' ? value : undefined;
  if (!list) return undefined;
  const names = list.namedChildren.map((c) => literal(c));
  return names.length && names.every((n): n is string => !!n) ? names : undefined;
}

/** Whether a wildcard import runs at module scope. */
function hasWildcard(root: Node): boolean {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    let scoped = false;
    for (let up = node.parent; up; up = up.parent) if (up.type === 'function_definition' || up.type === 'class_definition' || up.type === 'lambda') scoped = true;
    if (node.type === 'wildcard_import' && !scoped) return true;
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
  return false;
}

/** The names a module binds at its own scope by definition or assignment, and whether `__getattr__` can add more. */
function localNames(root: Node): { names: string[]; open: boolean; all?: string[] } {
  const names: string[] = [];
  let open = false;
  let all: string[] | undefined;
  const walk = (node: Node) => {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'function_definition' || child.type === 'class_definition' || child.type === 'decorated_definition') {
        const name = definitionName(child);
        if (name === '__getattr__') open = true;
        if (name) names.push(name);
        continue;
      }
      if (child.type === 'expression_statement') {
        const expression = child.namedChildren[0];
        if (!expression || !ASSIGNMENTS.has(expression.type)) continue;
        // `__all__` names what a star import exports; a computed one leaves the list open.
        if (expression.childForFieldName('left')?.text === '__all__') {
          const listed = literalAll(expression);
          if (listed) all ??= listed;
          else open = true;
          continue;
        }
        names.push(...dotted(expression.childForFieldName('left')));
        continue;
      }
      // `if`, `try` and `with` run at module scope, so the names their bodies bind are the module's too.
      if (BLOCKS.has(child.type)) walk(child);
    }
  };
  walk(root);
  return { names, open, ...(all && { all }) };
}

/**
 * The names a Python module exports by its own definitions and assignments, in source order, and whether the list is
 * complete: a wildcard import, a `def __getattr__` or a computed `__all__` mean names can come from anywhere.
 */
export function moduleExports(root: Node): { exports: ModuleExports; all?: string[] } {
  const local = localNames(root);
  const names: ModuleExports['names'] = [];
  for (const name of local.names) {
    if (names.some((n) => n.name === name)) continue;
    names.push({ name });
  }
  return { exports: { names, complete: !hasWildcard(root) && !local.open }, ...(local.all && { all: local.all }) };
}

/** An assignment whose right side is a plain call of a plain name: `service = PaymentService("x")`. */
function construction(expression: Node): { name?: string; built?: string } {
  if (expression.type !== 'assignment') return {};
  const [name] = dotted(expression.childForFieldName('left'));
  const value = expression.childForFieldName('right');
  const callee = value?.type === 'call' ? value.childForFieldName('function') : undefined;
  return { name, ...(name && callee?.type === 'identifier' && { built: callee.text }) };
}

/** `name = Class(…)` bindings at module or function scope, which a `name.method()` call can follow to the method. */
export function constructed(root: Node): { name: string; constructor: string; scope: string[] }[] {
  const out: { name: string; constructor: string; scope: string[] }[] = [];
  const walk = (node: Node, scope: string[]) => {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'function_definition' || child.type === 'class_definition' || child.type === 'decorated_definition') {
        const inner = child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
        const name = inner?.childForFieldName('name')?.text;
        const body = inner?.childForFieldName('body');
        if (inner?.type === 'function_definition' && body) walk(body, [...scope, ...(name ? [name] : [])]);
        continue;
      }
      if (child.type === 'expression_statement') {
        const found = construction(child.namedChildren[0] ?? child);
        if (found.name && found.built) out.push({ name: found.name, constructor: found.built, scope });
        continue;
      }
      // A conditional or loop at module or function scope runs in the same scope.
      if (BLOCKS.has(child.type) || child.type === 'block') walk(child, scope);
    }
  };
  walk(root, []);
  return out;
}

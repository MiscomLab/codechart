import type { Node } from 'web-tree-sitter';
import { exemptKinds, type ExemptKind } from './js-types.js';
import type { CodeRange } from './model.js';

/** A binding pattern's names, in source order: `{ a, b: [c], ...d }` binds `a`, `c`, `d`; defaults bind nothing. */
export function patternNames(node: Node | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') return [node.text];
  if (node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern') return patternNames(node.childForFieldName('left'));
  if (node.type === 'pair_pattern') return patternNames(node.childForFieldName('value'));
  if (PATTERNS.has(node.type)) return node.namedChildren.flatMap((child) => patternNames(child));
  return [];
}

const PATTERNS = new Set(['array_pattern', 'object_pattern', 'rest_pattern', 'parenthesized_expression']);

/** Every name a function-like node's parameters bind, from `formal_parameters` or a lone arrow parameter. */
export function parameterBindings(node: Node, typescript: boolean, declared: ReadonlySet<string>): { name: string; exempt?: readonly ExemptKind[] }[] {
  const out: { name: string; exempt?: readonly ExemptKind[] }[] = [];
  for (const parameter of node.childForFieldName('parameters')?.namedChildren ?? []) {
    if (!parameter) continue;
    const typed = parameter.type === 'required_parameter' || parameter.type === 'optional_parameter';
    const pattern = typed ? parameter.childForFieldName('pattern') : parameter;
    // Only a plain identifier's own annotation counts: a destructured parameter declares no single type.
    const exempt = typed && typescript && pattern?.type === 'identifier' ? exemptKinds(parameter.childForFieldName('type'), declared) : [];
    for (const name of patternNames(pattern)) out.push({ name, ...(exempt.length && { exempt }) });
  }
  for (const name of patternNames(node.childForFieldName('parameter'))) out.push({ name });
  return out;
}

/** Identifiers a write target binds: an identifier or a destructuring pattern, never a member or subscript. */
function addTargets(node: Node | null | undefined, out: Node[]): void {
  if (!node) return;
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
    out.push(node);
    return;
  }
  if (node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern') return addTargets(node.childForFieldName('left'), out);
  if (node.type === 'pair_pattern') return addTargets(node.childForFieldName('value'), out);
  // A cast on the left still writes the binding under it; only the expression child counts, never the type.
  if (node.type === 'as_expression' || node.type === 'satisfies_expression') return addTargets(node.namedChildren[0], out);
  if (node.type === 'type_assertion') return addTargets(node.namedChildren.find((child) => child?.type !== 'type_arguments'), out);
  if (WRITE_PATTERNS.has(node.type)) for (const child of node.namedChildren) addTargets(child, out);
}

const WRITE_PATTERNS = new Set(['array_pattern', 'object_pattern', 'rest_pattern', 'parenthesized_expression', 'non_null_expression']);

/** Whether an `assignment_expression` is really a `using` declaration, which this grammar parses as an assignment. */
export const isUsing = (node: Node): boolean => node.children.some((child) => child?.type === 'using');

/**
 * Every identifier the file writes: `=`, compound assignment, `++`/`--`, destructuring assignment and a `for (x of …)`
 * without a declaration. Which binding a write reaches decides whether it rules out a `let`/`var` function value.
 */
export function writeTargets(root: Node): Node[] {
  const out: Node[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'assignment_expression' && !isUsing(node)) addTargets(node.childForFieldName('left'), out);
    else if (node.type === 'augmented_assignment_expression') addTargets(node.childForFieldName('left'), out);
    else if (node.type === 'update_expression') addTargets(node.namedChildren[0], out);
    else if (node.type === 'for_in_statement' && !node.childForFieldName('kind')) addTargets(node.childForFieldName('left'), out);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return out;
}

/** Each name an `import x = …` or `import x = require(…)` binds; neither binds a value a call can reach. */
export function importNames(node: Node): string[] {
  const identifier =
    node.type === 'import_alias'
      ? node.namedChildren.find((child) => child?.type === 'identifier')
      : node.namedChildren.find((child) => child?.type === 'import_require_clause')?.namedChildren.find((child) => child?.type === 'identifier');
  return identifier ? [identifier.text] : [];
}

/** Expressions that wrap a value without changing it: casts, parentheses and a non-null assertion. */
const WRAPPERS = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'type_assertion']);

/** A value expression with the casts and parentheses around it removed. */
export function unwrapExpression(value: Node | null | undefined): Node | undefined {
  let current: Node | undefined = value ?? undefined;
  while (current && WRAPPERS.has(current.type)) {
    current = (current.type === 'type_assertion' ? current.namedChildren.find((child) => child?.type !== 'type_arguments') : current.namedChildren[0]) ?? undefined;
  }
  return current;
}

/** A variable initializer that names another binding: `const Base = K` and `const Base = ns.K` both name `K`. */
export function aliasName(value: Node | null | undefined): string | undefined {
  const node = unwrapExpression(value);
  if (node?.type === 'identifier' || node?.type === 'type_identifier') return node.text;
  return node?.type === 'member_expression' ? node.childForFieldName('property')?.text : undefined;
}

/** Whether a statement list opens with a `"use strict"` directive, in its directive prologue. */
export function startsWithUseStrict(node: Node): boolean {
  for (const child of node.namedChildren) {
    const expression = child?.type === 'expression_statement' ? child.namedChildren[0] : undefined;
    if (expression?.type !== 'string') return false;
    if (expression.text.slice(1, -1) === 'use strict') return true;
  }
  return false;
}

/** Whether the file is an ES module, whose code is strict. */
const isModule = (root: Node): boolean =>
  root.namedChildren.some((child) => child?.type === 'import_statement' || child?.type === 'export_statement');

/** A file is strict when it is `.mjs`/`.mts`, a module, or starts with a `"use strict"` directive. */
export const strictFile = (path: string, root: Node): boolean => /\.m[jt]s$/i.test(path) || isModule(root) || startsWithUseStrict(root);

/** A tree-sitter node's start, in core's `CodeRange` convention: 1-based line, 0-based column. */
export const pointOf = (node: Node): CodeRange['start'] => ({ line: node.startPosition.row + 1, column: node.startPosition.column });

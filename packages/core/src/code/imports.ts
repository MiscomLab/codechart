import type { Node, Query, Tree } from 'web-tree-sitter';
import type { Import, ImportedName } from './model.js';
import { nodeRange } from './symbols.js';

/** Finds import statements, re-exports, `require('x')`, `import('x')` and CommonJS exports; shared by the JS and TS grammars. */
export const IMPORTS_QUERY = `
(import_statement) @import
(export_statement) @export
(call_expression function: (identifier) @fn arguments: (arguments . [(string) (template_string)] @src) (#eq? @fn "require")) @require
(call_expression function: (import) arguments: (arguments . [(string) (template_string)] @src)) @dynamic
(member_expression object: (identifier) @cjs (#match? @cjs "^(module|exports)$"))
`;

/** An import as one file states it, before resolution. */
export type ImportSpec = Omit<Import, 'resolved' | 'status'>;

/** A name the file exports from its own scope; `local` is the binding behind `export { local as name }` or `export default local`. */
export interface ExportName {
  name: string;
  local?: string;
}

/** What a file exports itself. `complete` is false when it may export more than `names` (CommonJS, `export =`, syntax errors). */
export interface ModuleExports {
  names: ExportName[];
  complete: boolean;
}

type Stated = Omit<ImportSpec, 'file'>;

const STATEMENTS = new Set(['import', 'export']);

/** The text of a string literal, or of a template literal without `${}`; undefined for anything else. */
function literal(node: Node | null | undefined): string | undefined {
  if (node?.type === 'string') return node.text.slice(1, -1);
  if (node?.type === 'template_string' && !node.namedChildren.some((c) => c?.type === 'template_substitution')) return node.text.slice(1, -1);
  return undefined;
}

const nameOf = (node: Node): string => literal(node) ?? node.text;
const hasToken = (node: Node, token: string) => node.children.some((c) => c?.type === token);

function specifierNames(list: Node, typeOnly: boolean): ImportedName[] {
  return list.namedChildren.flatMap((s) => {
    const name = s?.childForFieldName('name');
    if (!s || !name) return [];
    const alias = s.childForFieldName('alias');
    const entry: ImportedName = { imported: nameOf(name), local: nameOf(alias ?? name) };
    return typeOnly || hasToken(s, 'type') ? [{ ...entry, typeOnly: true }] : [entry];
  });
}

function importClauseNames(clause: Node, typeOnly: boolean): ImportedName[] {
  const flag = typeOnly ? { typeOnly: true } : {};
  return clause.namedChildren.flatMap((c): ImportedName[] => {
    if (c?.type === 'identifier') return [{ imported: 'default', local: c.text, ...flag }];
    const ns = c?.type === 'namespace_import' ? c.namedChildren[0] : undefined;
    if (ns) return [{ imported: '*', local: ns.text, ...flag }];
    return c?.type === 'named_imports' ? specifierNames(c, typeOnly) : [];
  });
}

function fromImport(node: Node): Stated | undefined {
  const required = node.namedChildren.find((c) => c?.type === 'import_require_clause');
  if (required) {
    const spec = literal(required.childForFieldName('source'));
    return spec === undefined ? undefined : { spec, kind: 'require', range: nodeRange(node) };
  }
  const spec = literal(node.childForFieldName('source'));
  if (spec === undefined) return undefined;
  const typeOnly = hasToken(node, 'type');
  const clause = node.namedChildren.find((c) => c?.type === 'import_clause');
  const names = clause ? importClauseNames(clause, typeOnly) : [];
  return { spec, kind: 'import', ...(typeOnly && { typeOnly }), names, range: nodeRange(node) };
}

function reexportNames(node: Node, typeOnly: boolean): ImportedName[] {
  const clause = node.namedChildren.find((c) => c?.type === 'export_clause');
  if (clause) return specifierNames(clause, typeOnly);
  const ns = node.namedChildren.find((c) => c?.type === 'namespace_export')?.namedChildren[0];
  const entry = { imported: '*', local: ns ? nameOf(ns) : '*' };
  return [typeOnly ? { ...entry, typeOnly } : entry];
}

const DECLARED_NAMES: Record<string, (n: Node) => Node[]> = {
  lexical_declaration: (n) => n.namedChildren.flatMap((d) => (d?.type === 'variable_declarator' ? bindings(d.childForFieldName('name')) : [])),
};
DECLARED_NAMES.variable_declaration = DECLARED_NAMES.lexical_declaration!;

/** Identifiers a declaration name binds, destructuring patterns included. */
function bindings(node: Node | null): Node[] {
  if (!node) return [];
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') return [node];
  const value = node.type === 'pair_pattern' ? node.childForFieldName('value') : undefined;
  if (value) return bindings(value);
  return node.namedChildren.flatMap((c) => (c && c.type !== 'property_identifier' ? bindings(c) : []));
}

function declarationNames(decl: Node): string[] {
  const inner = decl.type === 'ambient_declaration' ? decl.namedChildren[0] : decl;
  if (!inner) return [];
  const many = DECLARED_NAMES[inner.type];
  if (many) return many(inner).map((n) => n.text);
  const name = inner.childForFieldName('name');
  return name ? [name.text] : [];
}

/** The names an `export` statement without `from` adds; undefined for `export =`, which makes the exports unknowable. */
function localExports(node: Node): ExportName[] | undefined {
  if (hasToken(node, '=')) return undefined;
  if (hasToken(node, 'default')) {
    const value = node.childForFieldName('value');
    return [value?.type === 'identifier' ? { name: 'default', local: value.text } : { name: 'default' }];
  }
  const decl = node.childForFieldName('declaration');
  if (decl) return declarationNames(decl).map((name) => ({ name }));
  const clause = node.namedChildren.find((c) => c?.type === 'export_clause');
  return clause ? specifierNames(clause, false).map((s) => ({ name: s.local, local: s.imported })) : [];
}

function fromCall(node: Node, kind: 'require' | 'dynamic', src: Node): Stated | undefined {
  const spec = literal(src);
  if (spec === undefined) return undefined;
  let up = node.parent;
  while (up && up.type !== 'type_query' && !up.type.endsWith('statement')) up = up.parent;
  return { spec, kind, ...(up?.type === 'type_query' && { typeOnly: true }), range: nodeRange(node) };
}

/**
 * The imports and own exports of a parsed file. Statements inside a syntax error are skipped, as is `require()` or
 * `import()` of anything but a plain string: its target is decided at run time.
 */
export function extractImports(file: string, tree: Tree, query: Query): { imports: ImportSpec[]; exports: ModuleExports } {
  const imports: ImportSpec[] = [];
  const exports: ModuleExports = { names: [], complete: !tree.rootNode.hasError };
  for (const match of query.matches(tree.rootNode)) {
    const [main] = match.captures.filter((c) => c.name !== 'fn' && c.name !== 'src');
    const src = match.captures.find((c) => c.name === 'src')?.node;
    // Statements in `namespace` or `declare module` blocks are not the file's own imports and exports.
    if (!main || main.node.hasError || (STATEMENTS.has(main.name) && main.node.parent?.type !== 'program')) continue;
    const node = main.node;
    let spec: Stated | undefined;
    if (main.name === 'cjs') exports.complete = false;
    else if (main.name === 'import') spec = fromImport(node);
    else if (main.name === 'export') {
      const source = literal(node.childForFieldName('source'));
      const typeOnly = hasToken(node, 'type');
      if (source !== undefined) spec = { spec: source, kind: 'export', ...(typeOnly && { typeOnly }), names: reexportNames(node, typeOnly), range: nodeRange(node) };
      else {
        const names = localExports(node);
        if (names) exports.names.push(...names);
        else exports.complete = false;
      }
    } else if (src) spec = fromCall(node, main.name as 'require' | 'dynamic', src);
    if (spec) imports.push({ ...spec, file });
  }
  return { imports, exports };
}

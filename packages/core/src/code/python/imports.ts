import type { Query, Tree } from 'web-tree-sitter';
import type { Import, ImportedName } from '../model.js';
import type { ModuleExports } from '../imports.js';
import { constructed, moduleExports } from './module-scope.js';
import { nodeRange } from '../tree.js';
import { editsSysPath, owner, stated, typeGuarded } from './nodes.js';

/**
 * Finds Python imports and the calls that name a module at run time: `import`, `from … import`, and
 * `importlib.import_module('x')` / `__import__('x')` with a literal name.
 */
export const PYTHON_IMPORTS_QUERY = `
(import_statement) @import
(import_from_statement) @from
(future_import_statement) @from
(call
  function: (attribute object: (identifier) @mod attribute: (identifier) @fn)
  (#eq? @mod "importlib")
  (#eq? @fn "import_module")) @dynamic
(call function: (identifier) @fn (#eq? @fn "__import__")) @dynamic
`;

/** An import as one file states it, before resolution. */
export type ImportSpec = Omit<Import, 'resolved' | 'status'>;

/** What parsing a Python file brings to `ParsedFile`, beyond its symbols and calls. */
export interface PythonFile {
  imports: ImportSpec[];
  exports: ModuleExports;
  /** Imports a syntax error hid, so the last good version can stand in for them. */
  hidden: ImportSpec[];
  /** `name = Class(…)` bindings, which let a `name.method()` call find the class's method. */
  assignments: { name: string; constructor: string; scope: string[] }[];
  /** The file edits `sys.path`, so no absolute import's target is provable. */
  sysPathEdited: boolean;
}

/**
 * The imports and own exports of a parsed Python file. Every module-level definition, assignment and import binding is
 * an export, which is how a package's `__init__.py` re-exports through the shared tracer. A name both bound locally
 * and imported, or bound twice, means the export list is not complete.
 */
export function extractPythonImports(file: string, tree: Tree, query: Query): PythonFile {
  const imports: ImportSpec[] = [];
  const hidden: ImportSpec[] = [];
  const moduleBindings: ImportedName[] = [];
  const seen = new Set<number>();
  for (const match of query.matches(tree.rootNode)) {
    const capture = match.captures.find((c) => c.name !== 'mod' && c.name !== 'fn' && !(c.node.type === 'attribute' && c.node.parent?.type === 'call'));
    if (!capture || seen.has(capture.node.id)) continue;
    seen.add(capture.node.id);
    const main = capture.node;
    const typeOnly = typeGuarded(main);
    const statement = stated(main, capture.name);
    if (!statement) continue;
    const base = { file, spec: statement.spec, kind: statement.kind, ...(typeOnly && { typeOnly }), range: nodeRange(main) };
    if (main.hasError) {
      hidden.push({ ...base, names: statement.names });
      continue;
    }
    imports.push({ ...base, names: statement.names });
    // A name bound at module scope is exported by the file, so a package's `__init__.py` re-exports its imports.
    if (owner(main) || typeOnly || statement.spec === '__future__') continue;
    for (const name of statement.names) if (name.local !== 'TYPE_CHECKING') moduleBindings.push(name);
  }
  const { exports, all } = moduleExports(tree.rootNode);
  const own = new Set(exports.names.map((n) => n.name));
  let complete = exports.complete;
  for (const binding of moduleBindings) {
    // A definition and an import binding the same name: which wins depends on the line the import runs on.
    if (own.has(binding.local)) {
      complete = false;
      continue;
    }
    own.add(binding.local);
    exports.names.push({ name: binding.local, local: binding.imported });
  }
  // `__all__` narrows a star import to the names it lists; a computed one leaves the list open.
  const names: ModuleExports['names'] = all ? exports.names.filter((n) => all.includes(n.name)) : exports.names;
  return { imports, exports: { names, complete }, hidden, assignments: constructed(tree.rootNode), sysPathEdited: editsSysPath(tree.rootNode) };
}

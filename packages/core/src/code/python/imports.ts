import type { Node, Query, Tree } from 'web-tree-sitter';
import type { ModuleExports } from '../imports.js';
import type { CodeSymbol, Import } from '../model.js';
import { nodeRange } from '../tree.js';
import { collectBindings, moduleExports, type PyBinding, type PyDefinition } from './module-scope.js';
import { editsSysPath, statedModules, typeGuarded } from './nodes.js';

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
type ImportSpec = Omit<Import, 'resolved' | 'status'>;

/** What parsing a Python file brings to `ParsedFile`, beyond its symbols and calls. */
export interface PythonFile {
  imports: ImportSpec[];
  exports: ModuleExports;
  /** Imports a syntax error hid, so the last good version can stand in for them. */
  hidden: ImportSpec[];
  /** Every name each scope binds, which call linking reads to decide what a name means where it is called. */
  bindings: PyBinding[];
  /** Each definition's scope id and body start, so a call in its header looks up in the enclosing scope. */
  defs: PyDefinition[];
  /** The file edits `sys.path`, so no absolute import's target is provable. */
  sysPathEdited: boolean;
}

function hasWildcard(root: Node): boolean {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'wildcard_import') return true;
    for (const child of node.namedChildren) if (child && child.type !== 'function_definition' && child.type !== 'class_definition') stack.push(child);
  }
  return false;
}

/**
 * The imports, scope bindings and own exports of a parsed Python file. `symbols` are the file's symbols, which give each
 * function and class scope its id. A module's exports are the names its own scope binds exactly once, imports
 * included, which is how a package's `__init__.py` re-exports through the shared tracer.
 */
export function extractPythonImports(file: string, tree: Tree, query: Query, symbols: readonly CodeSymbol[]): PythonFile {
  const imports: ImportSpec[] = [];
  const hidden: ImportSpec[] = [];
  const index = new Map<number, { locals: { name: string; dotted: boolean; index: number }[]; typeOnly: boolean; wildcard: boolean }>();
  const seen = new Set<number>();
  for (const match of query.matches(tree.rootNode)) {
    const capture = match.captures.find((c) => c.name !== 'mod' && c.name !== 'fn');
    if (!capture || seen.has(capture.node.id)) continue;
    seen.add(capture.node.id);
    const main = capture.node;
    const typeOnly = typeGuarded(main);
    const locals: { name: string; dotted: boolean; index: number }[] = [];
    let stated = false;
    for (const module of statedModules(main, capture.name)) {
      const spec: ImportSpec = { file, spec: module.spec, kind: module.kind, ...(module.anchored && { anchored: module.anchored }), ...(typeOnly && { typeOnly }), names: typeOnly ? module.names.map((n) => ({ ...n, typeOnly: true })) : module.names, range: nodeRange(main) };
      if (main.hasError) {
        hidden.push(spec);
        continue;
      }
      stated = true;
      const at = imports.push(spec) - 1;
      for (const name of module.names) locals.push({ name: name.local, dotted: false, index: at });
      if (module.dotted) locals.push({ name: module.dotted, dotted: true, index: at });
    }
    const wildcard = main.namedChildren.some((c) => c?.type === 'wildcard_import');
    if (stated) index.set(main.id, { locals, typeOnly, wildcard });
  }
  const { bindings, defs } = collectBindings(tree.rootNode, symbols, index);
  return { imports, exports: moduleExports(bindings, hasWildcard(tree.rootNode)), hidden, bindings, defs, sysPathEdited: editsSysPath(tree.rootNode) };
}

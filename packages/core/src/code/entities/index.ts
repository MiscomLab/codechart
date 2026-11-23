import type { Node, Query, Tree } from 'web-tree-sitter';
import { entityId, type CodeEntity, type CodeRef, type EntityKind } from '../model.js';
import type { EntityGrammar } from '../languages.js';
import { extractSymbols, type Extracted } from '../symbols.js';
import { errorNodes, touches } from '../tree.js';
import { bashRefs } from './bash.js';
import { isPackageJson, packageScripts, scriptRefs } from './package-json.js';
import { sqlTables } from './sql.js';
import { Lines } from './text.js';
import { cssRefs, htmlRefs } from './web.js';
import { composeEntities, isCompose, isWorkflow, workflowEntities } from './workflow.js';
import { yamlRoot } from './yaml.js';

/** What a file without imports holds; `broken` has the ids of entities parsed in or around a syntax error. */
export interface EntityExtract {
  entities: CodeEntity[];
  broken: Set<string>;
  refs: CodeRef[];
  /** Bash functions. */
  symbols?: Extracted;
}

interface Found {
  path: string[];
  kind: EntityKind;
  node: Node;
}

/** A node's range without the line breaks and blanks a YAML block node ends with. */
function trimmedRange(node: Node, lines: Lines, text: string) {
  let end = node.endIndex;
  while (end > node.startIndex && /\s/.test(text[end - 1]!)) end--;
  return lines.range(node.startIndex, end);
}

/** Gives each found entity its id, numbering a repeated identity `~2`, `~3`… in source order. */
function identify<T extends Found>(file: string, found: readonly T[], errors: readonly Node[], lines: Lines, text: string) {
  const counts = new Map<string, number>();
  const ids = new Map<T, string>();
  const entities: CodeEntity[] = [];
  const broken = new Set<string>();
  for (const f of found) {
    const base = entityId(file, f.path, f.kind);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const id = count > 1 ? `${base}~${count}` : base;
    ids.set(f, id);
    entities.push({ id, file, path: f.path, kind: f.kind, range: trimmedRange(f.node, lines, text) });
    if (errors.some((e) => touches(f.node, e))) broken.add(id);
  }
  return { entities, broken, idOf: (f: T) => ids.get(f) };
}

const nonEmpty = <T extends Found>(found: T[]): T[] => found.filter((f) => f.path.every((p) => p.trim()));

function yamlEntities(path: string, text: string, tree: Tree, lines: Lines, errors: Node[]): EntityExtract {
  const root = isWorkflow(path) || isCompose(path) ? yamlRoot(text, tree.rootNode) : undefined;
  if (isWorkflow(path)) {
    const { found, refs } = workflowEntities(path, root, lines);
    const { entities, broken, idOf } = identify(path, nonEmpty(found), errors, lines, text);
    return { entities, broken, refs: refs(idOf) };
  }
  if (isCompose(path)) return { ...identify(path, nonEmpty(composeEntities(root)), errors, lines, text), refs: [] };
  return { entities: [], broken: new Set(), refs: [] };
}

function jsonEntities(path: string, text: string, tree: Tree, lines: Lines, errors: Node[]): EntityExtract {
  if (!isPackageJson(path)) return { entities: [], broken: new Set(), refs: [] };
  const scripts = packageScripts(tree.rootNode)
    .filter((s) => s.name.trim())
    .map((s) => ({ ...s, path: [s.name], kind: 'script' as const }));
  const { entities, broken, idOf } = identify(path, scripts, errors, lines, text);
  return { entities, broken, refs: scripts.flatMap((s) => scriptRefs(path, s, lines, idOf(s))) };
}

/** Entities and references of a file in a language without imports, from its syntax tree. */
export function extractEntities(path: string, text: string, tree: Tree, grammar: EntityGrammar, tags: Query | undefined): EntityExtract {
  const lines = new Lines(text);
  const errors = tree.rootNode.hasError ? errorNodes(tree.rootNode) : [];
  const none = { entities: [], broken: new Set<string>(), refs: [] };
  switch (grammar) {
    case 'sql':
      return { ...identify(path, sqlTables(tree).map((t) => ({ ...t, kind: 'table' as const })), errors, lines, text), refs: [] };
    case 'yaml':
      return yamlEntities(path, text, tree, lines, errors);
    case 'json':
      return jsonEntities(path, text, tree, lines, errors);
    case 'html':
      return { ...none, refs: htmlRefs(path, tree, lines) };
    case 'css':
      return { ...none, refs: cssRefs(path, tree, lines) };
    case 'bash': {
      const symbols = extractSymbols(path, tree, tags!, 'bash');
      return { ...none, refs: bashRefs(path, tree, lines, symbols.symbols), symbols };
    }
  }
}

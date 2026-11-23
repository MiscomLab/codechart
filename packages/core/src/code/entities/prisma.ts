import type { Node } from 'web-tree-sitter';
import type { CodeRef } from '../model.js';
import type { Lines } from './text.js';

type DeclarationKind = 'model' | 'enum' | 'view' | 'type';

/** A top-level `model`, `enum`, `view` or composite `type` block. */
export interface PrismaDeclaration {
  path: [string];
  kind: DeclarationKind;
  node: Node;
}

const KINDS: Record<string, DeclarationKind> = {
  model_declaration: 'model',
  enum_declaration: 'enum',
  view_declaration: 'view',
  type_declaration: 'type',
};

/** Prisma's scalar types; `Unsupported("…")` is a call, not a name. */
const SCALARS = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes']);

const child = (node: Node, type: string): Node | undefined => node.namedChildren.find((c) => c?.type === type) ?? undefined;

/** The file's declarations in source order. A `type` counts only as a block: the grammar's alias forms are not Prisma. */
export function prismaDeclarations(root: Node): PrismaDeclaration[] {
  const out: PrismaDeclaration[] = [];
  for (const node of root.namedChildren) {
    const kind = node && KINDS[node.type];
    if (!node || !kind || (kind === 'type' && !child(node, 'statement_block'))) continue;
    const name = node.namedChildren[0];
    if (name?.type === 'identifier' && name.text) out.push({ path: [name.text], kind, node });
  }
  return out;
}

/** Each field of a model typed with a name: `User`, `User?`, `User[]`; scalars left out. */
function* typedFields(model: Node): Generator<{ field: Node; type: Node; list: boolean }> {
  const block = child(model, 'statement_block');
  for (const field of block?.namedChildren ?? []) {
    if (field?.type !== 'column_declaration') continue;
    const column = child(field, 'column_type');
    const type = column?.namedChildren[0];
    if (type?.type === 'identifier' && !SCALARS.has(type.text)) yield { field, type, list: !!child(column!, 'array') };
  }
}

/** The names in a list of plain identifiers, `[a, b]`; undefined for anything else or an empty list. */
function names(value: Node | undefined): string[] | undefined {
  const items = value?.type === 'array' ? value.namedChildren : [];
  return items.length && items.every((i) => i?.type === 'identifier') ? items.map((i) => i!.text) : undefined;
}

/** Whether an attribute is `@relation` or `@relation(…)`; `@db.relation` is another namespace's. */
const isRelation = (attribute: Node): boolean => {
  const head = attribute.namedChildren[0];
  const callee = head?.type === 'call_expression' ? head.namedChildren[0] : head;
  return callee?.type === 'identifier' && callee.text === 'relation';
};

/** A field's one `@relation`'s named arguments; undefined when it has none or names one twice. */
function relationArguments(field: Node): { attribute: Node; named: Map<string, Node | undefined> } | undefined {
  const attributes = field.namedChildren.filter((c) => c?.type === 'attribute' && isRelation(c));
  if (attributes.length !== 1) return undefined;
  const attribute = attributes[0]!;
  const call = attribute.namedChildren[0];
  const named = new Map<string, Node | undefined>();
  for (const arg of (call?.type === 'call_expression' ? child(call, 'arguments')?.namedChildren : undefined) ?? []) {
    const name = arg?.type === 'type_expression' ? arg.namedChildren[0] : undefined;
    if (name?.type !== 'identifier') continue;
    if (named.has(name.text)) return undefined;
    named.set(name.text, arg!.namedChildren[1] ?? undefined);
  }
  return { attribute, named };
}

/** The key a field's `@relation(fields: […], references: […])` states, both lists of names and of equal length. */
function foreignKey(field: Node, lines: Lines): CodeRef['foreignKey'] {
  const relation = relationArguments(field);
  const fields = names(relation?.named.get('fields'));
  const references = names(relation?.named.get('references'));
  if (!relation || !fields || !references || fields.length !== references.length) return undefined;
  return { fields, references, range: lines.range(relation.attribute.startIndex, relation.attribute.endIndex) };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The key of a relation a syntax error hides: its model and the name its field is typed with. */
export const hiddenKey = (from: string, spec: string): string => `${from}\0${spec}`;

export interface RelationContext {
  file: string;
  declarations: readonly PrismaDeclaration[];
  idOf: (d: PrismaDeclaration) => string | undefined;
  broken: ReadonlySet<string>;
  errors: readonly Node[];
  lines: Lines;
}

/**
 * Relations from each model to the model a field's type names. Resolved (`candidate` and `to`) only when the file
 * declares that name once, as a model; unknown, with no file, when the file declares it nowhere (another file of a
 * multi-file schema may, as a model or not). None from or to a broken declaration, nor to a name the broken text may
 * declare: those are `hidden`, so the last good relation stands in.
 */
export function prismaRelations(ctx: RelationContext): { refs: CodeRef[]; hidden: Set<string> } {
  const refs: CodeRef[] = [];
  const hidden = new Set<string>();
  for (const model of ctx.declarations) {
    const from = ctx.idOf(model);
    if (model.kind !== 'model' || !from || ctx.broken.has(from)) continue;
    for (const { field, type, list } of typedFields(model.node)) {
      const spec = type.text;
      const range = ctx.lines.range(type.startIndex, type.endIndex);
      // Only the side with one model holds the key.
      const key = list ? undefined : foreignKey(field, ctx.lines);
      const named = ctx.declarations.filter((d) => d.path[0] === spec);
      if (!named.length) {
        const word = new RegExp(`(?<!\\w)${escapeRegExp(spec)}(?!\\w)`);
        if (ctx.errors.some((e) => word.test(e.text))) hidden.add(hiddenKey(from, spec));
        else refs.push({ file: ctx.file, from, spec, kind: 'relation', ...(key && { foreignKey: key }), status: 'unknown', range });
        continue;
      }
      // Declared twice, or as an enum, view or composite type: not a relation to one model.
      if (named.length > 1 || named[0]!.kind !== 'model') continue;
      const to = ctx.idOf(named[0]!)!;
      if (ctx.broken.has(to)) hidden.add(hiddenKey(from, spec));
      else refs.push({ file: ctx.file, from, spec, kind: 'relation', candidate: ctx.file, to, ...(key && { foreignKey: key }), status: 'unknown', range });
    }
  }
  return { refs, hidden };
}

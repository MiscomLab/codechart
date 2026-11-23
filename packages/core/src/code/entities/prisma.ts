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

/** Each field of a model with the name its type is written with: `User`, `User?`, `User[]`. */
function* typedFields(model: Node): Generator<Node> {
  const block = child(model, 'statement_block');
  for (const field of block?.namedChildren ?? []) {
    if (field?.type !== 'column_declaration') continue;
    const type = child(field, 'column_type')?.namedChildren[0];
    if (type?.type === 'identifier' && !SCALARS.has(type.text)) yield type;
  }
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
    for (const type of typedFields(model.node)) {
      const spec = type.text;
      const range = ctx.lines.range(type.startIndex, type.endIndex);
      const named = ctx.declarations.filter((d) => d.path[0] === spec);
      if (!named.length) {
        const word = new RegExp(`(?<!\\w)${escapeRegExp(spec)}(?!\\w)`);
        if (ctx.errors.some((e) => word.test(e.text))) hidden.add(hiddenKey(from, spec));
        else refs.push({ file: ctx.file, from, spec, kind: 'relation', status: 'unknown', range });
        continue;
      }
      // Declared twice, or as an enum, view or composite type: not a relation to one model.
      if (named.length > 1 || named[0]!.kind !== 'model') continue;
      const to = ctx.idOf(named[0]!)!;
      if (ctx.broken.has(to)) hidden.add(hiddenKey(from, spec));
      else refs.push({ file: ctx.file, from, spec, kind: 'relation', candidate: ctx.file, to, status: 'unknown', range });
    }
  }
  return { refs, hidden };
}

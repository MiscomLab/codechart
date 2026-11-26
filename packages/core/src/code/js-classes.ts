import type { Node } from 'web-tree-sitter';
import type { ClassInfo, CodeSymbol } from './model.js';
import { nodeRange } from './tree.js';

/** The identifiers an `extends` expression names: the last one of `a.B`, every one of a mixin call `M(B)`. */
function baseNames(value: Node | null | undefined): string[] {
  if (!value) return [];
  if (value.type === 'identifier' || value.type === 'type_identifier') return [value.text];
  if (value.type === 'member_expression') return [value.childForFieldName('property')?.text ?? ''].filter(Boolean);
  return value.namedChildren.flatMap((child) => (child ? baseNames(child) : []));
}

/** The expression a class extends: TypeScript wraps it in an `extends_clause`, JavaScript does not. */
function heritage(node: Node): Node | undefined {
  const clause = node.namedChildren.find((child) => child?.type === 'class_heritage');
  if (!clause) return undefined;
  const first = clause.namedChildren[0];
  return first?.type === 'extends_clause' ? (first.childForFieldName('value') ?? undefined) : (first ?? undefined);
}

/** A member's declared name; a computed name may be any, so it is `*`. */
function memberName(member: Node): string | undefined {
  const name = member.childForFieldName('name') ?? member.childForFieldName('property');
  if (!name) return undefined;
  return name.type === 'computed_property_name' ? '*' : name.text.replace(/^#/, '');
}

/** The names a class body assigns on `this`: `this.f = …`, `this.f += …`, also inside nested functions. */
function thisWrites(body: Node): string[] {
  const names: string[] = [];
  const stack: Node[] = [body];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
      const left = node.childForFieldName('left');
      const object = left?.type === 'member_expression' ? left.childForFieldName('object') : undefined;
      const property = left?.childForFieldName('property');
      if (object?.type === 'this' && property) names.push(property.text);
    }
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
  return names;
}

/** Every class and class expression of a JavaScript or TypeScript file, with what it extends, declares and writes. */
export function javascriptClasses(root: Node, symbols: readonly CodeSymbol[]): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    for (const child of node.namedChildren) if (child) stack.push(child);
    if (node.type !== 'class_declaration' && node.type !== 'class' && node.type !== 'abstract_class_declaration') continue;
    const body = node.childForFieldName('body');
    if (!body) continue;
    const declared = node.childForFieldName('name')?.text ?? (node.parent?.type === 'variable_declarator' ? node.parent.childForFieldName('name')?.text : undefined) ?? '';
    const range = nodeRange(node);
    const symbol = symbols
      .filter((s) => s.kind === 'class' && s.path.at(-1) === declared && s.range.start.line <= range.start.line && s.range.end.line >= range.end.line)
      .sort((x, y) => y.range.start.line - x.range.start.line)[0];
    const members = body.namedChildren.flatMap((member) => (member ? [memberName(member)] : [])).filter((name): name is string => !!name);
    classes.push({ ...(symbol && { id: symbol.id }), name: declared, bases: baseNames(heritage(node)), members, writes: thisWrites(body) });
  }
  return classes;
}

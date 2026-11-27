import type { Node } from 'web-tree-sitter';

/** The computed-write exemptions a declared TypeScript type gives: a Record-like slot, or a container. */
export type ExemptKind = 'record' | 'container';

/** Base names a class can extend and still sit in a container-typed slot, so the container exemption then proves nothing. */
export const CONTAINER_BASES = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array']);

/** The type behind an annotation, with parentheses unwrapped. */
function typeNode(node: Node | null | undefined): Node | undefined {
  let current = node ?? undefined;
  while (current && (current.type === 'type_annotation' || current.type === 'parenthesized_type')) current = current.namedChildren[0];
  return current;
}

/** `string`, `number`, `symbol`, or a union of those: a key type an index signature accepts. */
function keyType(node: Node | undefined): boolean {
  if (!node) return false;
  if (node.type === 'union_type') return node.namedChildren.every(keyType);
  return node.type === 'predefined_type' && (node.text === 'string' || node.text === 'number' || node.text === 'symbol');
}

/** Whether a type is exactly `any`: tsc assigns any object to an `any` index signature. */
const anyType = (node: Node | undefined): boolean => node?.type === 'predefined_type' && node.text === 'any';

const typeArguments = (node: Node): Node[] => node.childForFieldName('type_arguments')?.namedChildren.filter((child): child is Node => !!child) ?? [];

/** Whether a union member is `undefined` or `null`: it adds no exemption but does not spoil one. */
const nullish = (node: Node): boolean => node.type === 'literal_type' && (node.text === 'undefined' || node.text === 'null');

/** The exemption a `Record<K, V>` or a named container type gives. */
function genericKinds(node: Node): ExemptKind[] {
  const name = node.childForFieldName('name');
  if (name?.type !== 'type_identifier') return [];
  if (CONTAINER_BASES.has(name.text)) return ['container'];
  const args = typeArguments(node);
  return name.text === 'Record' && args.length === 2 && keyType(args[0]) && !anyType(args[1]) ? ['record'] : [];
}

/** The exemption an object type with an index signature gives: tsc assigns an object to it only through the signature. */
function objectKinds(node: Node): ExemptKind[] {
  const signatures = node.namedChildren.filter((child) => child?.type === 'index_signature');
  if (!signatures.length) return [];
  return signatures.every((signature) => !anyType(typeNode(signature!.childForFieldName('type')))) ? ['record'] : [];
}

/**
 * The computed-write exemptions a declared type gives (COD-59 option B): `Record<K, V>` with a `string`/`number`/`symbol`
 * key (or a union of those) and a value not exactly `any`, an object type with a non-`any` index signature,
 * `Map`/`Set`/`WeakMap`/`WeakSet`, `Array<T>`, `T[]` and tuples. A union is exempt when every member is exempt or
 * `undefined`/`null`. Everything else stays strict: `any`, `unknown`, `object`, type references, intersections.
 */
export function exemptKinds(node: Node | null | undefined): ExemptKind[] {
  const type = typeNode(node);
  if (!type) return [];
  if (type.type === 'union_type') {
    const members = type.namedChildren;
    if (members.some((member) => !member || (!nullish(member) && !exemptKinds(member).length))) return [];
    return [...new Set(members.flatMap((member) => (member ? exemptKinds(member) : [])))];
  }
  if (type.type === 'generic_type') return genericKinds(type);
  if (type.type === 'object_type') return objectKinds(type);
  return type.type === 'array_type' || type.type === 'tuple_type' ? ['container'] : [];
}

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

/** Members a `this.x` slot can be declared by: a class field, or a constructor parameter property. */
const FIELD_TYPES = new Set(['public_field_definition', 'field_definition']);
const PARAMETER_TYPES = new Set(['required_parameter', 'optional_parameter']);

/** Function nodes whose `this` does not inherit from an enclosing class member, so a `this.x` inside them names nothing. */
const OWN_FUNCTIONS = new Set(['function_declaration', 'function_expression', 'generator_function', 'generator_function_declaration', 'function_signature']);

/** Whether a class member carries the `static` keyword. */
const staticMember = (node: Node): boolean => node.children.some((child) => child?.type === 'static');

/** The class member the `this` at `node` runs in, walking out through arrows, or undefined when it runs in no class body. */
function thisMember(node: Node): Node | undefined {
  for (let current: Node | null = node.parent; current; current = current.parent) {
    if (current.type === 'arrow_function') continue;
    const member = current.type === 'method_definition' || FIELD_TYPES.has(current.type) || current.type === 'class_static_block';
    if (member) return current.parent?.type === 'class_body' ? current : undefined;
    if (OWN_FUNCTIONS.has(current.type)) return undefined;
  }
  return undefined;
}

/** Whether a constructor parameter declares a property: it has an accessibility modifier or `readonly`. */
const parameterProperty = (node: Node): boolean =>
  node.namedChildren.some((child) => child?.type === 'accessibility_modifier') || node.children.some((child) => child?.type === 'readonly');

/** The constructor parameter properties a class body declares named `name`; a static class has none. */
function parameterProperties(body: Node, name: string): Node[] {
  const out: Node[] = [];
  for (const member of body.namedChildren) {
    if (member?.type !== 'method_definition' || member.childForFieldName('name')?.text !== 'constructor' || staticMember(member)) continue;
    for (const parameter of member.childForFieldName('parameters')?.namedChildren ?? []) {
      if (!parameter || !PARAMETER_TYPES.has(parameter.type) || !parameterProperty(parameter)) continue;
      if (parameter.childForFieldName('name')?.text === name) out.push(parameter);
    }
  }
  return out;
}

/** The members a class body declares named `name` with the same static-ness: fields, methods, instance parameter properties. */
function classDeclarations(body: Node, name: string, staticSide: boolean): Node[] {
  const fields = body.namedChildren.filter((member): member is Node => {
    if (!member || staticMember(member) !== staticSide) return false;
    if (member.type !== 'method_definition' && !FIELD_TYPES.has(member.type)) return false;
    return member.childForFieldName('name')?.text === name;
  });
  return staticSide ? fields : [...fields, ...parameterProperties(body, name)];
}

/**
 * The exemptions a `this.x[k]` write gets from the class body's declaration of `x` (COD-59 option B): the body must
 * declare exactly one member named `x` of that static-ness, a field or constructor parameter property, whose type
 * `exemptKinds` accepts. A method, a second declaration or no annotation gives nothing.
 */
export function thisFieldKinds(receiver: Node, at: Node): ExemptKind[] {
  const property = receiver.childForFieldName('property');
  if (receiver.type !== 'member_expression' || receiver.childForFieldName('object')?.type !== 'this') return [];
  if (property?.type !== 'property_identifier' && property?.type !== 'private_property_identifier') return [];
  const member = thisMember(at);
  const body = member?.parent;
  if (!member || body?.type !== 'class_body') return [];
  const declarations = classDeclarations(body, property.text, member.type === 'class_static_block' || staticMember(member));
  if (declarations.length !== 1 || declarations[0]!.type === 'method_definition') return [];
  return exemptKinds(declarations[0]!.childForFieldName('type'));
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

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

/** The exemption a `Record<K, V>` or a named container type gives, unless the file declares a type of that name. */
function genericKinds(node: Node, declared: ReadonlySet<string>): ExemptKind[] {
  const name = node.childForFieldName('name');
  if (name?.type !== 'type_identifier' || declared.has(name.text)) return [];
  if (CONTAINER_BASES.has(name.text)) return ['container'];
  const args = typeArguments(node);
  return name.text === 'Record' && args.length === 2 && keyType(args[0]) && !anyType(args[1]) ? ['record'] : [];
}

const TYPE_DECLARATIONS = new Set(['type_alias_declaration', 'interface_declaration', 'class_declaration', 'abstract_class_declaration', 'enum_declaration']);

/** The one name a declaration node of a type, type parameter or module binds, if any. */
function declaredName(node: Node): string | undefined {
  if (TYPE_DECLARATIONS.has(node.type) || node.type === 'type_parameter') return node.childForFieldName('name')?.text;
  if (node.type !== 'internal_module' && node.type !== 'module') return undefined;
  const name = node.childForFieldName('name') ?? node.namedChildren.find((child) => child?.type === 'identifier');
  if (!name || name.type === 'string') return undefined;
  return name.type === 'nested_identifier' ? (name.namedChildren[0]?.text ?? name.text) : name.text;
}

/** The local names an import node binds: a default, namespace or named import. */
function importNames(node: Node): string[] {
  if (node.type === 'import_specifier') {
    const local = node.childForFieldName('alias') ?? node.childForFieldName('name');
    return local ? [local.text] : [];
  }
  if (node.type !== 'import_clause' && node.type !== 'namespace_import') return [];
  return node.namedChildren.filter((child) => child?.type === 'identifier').map((child) => child!.text);
}

/** The names a file declares as types: aliases, interfaces, classes, enums, type parameters, imports and modules. */
export function declaredTypeNames(root: Node): Set<string> {
  const names = new Set<string>();
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    const name = declaredName(node);
    if (name) names.add(name);
    for (const imported of importNames(node)) names.add(imported);
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
  return names;
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

/** Function values a class field can hold, whose own `this` parameter then replaces the class's `this` type. */
const FIELD_FUNCTIONS = new Set(['arrow_function', 'function_expression', 'generator_function', 'generator_function_declaration']);

/** Whether a class member's own function — its method, or the function its field holds — declares a `this` parameter. */
function declaresThis(member: Node): boolean {
  const value = FIELD_TYPES.has(member.type) ? member.childForFieldName('value') : undefined;
  const fn = member.type === 'method_definition' ? member : value && FIELD_FUNCTIONS.has(value.type) ? value : undefined;
  return (fn?.childForFieldName('parameters')?.namedChildren ?? []).some((parameter) => parameter?.type === 'required_parameter' && parameter.childForFieldName('pattern')?.type === 'this');
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
 * `exemptKinds` accepts. A method, a second declaration, no annotation or a member declaring its own `this` gives nothing.
 */
export function thisFieldKinds(receiver: Node, at: Node, declared: ReadonlySet<string>): ExemptKind[] {
  const property = receiver.childForFieldName('property');
  if (receiver.type !== 'member_expression' || receiver.childForFieldName('object')?.type !== 'this') return [];
  if (property?.type !== 'property_identifier' && property?.type !== 'private_property_identifier') return [];
  const member = thisMember(at);
  const body = member?.parent;
  // A method (or a function a field holds) with its own `this` parameter replaces the class's `this` type entirely.
  if (!member || body?.type !== 'class_body' || declaresThis(member)) return [];
  const declarations = classDeclarations(body, property.text, member.type === 'class_static_block' || staticMember(member));
  if (declarations.length !== 1 || declarations[0]!.type === 'method_definition') return [];
  return exemptKinds(declarations[0]!.childForFieldName('type'), declared);
}

/**
 * The computed-write exemptions a declared type gives (COD-59 option B): `Record<K, V>` with a `string`/`number`/`symbol`
 * key (or a union of those) and a value not exactly `any`, an object type with a non-`any` index signature,
 * `Map`/`Set`/`WeakMap`/`WeakSet`, `Array<T>`, `T[]` and tuples. A union is exempt when every member is exempt or
 * `undefined`/`null`. Everything else stays strict: `any`, `unknown`, `object`, type references, intersections.
 */
export function exemptKinds(node: Node | null | undefined, declared: ReadonlySet<string>): ExemptKind[] {
  const type = typeNode(node);
  if (!type) return [];
  if (type.type === 'union_type') {
    const members = type.namedChildren;
    if (members.some((member) => !member || (!nullish(member) && !exemptKinds(member, declared).length))) return [];
    return [...new Set(members.flatMap((member) => (member ? exemptKinds(member, declared) : [])))];
  }
  if (type.type === 'generic_type') return genericKinds(type, declared);
  if (type.type === 'object_type') return objectKinds(type);
  return type.type === 'array_type' || type.type === 'tuple_type' ? ['container'] : [];
}

import type { Node } from 'web-tree-sitter';
import type { JsScopeReader } from './js-scope.js';
import { builtinCall, inner, literalKey, propertyKey, writeSites } from './js-writes.js';

/**
 * Prototype writes and prototype names (COD-59 compiler line). A write names the member it rebinds and, from the
 * expression it is written on, how it reaches objects: a prototype expression (`K.prototype`, `x.__proto__`,
 * `Object.getPrototypeOf(x)`) or a name bound to one. Whether a name is bound to one is a repo-wide fact, so a parse
 * records the bindings (`ProtoBind`) and each write's receiver name; call linking joins them.
 */

/**
 * How a write's receiver reaches objects: `proto` is a prototype expression (an instance's `f` changes), `getter` a
 * prototype getter, which may also be a constructor's parent (the static side changes too), `plain` anything else
 * (a constructor, a namespace, an unrelated object: only a static `f` can change). `receiver` is a plain receiver's
 * rightmost name, which a prototype binding elsewhere may turn into `proto`.
 */
export interface MemberWrite {
  name: string;
  kind: 'proto' | 'getter' | 'plain';
  receiver?: string;
}

/**
 * A name bound, assigned, exported or used as an object key for a prototype expression (no `from`), a prototype getter
 * (no `from`, `getter`) or another name (`from`); `module.exports` and `default` stand for those exports.
 */
export interface ProtoBind {
  name: string;
  from?: string;
  getter?: boolean;
}

/** What a value stands for: a prototype expression or getter, or another name. */
interface Source {
  from?: string;
  getter?: boolean;
}

const GETTERS = new Set(['getPrototypeOf']);

/** The kind of prototype an expression is, through casts: `.prototype` is `proto`; a getter call or `__proto__` is `getter`. */
function protoKind(value: Node | null | undefined, scopes: JsScopeReader): 'proto' | 'getter' | undefined {
  const node = inner(value);
  if (node?.type === 'call_expression') {
    const parts = builtinCall(node, scopes);
    return parts && GETTERS.has(parts[1]) ? 'getter' : undefined;
  }
  const key = node?.type === 'member_expression' ? node.childForFieldName('property')?.text : node?.type === 'subscript_expression' ? literalKey(node.childForFieldName('index')) : undefined;
  if (key === '__proto__') return 'getter';
  return key === 'prototype' ? 'proto' : undefined;
}

/** The last name of an identifier or member chain (`ns.P`, `require('./c').P`, `this.P`), or a literal subscript's key. */
function rightmostName(value: Node | null | undefined): string | undefined {
  const node = inner(value);
  if (node?.type === 'identifier') return node.text;
  if (node?.type === 'member_expression') return node.childForFieldName('property')?.text;
  return node?.type === 'subscript_expression' ? literalKey(node.childForFieldName('index')) : undefined;
}

/** Whether a call is `require(…)`, whose value is another module's `module.exports`. */
function isRequire(node: Node | undefined): boolean {
  const fn = node?.type === 'call_expression' ? node.childForFieldName('function') : undefined;
  return fn?.type === 'identifier' && fn.text === 'require';
}

/** What a value expression stands for, when it can be a prototype or a name that is one. */
function sourceOf(value: Node | null | undefined, scopes: JsScopeReader): Source | undefined {
  const node = inner(value);
  const kind = protoKind(node, scopes);
  if (kind) return kind === 'getter' ? { getter: true } : {};
  if (isRequire(node)) return { from: 'module.exports' };
  const name = rightmostName(node);
  return name === undefined ? undefined : { from: name };
}

/** How a write's receiver reaches objects. */
function writeKind(receiver: Node, scopes: JsScopeReader): Pick<MemberWrite, 'kind' | 'receiver'> {
  const kind = protoKind(receiver, scopes);
  if (kind) return { kind };
  const name = rightmostName(receiver);
  return { kind: 'plain', ...(name !== undefined && { receiver: name }) };
}

/** Every named member write of the file whose receiver is not `this`/`super` (a class's own writes are its `writes`). */
export function javascriptMemberWrites(root: Node, scopes: JsScopeReader): MemberWrite[] {
  return writeSites(root, scopes)
    .filter(({ receiver }) => {
      const type = inner(receiver)?.type;
      return type !== 'this' && type !== 'super';
    })
    .map(({ name, receiver }) => ({ name, ...writeKind(receiver, scopes) }));
}

const OBJECT_PATTERN_ENTRIES = new Set(['shorthand_property_identifier_pattern', 'object_assignment_pattern']);

/** The name a binding or assignment target binds: an identifier, a member's rightmost name, `module.exports`. */
function targetName(target: Node): string | undefined {
  if (target.type === 'identifier') return target.text;
  if (target.type === 'member_expression' && target.text.replace(/\s+/g, '') === 'module.exports') return 'module.exports';
  return rightmostName(target);
}

/** Collects the bindings one target makes from a value; a destructuring pattern binds from its keys instead. */
class BindCollector {
  readonly binds: ProtoBind[] = [];

  constructor(private readonly scopes: JsScopeReader) {}

  private add(name: string | undefined, source: Source | undefined): void {
    if (name === undefined || !source || source.from === name) return;
    this.binds.push({ name, ...(source.from !== undefined && { from: source.from }), ...(source.getter && { getter: true }) });
  }

  /** `target = value`, a declarator, a default, a field, an object key or an export. */
  bind(target: Node | null | undefined, source: Source | undefined): void {
    const node = inner(target);
    if (!node) return;
    if (node.type === 'assignment_pattern') return this.bind(node.childForFieldName('left'), source);
    if (node.type === 'object_pattern') {
      for (const entry of node.namedChildren) if (entry) this.entry(entry);
      return;
    }
    if (node.type === 'array_pattern' || node.type === 'rest_pattern') return;
    this.add(targetName(node), source);
  }

  /** One entry of an object pattern: `{ prototype }` and `{ prototype: P }` bind a prototype; `{ P: R }` binds R to P. */
  private entry(entry: Node): void {
    if (entry.type === 'pair_pattern') {
      const key = propertyKey(entry.childForFieldName('key'));
      this.bind(entry.childForFieldName('value'), key === undefined ? undefined : key === 'prototype' ? {} : { from: key });
    } else if (OBJECT_PATTERN_ENTRIES.has(entry.type)) {
      const name = (entry.type === 'object_assignment_pattern' ? entry.childForFieldName('left') : entry)?.text;
      if (name === 'prototype') this.binds.push({ name });
    }
  }

  /** The entries of an object literal: each key whose value is a prototype or a prototype name. */
  object(node: Node): void {
    for (const entry of node.namedChildren) {
      if (entry?.type === 'pair') this.add(propertyKey(entry.childForFieldName('key')), sourceOf(entry.childForFieldName('value'), this.scopes));
    }
  }

  /** `export default value`, `export { P as Q }`. */
  exported(node: Node): void {
    if (node.childForFieldName('value')) this.add('default', sourceOf(node.childForFieldName('value'), this.scopes));
    for (const clause of node.namedChildren) {
      if (clause?.type !== 'export_clause') continue;
      for (const spec of clause.namedChildren) {
        const name = spec?.childForFieldName('name')?.text;
        if (name !== undefined) this.add(spec!.childForFieldName('alias')?.text ?? name, { from: name });
      }
    }
  }

  visit(node: Node): void {
    switch (node.type) {
      case 'variable_declarator':
      case 'required_parameter':
      case 'optional_parameter':
        this.bind(node.childForFieldName('name') ?? node.childForFieldName('pattern'), sourceOf(node.childForFieldName('value'), this.scopes));
        break;
      case 'assignment_pattern':
        this.bind(node.childForFieldName('left'), sourceOf(node.childForFieldName('right'), this.scopes));
        break;
      case 'assignment_expression':
        this.bind(node.childForFieldName('left'), sourceOf(node.childForFieldName('right'), this.scopes));
        break;
      case 'augmented_assignment_expression':
        if (['??=', '||=', '&&='].includes(node.childForFieldName('operator')?.text ?? '')) this.bind(node.childForFieldName('left'), sourceOf(node.childForFieldName('right'), this.scopes));
        break;
      case 'field_definition':
      case 'public_field_definition':
        this.add(propertyKey(node.childForFieldName('name') ?? node.childForFieldName('property')), sourceOf(node.childForFieldName('value'), this.scopes));
        break;
      case 'object':
        this.object(node);
        break;
      case 'export_statement':
        this.exported(node);
        break;
    }
    for (const child of node.namedChildren) if (child) this.visit(child);
  }
}

/** Every name the file binds, assigns, exports or keys to a prototype expression or to another name. */
export function javascriptProtoBinds(root: Node, scopes: JsScopeReader): ProtoBind[] {
  const collector = new BindCollector(scopes);
  collector.visit(root);
  return collector.binds;
}

import { z } from 'zod';

export const LANGS = ['typescript', 'javascript', 'python', 'html', 'css', 'sql', 'bash', 'yaml', 'json', 'prisma'] as const;
export type Lang = (typeof LANGS)[number];

/** `line` is 1-based, as editors and the match check count; `column` is tree-sitter's, 0-based. */
const pointSchema = z.object({ line: z.number().int().min(1), column: z.number().int().min(0) });
export const codeRangeSchema = z.object({ start: pointSchema, end: pointSchema });
export type CodeRange = z.infer<typeof codeRangeSchema>;

export const fileInfoSchema = z.object({
  path: z.string().min(1),
  lang: z.enum(LANGS),
  /** sha256 of the file's text as UTF-8, hex. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type FileInfo = z.infer<typeof fileInfoSchema>;

export const SYMBOL_KINDS = ['class', 'interface', 'type', 'enum', 'function', 'method', 'module', 'constant'] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/**
 * What a class says about the names its instances dispatch on: the classes it extends (the last identifier of each
 * base expression, an alias followed to the class it names), the names its body declares and
 * the names its methods write through `this`/`self`/`cls`. Call linking reads it to see that a subclass or an instance
 * write can replace a method.
 */
export interface ClassInfo {
  /** The class symbol's id; absent for a class expression the symbol table does not hold. */
  id?: string;
  name: string;
  bases: string[];
  members: string[];
  writes: string[];
  /** Python: a `metaclass=` keyword, so a constructed receiver is not provably an instance of the class. */
  metaclass?: boolean;
  /** Python: the identifier a `metaclass=` keyword names; absent when it is any other expression. */
  metaclassName?: string;
  /** A base the syntax cannot read as a (dotted) name, so the class's real ancestors are unknown. */
  opaqueBase?: boolean;
  /** Python: a dotted base (`mod.K`), of which `bases` holds only the last identifier. */
  qualifiedBase?: boolean;
  /** Python: each decorator's callee text (`dataclass`, `dataclasses.dataclass`), `*` for one the syntax cannot read. */
  decorators?: string[];
  /** JS/TS: the members declared `static`; a `this` call in a static method reaches only these. */
  statics?: string[];
  /** JS/TS: members whose body is not a callable method (a getter/setter, `abstract`, or a signature). */
  nonCallable?: string[];
  /** JS/TS: a computed instance member key no parse can prove a string or a symbol: it may be any name. */
  unknownInstance?: boolean;
  /** JS/TS: the same for a computed `static` member key. */
  unknownStatic?: boolean;
  /** JS/TS: the class node's range, which a call's `this` owner is matched against. */
  range?: CodeRange;
  /** JS/TS: the member methods and function-valued fields with a symbol, by name, so `this.name()` finds its target. */
  methods?: { name: string; id: string; static?: boolean }[];
  /** JS/TS: ranges where `this` is the constructor (a static member, a static block). */
  staticRanges?: CodeRange[];
}

export const codeSymbolSchema = z.object({
  /** `symbolId(file, path, kind)`; a repeated identity in one file gets `~2`, `~3`… in source order. */
  id: z.string().min(1),
  file: z.string().min(1),
  /** Names from the outermost definition in, e.g. `['PaymentService', 'charge']`. */
  path: z.array(z.string().min(1)).min(1),
  kind: z.enum(SYMBOL_KINDS),
  range: codeRangeSchema,
});
export type CodeSymbol = z.infer<typeof codeSymbolSchema>;

export const importedNameSchema = z.object({
  /** The name the other module exports: `default`, `*` for the whole module, or the export's name. */
  imported: z.string().min(1),
  /** The binding in this file; for a re-export, the name this file exports it as (`*` for `export *`). */
  local: z.string().min(1),
  typeOnly: z.boolean().optional(),
  /** The repo file that defines it, barrels followed; absent when not proven. */
  definedIn: z.string().min(1).optional(),
});
export type ImportedName = z.infer<typeof importedNameSchema>;

export const IMPORT_KINDS = ['import', 'export', 'require', 'dynamic'] as const;

export const importSchema = z.object({
  file: z.string().min(1),
  spec: z.string(),
  resolved: z.string().min(1).optional(),
  status: z.enum(['resolved', 'unknown', 'external']),
  /** Python: the folder of a namespace package (no `__init__.py`) the import names; the import itself stays `unknown`. */
  packageFolder: z.string().optional(),
  /** Python `importlib.import_module('.x', 'pkg')`: the absolute module the relative spec names, resolved instead of it. */
  anchored: z.string().min(1).optional(),
  /** `export` is a re-export (`export … from`); `require` and `dynamic` (`import()`) name no bindings. */
  kind: z.enum(IMPORT_KINDS),
  /** `import type`, `export type`, `typeof import()`. */
  typeOnly: z.boolean().optional(),
  /** Absent for `require` and `import()`; empty for a side-effect `import 'x'`. */
  names: z.array(importedNameSchema).optional(),
  range: codeRangeSchema,
});
export type Import = z.infer<typeof importSchema>;

export const CALL_VIAS = ['bare', 'this', 'member'] as const;
export type CallVia = (typeof CALL_VIAS)[number];

export const callRefSchema = z.object({
  from: z.string().min(1),
  name: z.string().min(1),
  /** How the callee is written; linking needs it because the syntax tree is gone by then. */
  via: z.enum(CALL_VIAS).optional(),
  /** For `via: 'member'`, the object when it is a plain identifier (a namespace import, for example). */
  receiver: z.string().min(1).optional(),
  /**
   * For a Python dotted callee (`a.b.f()`), the attribute chain before the name. `receiver` holds its first name.
   */
  receiverPath: z.array(z.string().min(1)).min(2).optional(),
  to: z.string().min(1).optional(),
  evidence: z.enum(['resolved', 'name-only']),
  range: codeRangeSchema,
});
export type CallRef = z.infer<typeof callRefSchema>;

/** Node identity (Live map #9): file + symbol path + kind, so line moves keep the node. */
export const symbolId = (file: string, path: readonly string[], kind: SymbolKind): string => `${file}::${path.join('.')}::${kind}`;

/**
 * What files without imports define (Code model #3): SQL tables, workflow jobs and steps, compose services, npm scripts,
 * and Prisma models, enums, views and composite types (`type`).
 */
export const ENTITY_KINDS = ['table', 'job', 'step', 'service', 'script', 'model', 'enum', 'view', 'type'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * Like a symbol: `id` is `entityId(file, path, kind)`, `~2`, `~3`… for a repeated identity. `path` holds names from the
 * outermost in: `['public', 'orders']` for a table, `['deploy', 'ship']` for a step of job `deploy`. Path parts are joined
 * with `.`, so a name holding a dot (`"a.b"`, a `build.web` script) can share an id with a nested path.
 */
export const codeEntitySchema = codeSymbolSchema.extend({ kind: z.enum(ENTITY_KINDS) });
export type CodeEntity = z.infer<typeof codeEntitySchema>;

export const entityId = (file: string, path: readonly string[], kind: EntityKind): string => `${file}::${path.join('.')}::${kind}`;

/**
 * `run`: a file a workflow step or npm script runs; `source`: a file a shell script sources; `script` and `link`: an
 * HTML `<script src>` and `<link href>`; `import`: a CSS `@import`; `relation`: a Prisma model field typed with a model.
 */
export const REF_KINDS = ['run', 'source', 'script', 'link', 'import', 'relation'] as const;

export const codeRefSchema = z.object({
  file: z.string().min(1),
  /** The id of the entity or symbol the reference sits in, if any. */
  from: z.string().min(1).optional(),
  /** The value the program reads: unquoted and unescaped. */
  spec: z.string().min(1),
  /** The source text at `range`, when it differs from `spec` (escapes, entities, quotes). */
  written: z.string().min(1).optional(),
  kind: z.enum(REF_KINDS),
  /**
   * A `relation`'s model: its entity id when the same file declares that model. A type another file declares (a
   * multi-file schema) has no `to` and stays `unknown`; it may name an enum or composite type there.
   */
  to: z.string().min(1).optional(),
  /**
   * A `relation` on the side that holds the foreign key: the field's `@relation(fields: […], references: […])` as
   * written, with this model's key fields, the other model's fields they reference, and the attribute's range as proof.
   * Absent on the other side (a list or back-relation field) and wherever the attribute does not state both lists.
   */
  foreignKey: z
    .object({ fields: z.array(z.string().min(1)).min(1), references: z.array(z.string().min(1)).min(1), range: codeRangeSchema })
    .optional(),
  /**
   * The repo path the spec names, when the folder it is relative to is fixed (the page, the package, the step's working
   * directory, the script's own folder) and the path stays in the repo; absent otherwise, and the reference stays unknown.
   */
  candidate: z.string().min(1).optional(),
  resolved: z.string().min(1).optional(),
  /** `resolved` only when `candidate` is a file of the code layer; `external` for a URL. */
  status: z.enum(['resolved', 'unknown', 'external']),
  range: codeRangeSchema,
});
export type CodeRef = z.infer<typeof codeRefSchema>;

/**
 * A match of a tree-sitter pattern (`compilePatterns`): where the node it captured as `@entity` is, and the text of its
 * other captures. Names starting with `_` only feed predicates and are left out; a capture that matched several nodes
 * gives the first. The source text itself is not kept: the range points at it.
 */
export const patternMatchSchema = z.object({
  /** The id of the pattern set the pattern belongs to. */
  set: z.string().min(1),
  /** The id of the pattern that matched. */
  pattern: z.string().min(1),
  range: codeRangeSchema,
  /** sha256 of the `@entity` node's text as UTF-8, hex: tells an edited match from the last good one (Live map #11). */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  captures: z.record(z.string(), z.string()),
  /** Carried over from the last good parse with its old range, since a syntax error hides it (Live map #11). */
  kept: z.literal(true).optional(),
});
export type PatternMatch = z.infer<typeof patternMatchSchema>;

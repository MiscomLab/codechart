import { z } from 'zod';

export const LANGS = ['typescript', 'javascript', 'python', 'html', 'css', 'sql', 'bash', 'yaml', 'json'] as const;
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

/** What files without imports define (Code model #3): SQL tables, workflow jobs and steps, compose services, npm scripts. */
export const ENTITY_KINDS = ['table', 'job', 'step', 'service', 'script'] as const;
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
 * HTML `<script src>` and `<link href>`; `import`: a CSS `@import`.
 */
export const REF_KINDS = ['run', 'source', 'script', 'link', 'import'] as const;

export const codeRefSchema = z.object({
  file: z.string().min(1),
  /** The id of the entity or symbol the reference sits in, if any. */
  from: z.string().min(1).optional(),
  /** As written, unquoted and unescaped. */
  spec: z.string().min(1),
  kind: z.enum(REF_KINDS),
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

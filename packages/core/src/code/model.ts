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
  /** `export` is a re-export (`export … from`); `require` and `dynamic` (`import()`) name no bindings. */
  kind: z.enum(IMPORT_KINDS),
  /** `import type`, `export type`, `typeof import()`. */
  typeOnly: z.boolean().optional(),
  /** Absent for `require` and `import()`; empty for a side-effect `import 'x'`. */
  names: z.array(importedNameSchema).optional(),
  range: codeRangeSchema,
});
export type Import = z.infer<typeof importSchema>;

export const callRefSchema = z.object({
  from: z.string().min(1),
  name: z.string().min(1),
  to: z.string().min(1).optional(),
  evidence: z.enum(['resolved', 'name-only']),
  range: codeRangeSchema,
});
export type CallRef = z.infer<typeof callRefSchema>;

/** Node identity (Live map #9): file + symbol path + kind, so line moves keep the node. */
export const symbolId = (file: string, path: readonly string[], kind: SymbolKind): string => `${file}::${path.join('.')}::${kind}`;

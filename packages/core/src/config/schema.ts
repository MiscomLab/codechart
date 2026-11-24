import { isAbsolute, win32 } from 'node:path';
import { z } from 'zod';
import { PATTERN_GRAMMARS } from '../code/languages.js';
import { formatIssues, quotedVisible } from '../spec/shared.js';

const OUTPUTS = ['auto', 'cli', 'web', 'both', 'none'] as const;
const CONTEXT_MODES = ['short', 'full'] as const;
export const THEMES = ['auto', 'light', 'dark'] as const;
const OPEN_MODES = ['auto', 'always', 'never'] as const;
const DIAGRAMS = ['map', 'flow'] as const;
const FLOWS = ['auto', 'always', 'request'] as const;

export type Output = (typeof OUTPUTS)[number];
export type ContextMode = (typeof CONTEXT_MODES)[number];
export type Theme = (typeof THEMES)[number];
type OpenMode = (typeof OPEN_MODES)[number];
export type Diagram = (typeof DIAGRAMS)[number];
export type Flows = (typeof FLOWS)[number];

export interface Rule {
  name: string;
  diagram?: Diagram;
  paths?: string[];
  when?: string;
  output?: Output;
  context?: ContextMode;
}

const RELEASE_AUTO = ['suggest', 'draw', 'off'] as const;
type ReleaseAuto = (typeof RELEASE_AUTO)[number];
export const DEFAULT_RELEASE_BRANCHES = ['v[0-9]*', 'release-*', 'release/*'];

/** The cover of a release map, the browser that prints its PDF, and which branches are release branches. */
interface ReleaseConfig {
  product?: string;
  logo?: string;
  browser?: string;
  branches: string[];
  auto: ReleaseAuto;
}

export interface Config {
  defaults: { output: Output; context: ContextMode; flows: Flows; terminalMaxNodes: number };
  web: { outDir: string; theme: Theme; minNodes: number; keep: number; maxAgeDays: number; open: OpenMode };
  useBuiltinRules: boolean;
  /** Look up the newest codechart once a day and say when there is one. */
  updateCheck: boolean;
  release: ReleaseConfig;
  /** Paths the desktop app's code layer never reads, from both config files. */
  ignore: string[];
  rules: Rule[];
}

const RULE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Control, line-break, bidi and invisible characters; U+200D stays for emoji.
const ONE_LINE_VISIBLE = /^[^\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]*$/;
const CHARS_MESSAGE = 'must be one line without control or invisible characters';

// Many wildcards or groups in one segment make picomatch backtrack for minutes.
const glob = z
  .string()
  .min(1)
  .max(200)
  .regex(ONE_LINE_VISIBLE, CHARS_MESSAGE)
  .refine((g) => !/[{(]/.test(g.replace(/\\./g, '')), { message: "braces and extglobs aren't supported; list each pattern separately" })
  .refine((g) => g.split('/').every((seg) => (seg.match(/[*?]/g) ?? []).length <= 8), {
    message: 'at most 8 of * ? per path segment',
  });

const ruleSchema = z
  .strictObject({
    name: z.string().regex(RULE_NAME, 'use 1-64 lowercase letters, digits or hyphens, not starting with a hyphen'),
    diagram: z.enum(DIAGRAMS).optional(),
    paths: z.array(glob).min(1).optional(),
    when: z.string().min(1).max(300).regex(ONE_LINE_VISIBLE, CHARS_MESSAGE).optional(),
    output: z.enum(OUTPUTS).optional(),
    context: z.enum(CONTEXT_MODES).optional(),
  })
  .refine((r) => (r.paths === undefined) !== (r.when === undefined), {
    message: 'set exactly one of paths or when',
  })
  .refine((r) => r.diagram !== 'flow' || r.context === undefined, {
    message: 'context applies only to map rules',
  });

/** What a map rule can make of code (Code model #4). */
export const MAP_ENTITY_KINDS = ['table', 'model', 'service', 'endpoint', 'component', 'config'] as const;
export type MapEntityKind = (typeof MAP_ENTITY_KINDS)[number];

// Like ONE_LINE_VISIBLE, but line breaks and tabs are allowed.
const MULTI_LINE_VISIBLE = /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]*$/;
const MULTI_LINE_MESSAGE = 'line breaks and tabs only; no other control or invisible characters';
const BOX_ID = RULE_NAME;
// `symbolId`/`entityId`: repo-relative file, names joined with `.`, lowercase kind, `~2` on for a repeat.
const NODE_ID = /^(?!\/)(?:[^:\\]|:(?!:))+::.+::[a-z]+(?:~(?:[2-9]|[1-9][0-9]+))?$/;
/** Prefix of a folder box's id: `folder:src/payments`. */
export const FOLDER_BOX_PREFIX = 'folder:';
/** Prefix of a group box's id: `group:folder:src/doctor`, `group:/a.ts..f.ts`. */
export const GROUP_BOX_PREFIX = 'group:';
const ID_MESSAGE =
  'use a rule box id (1-64 lowercase letters, digits or hyphens, not starting with a hyphen), a folder box id (folder: and a repo-relative folder, e.g. folder:src/payments), a group box id (group:, the id of the box it sits in or nothing at the top, / and its first word or first..last name, e.g. group:folder:src/doctor) or a node id (file::path::kind, file repo-relative)';
// Repo-relative with `/`: no leading or trailing `/`, no empty, `.` or `..` segment, no backslash.
const isRepoPath = (path: string) => !path.includes('\\') && path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
const isFolderId = (id: string) => id.startsWith(FOLDER_BOX_PREFIX) && isRepoPath(id.slice(FOLDER_BOX_PREFIX.length));

/**
 * The desktop app's group box: `group:<level>/<label>`, the level a folder box id, a rule box id, or empty at the
 * top; the label its first word or `first..last`, which may hold `/` (paths in a rule box), so any `/` may end the level.
 */
function isGroupId(id: string): boolean {
  const rest = id.slice(GROUP_BOX_PREFIX.length);
  for (let at = rest.indexOf('/'); at !== -1; at = rest.indexOf('/', at + 1)) {
    const level = rest.slice(0, at);
    const label = rest.slice(at + 1);
    if (label !== '' && !label.startsWith('/') && (level === '' || BOX_ID.test(level) || isFolderId(level))) return true;
  }
  return false;
}

/**
 * Which pinned id this is, by syntax alone: `::` makes a node, a `folder:` prefix a folder box, a `group:` prefix a
 * group box, else a rule box slug. A file (`file:src/a.ts`) is none of them: it keeps its own name.
 */
export function pinnedIdKind(id: string): 'node' | 'folder' | 'group' | 'rule-box' | undefined {
  if (!ONE_LINE_VISIBLE.test(id) || id.length > 1000) return undefined;
  if (id.includes('::')) return NODE_ID.test(id) && isRepoPath(id.split('::')[0]!) ? 'node' : undefined;
  if (id.startsWith(FOLDER_BOX_PREFIX)) return isFolderId(id) ? 'folder' : undefined;
  if (id.startsWith(GROUP_BOX_PREFIX)) return isGroupId(id) ? 'group' : undefined;
  return BOX_ID.test(id) ? 'rule-box' : undefined;
}

const quoted = (s: string) => quotedVisible(s.length > 100 ? `${s.slice(0, 100)}…` : s);

const boxId = z.string().regex(BOX_ID, 'use 1-64 lowercase letters, digits or hyphens, not starting with a hyphen');
const oneLine = (max: number) => z.string().min(1).max(max).regex(ONE_LINE_VISIBLE, CHARS_MESSAGE);

const mapRuleSchema = z
  .strictObject({
    paths: z.array(glob).min(1).optional().describe('Globs the rule matches'),
    pattern: z.string().min(1).max(2000).regex(MULTI_LINE_VISIBLE, MULTI_LINE_MESSAGE).regex(/@entity(?![\w.-])/, 'capture the node the rule applies to as @entity').optional().describe('Tree-sitter query; the @entity capture is what the rule applies to'),
    lang: z.enum(PATTERN_GRAMMARS).optional().describe("The pattern's tree-sitter grammar; it runs on the files read with it (typescript: .ts, .mts, .cts; tsx: .tsx; javascript: .js, .mjs, .cjs, .jsx)"),
    kind: z.enum(MAP_ENTITY_KINDS).optional().describe('The code is an entity of this kind'),
    box: boxId.optional().describe('The code belongs to this box'),
    ignore: z.literal(true).optional().describe('The code is read but left off the map'),
  })
  .refine((r) => r.paths !== undefined || r.pattern !== undefined, { message: 'set paths, pattern or both' })
  .refine((r) => [r.kind, r.box, r.ignore].filter((v) => v !== undefined).length === 1, { message: 'set exactly one of kind, box or ignore' })
  .refine((r) => r.pattern === undefined || r.lang !== undefined, { message: 'a pattern needs lang (its tree-sitter grammar)' })
  .refine((r) => r.lang === undefined || r.pattern !== undefined, { message: 'lang applies only to a pattern' });

const pinnedEntrySchema = z.strictObject({
  name: oneLine(80),
  reason: oneLine(300).optional(),
});

const pinnedSchema = z.record(z.string(), pinnedEntrySchema).superRefine((pinned, ctx) => {
  // The id goes in the message, escaped, so a line break or bidi character in it can't reshape the error.
  for (const id of Object.keys(pinned)) if (!pinnedIdKind(id)) ctx.addIssue({ code: 'custom', message: `${quoted(id)}: ${ID_MESSAGE}` });
});

const mapSchema = z.strictObject({
  rules: z.array(mapRuleSchema).nullish().describe("Top-down, first match wins, before the app's built-in rules"),
  guidance: z.string().min(1).max(2000).regex(MULTI_LINE_VISIBLE, MULTI_LINE_MESSAGE).nullish().describe('Plain words for the model that names and groups boxes'),
  pinned: pinnedSchema.nullish().describe('Names a person pinned, by rule box id (billing), folder box id (folder:src/payments), group box id (group:folder:src/doctor) or node id (file::path::kind); written sorted by id'),
});

export type MapRule = z.infer<typeof mapRuleSchema>;
export type PinnedEntry = z.infer<typeof pinnedEntrySchema>;
export type Pinned = Record<string, PinnedEntry>;
export type MapConfig = z.infer<typeof mapSchema>;

/** Checks pins before they are written: formatIssues lines, paths starting at `pinned`. */
export function parsePinned(input: unknown): { ok: true; pinned: Pinned } | { ok: false; errors: string[] } {
  const result = pinnedSchema.safeParse(input);
  if (result.success) return { ok: true, pinned: result.data };
  return { ok: false, errors: formatIssues(result.error).map((e) => `pinned${e.startsWith('$') ? e.slice(1) : `.${e}`}`) };
}

const configFileSchema = z.strictObject({
  defaults: z
    .strictObject({
      output: z.enum(OUTPUTS).optional(),
      context: z.enum(CONTEXT_MODES).optional(),
      flows: z.enum(FLOWS).optional(),
      terminalMaxNodes: z.number().int().positive().optional(),
    })
    .optional(),
  web: z
    .strictObject({
      outDir: z.string().min(1).optional(),
      theme: z.enum(THEMES).optional(),
      minNodes: z.number().int().positive().optional(),
      keep: z.number().int().positive().optional(),
      maxAgeDays: z.number().nonnegative().optional(),
      open: z.enum(OPEN_MODES).optional(),
    })
    .optional(),
  release: z
    .strictObject({
      product: z.string().min(1).max(80).regex(ONE_LINE_VISIBLE, CHARS_MESSAGE).optional().describe('Product name on the cover of a release map (default: the repo name)'),
      logo: z.string().min(1).max(300).regex(ONE_LINE_VISIBLE, CHARS_MESSAGE).optional().describe('Repo-relative path to an .svg or .png of at most 200 KB, shown on the cover of a release map'),
      browser: z.string().min(1).max(300).regex(ONE_LINE_VISIBLE, CHARS_MESSAGE).refine((p) => isAbsolute(p) || win32.isAbsolute(p), 'must be an absolute path').optional().describe('Global only: absolute path of the Chromium-based browser that prints a release map to PDF (default: Chrome, Chromium, Edge or Brave where they are usually installed)'),
      branches: z.array(glob).min(1).optional().describe('Branches that are release branches, as globs (default: v[0-9]*, release-*, release/*)'),
      auto: z.enum(RELEASE_AUTO).optional().describe('On a release branch: suggest a release map, draw one, or do nothing (default: suggest)'),
    })
    .optional(),
  useBuiltinRules: z.boolean().optional(),
  ignore: z.array(glob).optional().describe("Paths the desktop app's live map never reads, as globs, on top of .gitignore, dependencies and build output. The CLI doesn't use it."),
  updateCheck: z.boolean().optional().describe('Global only: look up the newest codechart on npm at most once a day and say when there is one (default true)'),
  rules: z.array(ruleSchema).optional(),
  // `map:` with its children commented out reads as null, like the template's.
  map: mapSchema.nullish().describe("The desktop app's map: its rules, guidance for the model and pinned names. The CLI doesn't use it."),
});

export type ConfigFile = z.infer<typeof configFileSchema>;

export function configJsonSchema(): object {
  return z.toJSONSchema(configFileSchema, { io: 'input' });
}

export function parseConfigFile(input: unknown): { ok: true; config: ConfigFile } | { ok: false; errors: string[] } {
  const result = configFileSchema.safeParse(input ?? {});
  if (result.success) return { ok: true, config: result.data };
  return { ok: false, errors: formatIssues(result.error) };
}

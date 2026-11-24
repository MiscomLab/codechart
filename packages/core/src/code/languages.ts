import type { Lang } from './model.js';

/** A tree-sitter grammar codechart parses symbols with. */
export type Grammar = 'typescript' | 'tsx' | 'javascript' | 'python';

const BY_EXTENSION: Record<string, Lang> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  pyi: 'python',
  html: 'html',
  htm: 'html',
  css: 'css',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  prisma: 'prisma',
};

const extension = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** The v1 language of a file, from its extension; undefined for files the code layer skips. */
export function langOf(path: string): Lang | undefined {
  return BY_EXTENSION[extension(path)];
}

/** A tree-sitter grammar codechart reads entities and references with (and, for Bash, functions). */
export type EntityGrammar = 'html' | 'css' | 'sql' | 'bash' | 'yaml' | 'json' | 'prisma';

/** The grammar that reads a file's entities and references, for the v1 languages without imports. */
export function entityGrammarOf(path: string): EntityGrammar | undefined {
  const lang = langOf(path);
  return lang === undefined || lang === 'typescript' || lang === 'javascript' || lang === 'python' ? undefined : lang;
}

/** The grammar that reads a file's symbols, or undefined while its language has entities only or none yet. */
export function grammarOf(path: string): Grammar | undefined {
  const ext = extension(path);
  if (ext === 'tsx') return 'tsx';
  if (ext === 'py' || ext === 'pyi') return 'python';
  const lang = BY_EXTENSION[ext];
  // The JavaScript grammar parses JSX too.
  return lang === 'typescript' || lang === 'javascript' ? lang : undefined;
}

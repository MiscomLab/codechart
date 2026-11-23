import { basename, extname } from 'node:path';

/** A comment that runs to its closing text, which may read what opened it (Lua's `--[==[`), or to a sticky pattern. */
interface Block {
  open: RegExp;
  close: (m: RegExpExecArray) => string | RegExp;
  /** Haskell's `{- {- -} -}`. */
  nested?: boolean;
}

/** A string literal; `escape` is how a closing quote is kept inside it. */
interface Quote {
  open: RegExp;
  close: string | ((m: RegExpExecArray) => string);
  escape: 'backslash' | 'double' | 'none';
  /** May run over line ends; else the string stops at one, so a stray quote can't hide the rest of the file. */
  lines?: boolean;
}

interface Syntax {
  /** Line comments; sticky, so a lookbehind can say where one may start. */
  lines: RegExp[];
  blocks: Block[];
  quotes: Quote[];
  /** `'` opens only `'x'` or `'\…'`: elsewhere it is a Rust lifetime or a C++ digit separator. */
  chars?: boolean;
  /** Python: a string standing alone as a statement (at a line start or after `;`) is a docstring, so a comment. */
  docstrings?: boolean;
}

// `//` right after `:` is a URL (`https://x` in JSX text), and after `\` an escaped slash in a regex, not a comment.
const SLASHES = /(?<![:\\])\/\//y;
const HASH = /#/y;
// Shell, Ruby, TOML, YAML: `#` opens a comment only at a word start, so `${#a}` and `a#b` stay.
const WORD_HASH = /(?<!\S)#/y;
const C_BLOCK: Block = { open: /(?<!\\)\/\*/y, close: () => '*/' };
const HTML_BLOCK: Block = { open: /<!--/y, close: () => '-->' };

const q = (open: RegExp, close: string, escape: Quote['escape'] = 'backslash', lines = false): Quote => ({ open, close, escape, lines });
const DOUBLE = q(/"/y, '"');
const SINGLE = q(/'/y, "'");
const BACKTICK = q(/`/y, '`', 'backslash', true);

const C_LIKE: Syntax = { lines: [SLASHES], blocks: [C_BLOCK], quotes: [DOUBLE, SINGLE, BACKTICK] };
const C_CHARS: Syntax = { lines: [SLASHES], blocks: [C_BLOCK], quotes: [q(/"""/y, '"""', 'none', true), DOUBLE], chars: true };
const GO: Syntax = { lines: [SLASHES], blocks: [C_BLOCK], quotes: [DOUBLE, q(/`/y, '`', 'none', true)], chars: true };
const RUST: Syntax = {
  lines: [SLASHES],
  blocks: [C_BLOCK],
  quotes: [{ open: /(?<!\w)b?r(#*)"/y, close: (m) => `"${m[1]}`, escape: 'none', lines: true }, q(/"/y, '"', 'backslash', true)],
  chars: true,
};
const CSHARP: Syntax = { lines: [SLASHES], blocks: [C_BLOCK], quotes: [q(/\$?@\$?"/y, '"', 'double', true), q(/"""/y, '"""', 'none', true), DOUBLE], chars: true };
const CSS: Syntax = { lines: [], blocks: [C_BLOCK], quotes: [DOUBLE, SINGLE] };
const SCSS: Syntax = { ...CSS, lines: [SLASHES] };
const PYTHON: Syntax = {
  lines: [HASH],
  blocks: [],
  quotes: [{ open: /(?<!\w)[rRuUbBfF]{0,2}("""|'''|"|')/y, close: (m) => m[1]!, escape: 'backslash', lines: true }],
  docstrings: true,
};
const WORD_HASHES: Syntax = { lines: [WORD_HASH], blocks: [], quotes: [DOUBLE, SINGLE] };
const RUBY: Syntax = { ...WORD_HASHES, blocks: [{ open: /(?<![^\n])=begin\b/y, close: () => /\n=end(?=\s|$)/y }] };
const HCL: Syntax = { lines: [HASH, SLASHES], blocks: [C_BLOCK], quotes: [DOUBLE] };
// PHP 8 attributes start `#[`.
const PHP: Syntax = { lines: [/#(?!\[)/y, SLASHES], blocks: [C_BLOCK], quotes: [DOUBLE, SINGLE] };
const SQL: Syntax = { lines: [/--/y], blocks: [C_BLOCK], quotes: [q(/'/y, "'", 'double'), q(/"/y, '"', 'double')] };
const LUA: Syntax = { lines: [/--/y], blocks: [{ open: /--\[(=*)\[/y, close: (m) => `]${m[1]}]` }], quotes: [DOUBLE, SINGLE] };
// `-->` is an operator, not a comment.
const HASKELL: Syntax = { lines: [/--+(?![!#$%&*+./<=>?@\\^|~:])/y], blocks: [{ open: /\{-/y, close: () => '-}', nested: true }], quotes: [DOUBLE] };
// Prose has apostrophes, so no quotes.
const HTML: Syntax = { lines: [], blocks: [HTML_BLOCK], quotes: [] };
const COMPONENT: Syntax = { lines: [SLASHES], blocks: [HTML_BLOCK, C_BLOCK], quotes: [DOUBLE, SINGLE, BACKTICK] };
const INI: Syntax = { lines: [/(?<!\S)[#;]/y], blocks: [], quotes: [] };

const BY_EXT: Record<string, Syntax | 'yaml' | 'template'> = {};
const add = (syntax: Syntax | 'yaml' | 'template', ...exts: string[]) => exts.forEach((e) => (BY_EXT[e] = syntax));
add(C_LIKE, 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'groovy', 'gradle', 'dart');
add(C_CHARS, 'java', 'kt', 'kts', 'scala', 'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'proto');
add(GO, 'go');
add(RUST, 'rs');
add(CSHARP, 'cs');
add(CSS, 'css');
add(SCSS, 'scss', 'less');
add(PYTHON, 'py', 'pyi');
add(RUBY, 'rb');
add(WORD_HASHES, 'sh', 'bash', 'zsh', 'toml', 'r', 'mk', 'graphql', 'gql', 'dockerfile', 'makefile');
add(HCL, 'tf', 'tfvars', 'hcl');
add(PHP, 'php');
add(SQL, 'sql');
add(LUA, 'lua');
add(HASKELL, 'hs');
add(HTML, 'html', 'htm', 'xml', 'svg', 'md', 'markdown');
add(COMPONENT, 'vue', 'svelte', 'astro');
add(INI, 'ini', 'cfg', 'properties', 'env');
add('yaml', 'yaml', 'yml', 'tpl');
add('template', 'tmpl', 'gotmpl');

/** A comment's stand-in: one space and the line breaks it spanned. */
const blank = (s: string) => ` ${s.replace(/[^\n]/g, '')}`;

/** Index just past the string whose body starts at `j`; at a line end for a one-line string left open. */
function stringEnd(text: string, j: number, close: string, quote: Quote): number {
  while (j < text.length) {
    if (quote.escape === 'backslash' && text[j] === '\\') j += 2;
    else if (text.startsWith(close, j)) {
      if (quote.escape === 'double' && text.startsWith(close, j + close.length)) j += 2 * close.length;
      else return j + close.length;
    } else if (text[j] === '\n' && !quote.lines) return j;
    else j++;
  }
  return text.length;
}

/** Index just past the block comment opened at `i`; undefined when nothing closes it. */
function blockEnd(text: string, i: number, block: Block, m: RegExpExecArray): number | undefined {
  const close = block.close(m);
  const closes = (j: number) => (typeof close === 'string' ? (text.startsWith(close, j) ? close.length : 0) : (at(close, text, j)?.[0].length ?? 0));
  let depth = 1;
  let j = i + m[0].length;
  while (j < text.length) {
    const length = closes(j);
    if (length) {
      if (--depth === 0) return j + length;
      j += length;
    } else if (block.nested && (block.open.lastIndex = j, block.open.test(text))) {
      depth++;
      j = block.open.lastIndex;
    } else j++;
  }
  return undefined;
}

const at = (re: RegExp, text: string, i: number) => {
  re.lastIndex = i;
  return re.exec(text);
};

const CHAR = /'(?:\\[^'\n]{1,8}|[^'\\\n])'/y;

function scan(text: string, s: Syntax): string {
  let out = '';
  let i = 0;
  // Python only: where a bare string is a statement.
  let statement = true;
  let depth = 0;
  let last = '';
  const code = (piece: string) => {
    out += piece;
    for (const ch of piece) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === '\n') {
        statement = depth === 0 && last !== '\\';
        last = '\n';
      } else if (!/\s/.test(ch)) {
        statement = depth === 0 && ch === ';';
        last = ch;
      }
    }
  };
  outer: while (i < text.length) {
    for (const block of s.blocks) {
      const m = at(block.open, text, i);
      if (!m) continue;
      const end = blockEnd(text, i, block, m);
      // Left open: more likely a misread than a comment to the end of the file.
      if (end === undefined) break;
      out += blank(text.slice(i, end));
      i = end;
      continue outer;
    }
    for (const line of s.lines) {
      if (!at(line, text, i)) continue;
      const nl = text.indexOf('\n', i);
      out += ' ';
      i = nl < 0 ? text.length : nl;
      continue outer;
    }
    for (const quote of s.quotes) {
      const m = at(quote.open, text, i);
      if (!m) continue;
      const end = stringEnd(text, i + m[0].length, typeof quote.close === 'string' ? quote.close : quote.close(m), quote);
      const literal = text.slice(i, end);
      if (s.docstrings && statement) out += blank(literal);
      else {
        out += literal;
        statement = false;
        last = '"';
      }
      i = end;
      continue outer;
    }
    const char = s.chars && text[i] === "'" ? at(CHAR, text, i) : null;
    const piece = char ? char[0] : text[i]!;
    code(piece);
    i += piece.length;
  }
  return out;
}

// Go templates: `{{/*` or `{{- /*` up to `*/}}` or `*/ -}}`.
const TEMPLATE_COMMENT = /\{\{(?:-\s)?\/\*[\s\S]*?\*\/(?:\s-)?\}\}/g;
const BLOCK_SCALAR = /(?:^\s*|[:?-]\s+)[|>][-+1-9]{0,2}\s*$/;
const indentOf = (s: string) => s.length - s.trimStart().length;

type Scalar = { parent: number; content?: number } | undefined;

/** Whether `line` is still inside the `|` or `>` block scalar: the key line's indent, and its content's once a line sets it. */
function inScalar(scalar: Scalar, line: string): Scalar {
  if (!scalar || line.trim() === '') return scalar;
  const indent = indentOf(line);
  const content = scalar.content ?? (indent > scalar.parent ? indent : undefined);
  return content !== undefined && indent >= content ? { ...scalar, content } : undefined;
}

// A quote opens a scalar only where one starts: `a: "x"`, `- 'x'`, `[ "x"`, not `don't`.
const opensScalar = (prev: string, before: string) => prev === '' || '[{,'.includes(prev) || (':?-'.includes(prev) && /\s/.test(before));

/** End of the template action or quoted scalar that starts at `i`, if one does. */
function skipAt(text: string, i: number, prev: string): number | undefined {
  if (text.startsWith('{{', i)) {
    const close = text.indexOf('}}', i + 2);
    return close < 0 ? text.length : close + 2;
  }
  const ch = text[i]!;
  if ((ch !== '"' && ch !== "'") || !opensScalar(prev, text[i - 1] ?? '')) return undefined;
  return stringEnd(text, i + 1, ch, { open: /./y, close: ch, escape: ch === '"' ? 'backslash' : 'double', lines: true });
}

/** The YAML from `i` to its line end, or past it through a quoted scalar or action, with its comment blanked; and where it stopped. */
function yamlLine(text: string, i: number): [string, number] {
  let out = '';
  let prev = '';
  while (i < text.length && text[i] !== '\n') {
    const ch = text[i]!;
    const end = skipAt(text, i, prev);
    if (end !== undefined) {
      out += text.slice(i, end);
      prev = ch === '{' ? '}' : ch;
      i = end;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      const nl = text.indexOf('\n', i);
      return [`${out} `, nl < 0 ? text.length : nl];
    } else {
      out += ch;
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
  }
  return [out, i];
}

/** YAML: `#` at a word start, outside quoted scalars, block scalars and `{{ }}` template actions. */
function yaml(text: string): string {
  let out = '';
  let i = 0;
  let scalar: Scalar;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const eol = nl < 0 ? text.length : nl;
    const raw = text.slice(i, eol);
    scalar = inScalar(scalar, raw);
    if (scalar) {
      out += text.slice(i, eol + 1);
      i = eol + 1;
      continue;
    }
    const [line, end] = yamlLine(text, i);
    out += end < text.length ? `${line}\n` : line;
    if (BLOCK_SCALAR.test(line)) scalar = { parent: indentOf(raw) };
    i = end + 1;
  }
  return out;
}

const withoutTemplateComments = (text: string) => text.replace(TEMPLATE_COMMENT, blank);

/** `text` with its comments blanked, read by `path`'s extension (or a `Dockerfile`/`Makefile` name); an unknown kind of file comes back as it is. */
export function withoutComments(path: string, text: string): string {
  const name = basename(path).toLowerCase();
  const syntax = BY_EXT[extname(name).slice(1)] ?? BY_EXT[name];
  if (syntax === undefined) return text;
  if (syntax === 'template') return withoutTemplateComments(text);
  if (syntax === 'yaml') return yaml(withoutTemplateComments(text));
  return scan(text, syntax);
}

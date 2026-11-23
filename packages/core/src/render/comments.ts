import { basename, extname } from 'node:path';
import { scan, type Block, type Quote, type Syntax } from './comment-scan.js';
import { withoutTemplateComments, yaml } from './comment-yaml.js';

// `//` right after `:` is a URL (`https://x` in JSX text), and after `\` an escaped slash in a regex, not a comment.
const SLASHES = /(?<![:\\])\/\//y;
const HASH = /#/y;
// Shell, YAML: `#` opens a comment only at a word start, so `${#a}` and `a#b` stay.
const WORD_HASH = /(?<!\S)#/y;
const C_BLOCK: Block = { open: /(?<!\\)\/\*/y, close: () => '*/' };
const HTML_BLOCK: Block = { open: /<!--/y, close: () => '-->' };

const q = (open: RegExp, close: string, escape: Quote['escape'] = 'backslash', lines = false): Quote => ({ open, close, escape, lines });
const DOUBLE = q(/"/y, '"');
const SINGLE = q(/'/y, "'");
const TEMPLATE: Quote = { ...q(/`/y, '`', 'backslash', true), interpolation: true };
const TRIPLE_DOUBLE = q(/"""/y, '"""', 'none', true);

const JS_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const RUBY_REGEX = new Set(['return', 'if', 'elsif', 'unless', 'when', 'while', 'until', 'and', 'or', 'not', 'then', 'else', 'case']);

const C_LIKE: Syntax = { lines: [SLASHES], blocks: [C_BLOCK], quotes: [DOUBLE, SINGLE, TEMPLATE], regex: JS_REGEX };
const C_CHARS: Syntax = { lines: [SLASHES], blocks: [C_BLOCK], quotes: [TRIPLE_DOUBLE, DOUBLE], chars: true };
const GO: Syntax = { lines: [SLASHES], blocks: [C_BLOCK], quotes: [DOUBLE, q(/`/y, '`', 'none', true)], chars: true };
const RUST: Syntax = {
  lines: [SLASHES],
  blocks: [C_BLOCK],
  quotes: [{ open: /(?<!\w)b?r(#*)"/y, close: (m) => `"${m[1]}`, escape: 'none', lines: true }, q(/"/y, '"', 'backslash', true)],
  chars: true,
};
const CSHARP: Syntax = { lines: [SLASHES], blocks: [C_BLOCK], quotes: [q(/\$?@\$?"/y, '"', 'double', true), TRIPLE_DOUBLE, DOUBLE], chars: true };
const CSS: Syntax = { lines: [], blocks: [C_BLOCK], quotes: [DOUBLE, SINGLE] };
const SCSS: Syntax = { ...CSS, lines: [SLASHES] };
const PYTHON: Syntax = {
  lines: [HASH],
  blocks: [],
  quotes: [{ open: /(?<!\w)[rRuUbBfF]{0,2}("""|'''|"|')/y, close: (m) => m[1]!, escape: 'backslash', lines: true }],
  docstrings: true,
};
const WORD_HASHES: Syntax = { lines: [WORD_HASH], blocks: [], quotes: [DOUBLE, SINGLE] };
const HASHES: Syntax = { lines: [HASH], blocks: [], quotes: [DOUBLE, SINGLE] };
const BRACKETS: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };
// Ruby: `#` anywhere outside strings, `/regex/` and `%w[…]`-style literals, but not the character `?#`; `% (` after an operand is modulo.
const RUBY: Syntax = {
  lines: [/(?<!\?)#/y],
  blocks: [{ open: /(?<![^\n])=begin\b/y, close: () => /\n=end(?=\s|$)/y }],
  quotes: [DOUBLE, SINGLE, { open: /(?<![\w)\]}])%[qQwWiIrsx]?([[({<])/y, close: (m) => BRACKETS[m[1]!]!, escape: 'backslash', lines: true }],
  regex: RUBY_REGEX,
};
// Make: `#` anywhere, but a tab-indented recipe line is shell, where it opens a comment only at a word start.
const makefile = (text: string) => text.split('\n').map((line) => scan(line, line.startsWith('\t') ? WORD_HASHES : HASHES)).join('\n');
const TOML: Syntax = { lines: [HASH], blocks: [], quotes: [q(/"""/y, '"""', 'backslash', true), q(/'''/y, "'''", 'none', true), DOUBLE, q(/'/y, "'", 'none')] };
const GRAPHQL: Syntax = { lines: [HASH], blocks: [], quotes: [TRIPLE_DOUBLE, DOUBLE] };
const HCL: Syntax = { lines: [HASH, SLASHES], blocks: [C_BLOCK], quotes: [DOUBLE] };
// PHP 8 attributes start `#[`.
const PHP: Syntax = { lines: [/#(?!\[)/y, SLASHES], blocks: [C_BLOCK], quotes: [DOUBLE, SINGLE] };
// PostgreSQL's `$$…$$` and `$tag$…$tag$` strings.
const DOLLAR: Quote = { open: /\$([A-Za-z_]\w*)?\$/y, close: (m) => m[0], escape: 'none', lines: true };
const SQL: Syntax = { lines: [/--/y], blocks: [C_BLOCK], quotes: [q(/'/y, "'", 'double'), q(/"/y, '"', 'double'), DOLLAR] };
const LONG_BRACKETS: Quote = { open: /\[(=*)\[/y, close: (m) => `]${m[1]}]`, escape: 'none', lines: true };
const LUA: Syntax = { lines: [/--/y], blocks: [{ open: /--\[(=*)\[/y, close: (m) => `]${m[1]}]` }], quotes: [DOUBLE, SINGLE, LONG_BRACKETS] };
// `-->` is an operator, not a comment.
const HASKELL: Syntax = { lines: [/--+(?![!#$%&*+./<=>?@\\^|~:])/y], blocks: [{ open: /\{-/y, close: () => '-}', nested: true }], quotes: [DOUBLE] };
// Prose has apostrophes, so no quotes.
const HTML: Syntax = { lines: [], blocks: [HTML_BLOCK], quotes: [] };
const COMPONENT: Syntax = { lines: [SLASHES], blocks: [HTML_BLOCK, C_BLOCK], quotes: [DOUBLE, SINGLE, TEMPLATE], regex: JS_REGEX };
const INI: Syntax = { lines: [/(?<!\S)[#;]/y], blocks: [], quotes: [] };

type Reader = Syntax | 'yaml' | 'template' | 'make';
const BY_EXT: Record<string, Reader> = {};
const add = (syntax: Reader, ...exts: string[]) => exts.forEach((e) => (BY_EXT[e] = syntax));
add(C_LIKE, 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'groovy', 'gradle', 'dart');
add(C_CHARS, 'java', 'kt', 'kts', 'scala', 'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'proto');
add(GO, 'go');
add(RUST, 'rs');
add(CSHARP, 'cs');
add(CSS, 'css');
add(SCSS, 'scss', 'less');
add(PYTHON, 'py', 'pyi');
add(RUBY, 'rb');
add(TOML, 'toml');
add(GRAPHQL, 'graphql', 'gql');
add(HASHES, 'r');
add('make', 'mk', 'makefile');
add(WORD_HASHES, 'sh', 'bash', 'zsh', 'dockerfile');
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

// Helm runs `.tpl` files and YAML under a chart's `templates/` as Go templates; other YAML is plain, so `{{/* */}}` there is text.
const isTemplate = (path: string, name: string) => name.endsWith('.tpl') || /(?:^|[\\/])templates[\\/]/.test(path);

/** `text` with its comments blanked, read by `path`'s extension (or a `Dockerfile`/`Makefile` name); an unknown kind of file comes back as it is. */
export function withoutComments(path: string, text: string): string {
  const name = basename(path).toLowerCase();
  const syntax = BY_EXT[extname(name).slice(1)] ?? BY_EXT[name];
  if (syntax === undefined) return text;
  if (syntax === 'template') return withoutTemplateComments(text);
  if (syntax === 'make') return makefile(text);
  if (syntax === 'yaml') return yaml(isTemplate(path, name) ? withoutTemplateComments(text) : text);
  return scan(text, syntax);
}

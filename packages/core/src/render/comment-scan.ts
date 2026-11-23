/** A comment that runs to its closing text, which may read what opened it (Lua's `--[==[`), or to a sticky pattern. */
export interface Block {
  open: RegExp;
  close: (m: RegExpExecArray) => string | RegExp;
  /** Haskell's `{- {- -} -}`. */
  nested?: boolean;
}

/** A string literal; `escape` is how a closing quote is kept inside it. */
export interface Quote {
  open: RegExp;
  close: string | ((m: RegExpExecArray) => string);
  escape: 'backslash' | 'double' | 'none';
  /** May run over line ends; else the string stops at one, so a stray quote can't hide the rest of the file. */
  lines?: boolean;
  /** A JS template literal: code inside `${…}` is read as code. */
  interpolation?: boolean;
  /** Ruby's `%w[a[b]]`: the opening bracket, whose pairs nest inside. */
  nests?: (m: RegExpExecArray) => string;
}

export interface Syntax {
  /** Line comments; sticky, so a lookbehind can say where one may start. */
  lines: RegExp[];
  blocks: Block[];
  quotes: Quote[];
  /** `'` opens only `'x'` or `'\…'`: elsewhere it is a Rust lifetime or a C++ digit separator. */
  chars?: boolean;
  /** Python: a string standing alone as a statement (at a line start, after `;` or after a `def`/`class`/… header's `:`) is a docstring, so a comment. An f-string is code. */
  docstrings?: boolean;
  /** JS, Ruby: `/` where an operand starts opens a regex literal: after an operator, or after one of these keywords. */
  regex?: ReadonlySet<string>;
}

/** A comment's stand-in: one space and the line breaks it spanned. */
export const blank = (s: string) => ` ${s.replace(/[^\n]/g, '')}`;

/** Index just past the string whose body starts at `j`; at a line end for a one-line string left open. */
export function stringEnd(text: string, j: number, close: string, quote: Quote, opener?: string): number {
  let depth = 0;
  while (j < text.length) {
    if (quote.escape === 'backslash' && text[j] === '\\') j += 2;
    else if (opener !== undefined && text[j] === opener) {
      depth++;
      j++;
    } else if (text.startsWith(close, j)) {
      if (quote.escape === 'double' && text.startsWith(close, j + close.length)) j += 2 * close.length;
      else if (depth > 0) {
        depth--;
        j += close.length;
      } else return j + close.length;
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
const IDENT = /[\w$]/;
// A `/` after one of these, or after one of the keywords, starts an operand: a regex, not a division.
const BEFORE_REGEX = '(,=:[!&|?{};+-*%~^<>';
// Python: a `:` ending one of these opens a body, where a string may be a docstring.
const HEADERS = new Set(['def', 'class', 'async', 'if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally', 'match', 'case']);
// Soft keywords: `match: "Order"` annotates a variable named match.
const SOFT = new Set(['match', 'case']);
const opensBody = (st: State) => HEADERS.has(st.head) && !(SOFT.has(st.head) && IDENT.test(st.last) && st.word === st.head);

interface State {
  out: string;
  /** Python: a bare string here is a statement. */
  statement: boolean;
  /** Open brackets, and open braces alone. */
  depth: number;
  braces: number;
  /** For each `${` still open, the braces count it closes at. */
  templates: number[];
  /** The last code character that isn't a space (a line end counts), the same with line ends skipped, and the one before this character. */
  last: string;
  code: string;
  /** The code character before `code`: `++` and `--` end an operand. */
  before: string;
  prev: string;
  /** The word ending at `last`, and the statement's first word. */
  word: string;
  head: string;
  inHead: boolean;
}

/** The word ending at `ch`, and the statement's first word, which says whether its `:` opens a body. */
function trackWords(st: State, ch: string): boolean {
  const ident = IDENT.test(ch);
  const continues = ident && IDENT.test(st.prev);
  if (ident) {
    st.word = continues ? st.word + ch : ch;
    st.head = st.statement ? ch : continues && st.inHead ? st.head + ch : st.head;
  }
  st.inHead = ident && (st.statement || (continues && st.inHead));
  return ident;
}

/** Follows one character of code. */
function track(st: State, ch: string): void {
  const ident = trackWords(st, ch);
  if ('([{'.includes(ch)) st.depth++;
  else if (')]}'.includes(ch)) st.depth = Math.max(0, st.depth - 1);
  if (ch === '{') st.braces++;
  else if (ch === '}') st.braces--;
  if (ch === '\n') {
    st.statement = st.depth === 0 && st.last !== '\\';
    st.last = '\n';
  } else if (!/\s/.test(ch)) {
    st.statement = st.depth === 0 && (ch === ';' || (ch === ':' && opensBody(st)));
    st.last = ch;
    st.before = st.code;
    st.code = ch;
    if (!ident) st.word = '';
  }
  st.prev = ch;
}

/** Code that reads as one operand, a string or a regex. */
function literal(st: State, piece: string): void {
  st.out += piece;
  st.statement = false;
  st.last = '"';
  st.code = '"';
  st.word = '';
  st.prev = '"';
}

/** Where the template literal text from `j` stops: past its closing backtick, or past a `${` (`open`). */
function templateEnd(text: string, j: number): { end: number; open: boolean } {
  while (j < text.length) {
    if (text[j] === '\\') j += 2;
    else if (text[j] === '`') return { end: j + 1, open: false };
    else if (text.startsWith('${', j)) return { end: j + 2, open: true };
    else j++;
  }
  return { end: text.length, open: false };
}

/** Index just past the regex literal at `i`; undefined when its line has no closing `/`. */
function regexEnd(text: string, i: number): number | undefined {
  let inClass = false;
  for (let j = i + 1; j < text.length && text[j] !== '\n'; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return j + 1;
  }
  return undefined;
}

// A line end decides nothing: `a\n/b/g` is a division, as JS reads it.
const regexStarts = (st: State, keywords: ReadonlySet<string>) =>
  (BEFORE_REGEX.includes(st.code) && !((st.code === '+' || st.code === '-') && st.before === st.code)) || (IDENT.test(st.code) && keywords.has(st.word));

/** A comment at `i`: its stand-in and where it ends. */
function commentAt(text: string, i: number, s: Syntax): [string, number] | undefined {
  for (const block of s.blocks) {
    const m = at(block.open, text, i);
    if (!m) continue;
    const end = blockEnd(text, i, block, m);
    // Left open: more likely a misread than a comment to the end of the file.
    if (end === undefined) break;
    return [blank(text.slice(i, end)), end];
  }
  for (const line of s.lines) {
    if (!at(line, text, i)) continue;
    const nl = text.indexOf('\n', i);
    return [' ', nl < 0 ? text.length : nl];
  }
  return undefined;
}

/** Reads the string at `i`, if one starts there, into `st`; returns where it ends. */
function stringAt(text: string, i: number, s: Syntax, st: State): number | undefined {
  for (const quote of s.quotes) {
    const m = at(quote.open, text, i);
    if (!m) continue;
    if (quote.interpolation) {
      const { end, open } = templateEnd(text, i + m[0].length);
      if (open) st.templates.push(st.braces);
      literal(st, text.slice(i, end));
      return end;
    }
    const end = stringEnd(text, i + m[0].length, typeof quote.close === 'string' ? quote.close : quote.close(m), quote, quote.nests?.(m));
    if (s.docstrings && st.statement && !/[fF]/.test(m[0])) st.out += blank(text.slice(i, end));
    else literal(st, text.slice(i, end));
    return end;
  }
  return undefined;
}

/** Reads what isn't a comment or a string at `i` into `st`: a template literal resuming after `${…}`, a regex, a char or one character. */
function codeAt(text: string, i: number, s: Syntax, st: State): number {
  if (text[i] === '}' && st.templates.at(-1) === st.braces) {
    st.templates.pop();
    const { end, open } = templateEnd(text, i + 1);
    if (open) st.templates.push(st.braces);
    literal(st, text.slice(i, end));
    return end;
  }
  const regex = s.regex && text[i] === '/' && regexStarts(st, s.regex) ? regexEnd(text, i) : undefined;
  if (regex !== undefined) {
    literal(st, text.slice(i, regex));
    return regex;
  }
  const char = s.chars && text[i] === "'" ? at(CHAR, text, i) : null;
  const piece = char ? char[0] : text[i]!;
  st.out += piece;
  for (const ch of piece) track(st, ch);
  return i + piece.length;
}

export function scan(text: string, s: Syntax): string {
  const st: State = { out: '', statement: true, depth: 0, braces: 0, templates: [], last: '', code: '', before: '', prev: '', word: '', head: '', inHead: false };
  let i = 0;
  while (i < text.length) {
    const comment = commentAt(text, i, s);
    if (comment) {
      st.out += comment[0];
      i = comment[1];
      continue;
    }
    i = stringAt(text, i, s, st) ?? codeAt(text, i, s, st);
  }
  return st.out;
}

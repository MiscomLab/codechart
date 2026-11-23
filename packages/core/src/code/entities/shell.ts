/** One shell word: its value with quotes and escapes removed, where it sits in the text, and whether it expands. */
export interface Word {
  value: string;
  /** The span of the characters its value comes from, quotes left out. */
  start: number;
  end: number;
  /** Holds a `$` or backtick outside single quotes: its value is only known when the shell runs. */
  expands: boolean;
}

const BLANK = new Set([' ', '\t', '\r']);
const ANSI_C: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
/** Numeric escapes of `$'…'`: the pattern of their digits after the backslash, and their base. */
const ANSI_NUMERIC: [RegExp, number][] = [
  [/^x([\da-fA-F]{1,2})/, 16],
  [/^u([\da-fA-F]{1,4})/, 16],
  [/^U([\da-fA-F]{1,8})/, 16],
  [/^([0-7]{1,3})/, 8],
];

/** The escape at `j` of a `$'…'` string: what it stands for and how many characters it takes. Bash keeps unknown ones as written. */
function ansiEscape(text: string, j: number): [string, number] {
  const rest = text.slice(j + 1, j + 10);
  for (const [pattern, base] of ANSI_NUMERIC) {
    const digits = pattern.exec(rest);
    if (!digits) continue;
    const code = parseInt(digits[1]!, base);
    return [code <= 0x10ffff ? String.fromCodePoint(code) : '', 1 + digits[0].length];
  }
  const known = ANSI_C[text[j + 1]!];
  return known === undefined ? [text.slice(j, j + 2), 2] : [known, 2];
}
const OPERATOR = new Set([';', '&', '|', '(', ')']);

/** Splits shell text into simple commands of words, as bash does: quotes, escapes, comments, continuations, heredocs. */
class Lexer {
  private i = 0;
  private word: Word | undefined;
  private words: Word[] = [];
  readonly commands: Word[][] = [];
  private heredocs: string[] = [];
  private redirect = false;

  constructor(private readonly text: string) {}

  run(): Word[][] {
    const { text } = this;
    while (this.i < text.length) {
      const ch = text[this.i]!;
      if (ch === '\\' && text[this.i + 1] === '\n') this.i += 2;
      else if (ch === '\\' && text[this.i + 1] === '\r' && text[this.i + 2] === '\n') this.i += 3;
      else if (ch === '\n') this.newline();
      else if (BLANK.has(ch)) this.endWord();
      else if (ch === '#' && !this.word) this.skipComment();
      else if (OPERATOR.has(ch)) this.operator();
      else if (ch === '<' || ch === '>') this.redirection();
      else this.wordChar();
    }
    this.endCommand();
    return this.commands;
  }

  private current(): Word {
    return (this.word ??= { value: '', start: -1, end: -1, expands: false });
  }

  /** Adds `chars`, written at `[from, to)`, to the word and moves the cursor to `next`. */
  private add(chars: string, next: number, from = this.i, to = next): void {
    const word = this.current();
    word.value += chars;
    if (chars) {
      if (word.start < 0) word.start = from;
      word.end = to;
    }
    this.i = next;
  }

  private endWord(): void {
    if (this.word && this.word.start < 0) this.word = undefined;
    if (this.word) {
      if (this.redirect) this.redirect = false;
      else this.words.push(this.word);
      if (this.heredocs.length && this.heredocs.at(-1) === '') this.heredocs[this.heredocs.length - 1] = this.word.value;
    }
    this.word = undefined;
    if (this.i < this.text.length && BLANK.has(this.text[this.i]!)) this.i++;
  }

  private endCommand(): void {
    this.endWord();
    if (this.words.length) this.commands.push(this.words);
    this.words = [];
    this.redirect = false;
  }

  private newline(): void {
    this.endCommand();
    this.i++;
    // Heredoc bodies are data, not commands.
    for (const delimiter of this.heredocs.splice(0)) {
      while (this.i < this.text.length) {
        const eol = this.text.indexOf('\n', this.i);
        const line = this.text.slice(this.i, eol < 0 ? this.text.length : eol);
        this.i = eol < 0 ? this.text.length : eol + 1;
        if (line.replace(/^\t+/, '').replace(/\r$/, '') === delimiter) break;
      }
    }
  }

  private skipComment(): void {
    while (this.i < this.text.length && this.text[this.i] !== '\n') this.i++;
  }

  private operator(): void {
    this.endCommand();
    this.i++;
  }

  private redirection(): void {
    // `2>file`: the digits name a file descriptor, not an argument.
    if (this.word && /^\d+$/.test(this.word.value)) this.word = undefined;
    this.endWord();
    const heredoc = this.text.startsWith('<<', this.i) && this.text[this.i + 2] !== '<';
    while (this.text[this.i] === '<' || this.text[this.i] === '>' || this.text[this.i] === '&' || this.text[this.i] === '-') this.i++;
    if (heredoc) this.heredocs.push('');
    else this.redirect = true;
    // The heredoc delimiter is the next word; it is no argument either.
    if (heredoc) this.redirect = true;
  }

  private wordChar(): void {
    const { text } = this;
    const ch = text[this.i]!;
    if (ch === "'") {
      const close = text.indexOf("'", this.i + 1);
      const end = close < 0 ? text.length : close;
      this.add(text.slice(this.i + 1, end), Math.min(end + 1, text.length), this.i + 1, end);
    } else if (ch === '"') {
      this.doubleQuoted();
    } else if (ch === '\\') {
      this.add(text[this.i + 1] ?? '', this.i + 2, this.i + 1);
    } else if (ch === '$' && text[this.i + 1] === "'") {
      this.ansiC();
    } else if (ch === '$' || ch === '`') {
      this.current().expands = true;
      const expansion = this.expansion();
      this.add(expansion, this.i + expansion.length);
    } else {
      this.add(ch, this.i + 1);
    }
  }

  /** `$'…'`: single-quoted, with backslash escapes. */
  private ansiC(): void {
    const { text } = this;
    let value = '';
    let j = this.i + 2;
    while (j < text.length && text[j] !== "'") {
      if (text[j] === '\\' && j + 1 < text.length) {
        const [chars, length] = ansiEscape(text, j);
        value += chars;
        j += length;
      } else value += text[j++];
    }
    this.add(value, Math.min(j + 1, text.length), this.i + 2, j);
  }

  private doubleQuoted(): void {
    const { text } = this;
    let value = '';
    let j = this.i + 1;
    const word = this.current();
    while (j < text.length && text[j] !== '"') {
      if (text[j] === '\\' && '"\\$`\n'.includes(text[j + 1] ?? '')) {
        if (text[j + 1] !== '\n') value += text[j + 1];
        j += 2;
      } else if (text[j] === '$' || text[j] === '`') {
        word.expands = true;
        const saved = this.i;
        this.i = j;
        const expansion = this.expansion();
        this.i = saved;
        value += expansion;
        j += expansion.length;
      } else {
        value += text[j++];
      }
    }
    this.add(value, Math.min(j + 1, text.length), this.i + 1, j);
  }

  /** The text of the expansion at the cursor: `$x`, `${…}`, `$(…)`, `` `…` ``, kept as written. */
  private expansion(): string {
    const { text, i } = this;
    if (text[i] === '`') {
      const close = text.indexOf('`', i + 1);
      return text.slice(i, close < 0 ? text.length : close + 1);
    }
    const open = text[i + 1];
    if (open === '(' || open === '{') return text.slice(i, balanced(text, i + 1));
    const name = /^\$(?:[A-Za-z_]\w*|[0-9@*#?$!-])?/.exec(text.slice(i))![0];
    return name;
  }
}

/** The index after the bracket that closes the one at `open`, skipping quoted text. */
function balanced(text: string, open: number): number {
  const close = text[open] === '(' ? ')' : '}';
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const ch = text[j]!;
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, j + 1);
      j = end < 0 ? text.length : end;
    } else if (ch === '\\') j++;
    else if (ch === text[open]) depth++;
    else if (ch === close && --depth === 0) return j + 1;
  }
  return text.length;
}

export const shellCommands = (text: string): Word[][] => new Lexer(text).run();

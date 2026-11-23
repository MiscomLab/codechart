/** One shell word: its value with quotes and escapes removed, where it sits in the text, and whether it expands. */
export interface Word {
  value: string;
  /** The span of the characters its value comes from, quotes left out. */
  start: number;
  end: number;
  /** Holds a `$` or backtick outside single quotes: its value is only known when the shell runs. */
  expands: boolean;
}

/** A file a command runs; `searched` when bash looks it up on PATH before the working directory (`source x`). */
export interface RunTarget {
  word: Word;
  searched: boolean;
}

const BLANK = new Set([' ', '\t', '\r']);
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
    } else if (ch === '$' || ch === '`') {
      this.current().expands = true;
      const expansion = this.expansion();
      this.add(expansion, this.i + expansion.length);
    } else {
      this.add(ch, this.i + 1);
    }
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

interface Launcher {
  /** Options after which no file follows (`-c` code, `-m` module). */
  stop: ReadonlySet<string>;
  /** Options that take the next word as their value. */
  value: ReadonlySet<string>;
  /** Single-letter options may be grouped (`-ex`); the letters that stop or take a value. */
  letters?: { stop: string; value: string };
  /** Subcommands that come before the file (`tsx watch`). */
  subcommands?: ReadonlySet<string>;
}

const SHELL: Launcher = { stop: new Set(), value: new Set(['--rcfile', '--init-file']), letters: { stop: 'cs', value: 'oO' } };
const PYTHON: Launcher = { stop: new Set(['-']), value: new Set(), letters: { stop: 'cm', value: 'WXQ' } };
const NODE_VALUES = ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title', '--watch-path'];
const NODE: Launcher = { stop: new Set(['-e', '--eval', '-p', '--print', '-i', '--interactive', '-']), value: new Set(NODE_VALUES) };
const TSX: Launcher = { ...NODE, value: new Set([...NODE_VALUES, '--tsconfig']), subcommands: new Set(['watch']) };
const TS_NODE: Launcher = {
  stop: NODE.stop,
  value: new Set(['-r', '--require', '-P', '--project', '-O', '--compiler-options', '-C', '--compiler', '--cwd', '--scope-dir', '-I', '--ignore']),
};

const LAUNCHERS: Record<string, Launcher> = { bash: SHELL, sh: SHELL, zsh: SHELL, python: PYTHON, python3: PYTHON, node: NODE, tsx: TSX, 'ts-node': TS_NODE };

/** Commands that run the rest of the line as a command, and the options of theirs that take a value. */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S']),
  exec: new Set(['-a']),
  nohup: new Set(),
  command: new Set(),
  time: new Set(['-f', '-o']),
  npx: new Set(['-p', '--package', '-c', '--call']),
};

/** Words that start a compound command without changing which command runs next. */
const LEAD = new Set(['!', '{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;

/** The word after a launcher's options that names the file it runs, or undefined when there is none. */
function launched(words: readonly Word[], launcher: Launcher): Word | undefined {
  let subcommand = true;
  for (let k = 0; k < words.length; k++) {
    const { value } = words[k]!;
    if (value === '--') return words[k + 1];
    if (launcher.stop.has(value)) return undefined;
    if (value.startsWith('--')) {
      if (launcher.value.has(value)) k++;
      continue;
    }
    if (/^[-+][A-Za-z]/.test(value)) {
      if (launcher.value.has(value)) {
        k++;
        continue;
      }
      const { letters } = launcher;
      if (!letters) continue;
      const flags = value.slice(1);
      if ([...flags].some((l) => letters.stop.includes(l))) return undefined;
      if (letters.value.includes(flags.at(-1)!)) k++;
      continue;
    }
    if (subcommand && launcher.subcommands?.has(value)) {
      subcommand = false;
      continue;
    }
    return words[k];
  }
  return undefined;
}

/** Skips a wrapper's options and assignments; the index of the command it runs. */
function afterWrapper(words: readonly Word[], at: number, options: ReadonlySet<string>): number {
  let k = at + 1;
  while (k < words.length) {
    const { value } = words[k]!;
    if (options.has(value)) k += 2;
    else if (value.startsWith('-') || ASSIGNMENT.test(value)) k++;
    else break;
  }
  return k;
}

/** The file one simple command runs: a path as the command itself, or the script a launcher or `source` runs. */
export function runTarget(words: readonly Word[]): RunTarget | undefined {
  let k = 0;
  for (;;) {
    while (k < words.length && (ASSIGNMENT.test(words[k]!.value) || LEAD.has(words[k]!.value))) k++;
    const wrapper = words[k] && WRAPPERS[words[k]!.value];
    if (!wrapper) break;
    k = afterWrapper(words, k, wrapper);
  }
  const first = words[k];
  if (!first) return undefined;
  const rest = words.slice(k + 1);
  if (first.value === 'source' || first.value === '.') {
    const file = rest[0];
    return file && { word: file, searched: !file.value.includes('/') };
  }
  const launcher = LAUNCHERS[first.value];
  if (launcher) {
    const file = launched(rest, launcher);
    return file && { word: file, searched: false };
  }
  // A command name with a slash is a path; without one, bash looks it up on PATH.
  return first.value.includes('/') ? { word: first, searched: false } : undefined;
}

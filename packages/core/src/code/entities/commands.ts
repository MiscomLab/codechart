import type { Word } from './shell.js';

/** A file a command runs; `searched` when bash looks it up on PATH before the working directory (`source x`). */
export interface RunTarget {
  word: Word;
  searched: boolean;
}

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
const NODE: Launcher = { stop: new Set(['-e', '--eval', '-p', '--print', '-i', '--interactive', '-']), value: new Set(NODE_VALUES), letters: { stop: 'epi', value: 'rC' } };
const TSX: Launcher = { ...NODE, value: new Set([...NODE_VALUES, '--tsconfig']), subcommands: new Set(['watch']) };
const TS_NODE: Launcher = {
  stop: NODE.stop,
  value: new Set(['-r', '--require', '-P', '--project', '-O', '--compiler-options', '-C', '--compiler', '--cwd', '--scope-dir', '-I', '--ignore']),
  letters: { stop: 'epi', value: 'rPOCI' },
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

/** Wrapper options after which nothing runs: `command -v x` only prints where `x` is. */
const WRAPPER_STOPS: Record<string, ReadonlySet<string>> = { command: new Set(['-v', '-V']) };

/** Commands that change the working directory for the commands after them. */
const FOLDER_CHANGES = new Set(['cd', 'pushd', 'popd']);

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
      // `-ex` groups flags; after one that takes a value, the rest of the word is that value (`-r./setup.js`).
      const flags = value.slice(1);
      const valueAt = [...flags].findIndex((l) => letters.value.includes(l));
      const grouped = valueAt < 0 ? flags : flags.slice(0, valueAt + 1);
      if ([...grouped].some((l) => letters.stop.includes(l))) return undefined;
      if (valueAt === flags.length - 1) k++;
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

/** Skips a wrapper's options and assignments; the index of the command it runs, past the end when nothing runs. */
function afterWrapper(words: readonly Word[], at: number, options: ReadonlySet<string>): number {
  const stops = WRAPPER_STOPS[words[at]!.value];
  let k = at + 1;
  while (k < words.length) {
    const { value } = words[k]!;
    if (stops?.has(value)) return words.length;
    if (options.has(value)) k += 2;
    else if (value.startsWith('-') || ASSIGNMENT.test(value)) k++;
    else break;
  }
  return k;
}

/** The index of the word naming the command that runs, past wrappers, assignments and compound-command keywords. */
function commandAt(words: readonly Word[]): number {
  let k = 0;
  for (;;) {
    while (k < words.length && (ASSIGNMENT.test(words[k]!.value) || LEAD.has(words[k]!.value))) k++;
    const wrapper = words[k] && WRAPPERS[words[k]!.value];
    if (!wrapper) return k;
    k = afterWrapper(words, k, wrapper);
  }
}

/** Whether the command changes the working directory (`cd`, `pushd`, `popd`). */
export const changesFolder = (words: readonly Word[]): boolean => FOLDER_CHANGES.has(words[commandAt(words)]?.value ?? '');

/** The file one simple command runs: a path as the command itself, or the script a launcher or `source` runs. */
export function runTarget(words: readonly Word[]): RunTarget | undefined {
  const k = commandAt(words);
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

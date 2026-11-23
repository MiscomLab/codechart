import { dirOf, type FileSet } from './files.js';

/** Where a Python spec leads, before it is attached to an `Import`. */
export interface PythonResolution {
  status: 'resolved' | 'unknown' | 'external';
  resolved?: string;
  /** For a namespace package (a folder with no `__init__.py`): the folder, where `from pkg import mod` finds `mod`. */
  packageFolder?: string;
}

/** `sys.stdlib_module_names` of CPython 3.14, so the answer does not depend on the machine that parses the repo. */
const STDLIB = new Set([
  '__future__', '_abc', '_aix_support', '_android_support', '_apple_support', '_ast', '_ast_unparse', '_asyncio',
  '_bisect', '_blake2', '_bz2', '_codecs', '_codecs_cn', '_codecs_hk', '_codecs_iso2022', '_codecs_jp', '_codecs_kr',
  '_codecs_tw', '_collections', '_collections_abc', '_colorize', '_compat_pickle', '_contextvars', '_csv', '_ctypes',
  '_curses', '_curses_panel', '_datetime', '_dbm', '_decimal', '_elementtree', '_frozen_importlib',
  '_frozen_importlib_external', '_functools', '_gdbm', '_hashlib', '_heapq', '_hmac', '_imp', '_interpchannels',
  '_interpqueues', '_interpreters', '_io', '_ios_support', '_json', '_locale', '_lsprof', '_lzma', '_markupbase',
  '_md5', '_multibytecodec', '_multiprocessing', '_opcode', '_opcode_metadata', '_operator', '_osx_support',
  '_overlapped', '_pickle', '_posixshmem', '_posixsubprocess', '_py_abc', '_py_warnings', '_pydatetime', '_pydecimal',
  '_pyio', '_pylong', '_pyrepl', '_queue', '_random', '_remote_debugging', '_scproxy', '_sha1', '_sha2', '_sha3',
  '_signal', '_sitebuiltins', '_socket', '_sqlite3', '_sre', '_ssl', '_stat', '_statistics', '_string', '_strptime',
  '_struct', '_suggestions', '_symtable', '_sysconfig', '_thread', '_threading_local', '_tkinter', '_tokenize',
  '_tracemalloc', '_types', '_typing', '_uuid', '_warnings', '_weakref', '_weakrefset', '_winapi', '_wmi', '_zoneinfo',
  '_zstd', 'abc', 'annotationlib', 'antigravity', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'base64', 'bdb',
  'binascii', 'bisect', 'builtins', 'bz2', 'cProfile', 'calendar', 'cmath', 'cmd', 'code', 'codecs', 'codeop',
  'collections', 'colorsys', 'compileall', 'compression', 'concurrent', 'configparser', 'contextlib', 'contextvars',
  'copy', 'copyreg', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib', 'dis',
  'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput',
  'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'genericpath', 'getopt', 'getpass', 'gettext', 'glob',
  'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'importlib', 'inspect',
  'io', 'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'marshal',
  'math', 'mimetypes', 'mmap', 'modulefinder', 'msvcrt', 'multiprocessing', 'netrc', 'nt', 'ntpath', 'nturl2path',
  'numbers', 'opcode', 'operator', 'optparse', 'os', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pkgutil', 'platform',
  'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr',
  'pydoc', 'pydoc_data', 'pyexpat', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib', 'resource',
  'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site',
  'smtplib', 'socket', 'socketserver', 'sqlite3', 'sre_compile', 'sre_constants', 'sre_parse', 'ssl', 'stat',
  'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny',
  'tarfile', 'tempfile', 'termios', 'textwrap', 'this', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize',
  'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata',
  'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref',
  'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);

/** Files that make a folder a Python project, whose `src/` folder (if any) and root are its source roots. */
const PROJECT_FILES = ['pyproject.toml', 'setup.py', 'setup.cfg'];

/** Probe keys for facts that are not one file's presence: a folder holding Python files, a module name anywhere. */
const pyDirKey = (dir: string): string => `py-dir:${dir}`;
const pyNameKey = (name: string): string => `py-name:${name}`;

/** The probe keys a Python file's arrival or removal can change: the folders holding it and the module names it adds. */
export function pythonProbeKeys(path: string): string[] {
  if (!/\.pyi?$/.test(path)) return [];
  const parts = path.split('/');
  const stem = parts.pop()!.replace(/\.pyi?$/, '');
  const dirs = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  return [...dirs.map(pyDirKey), ...[...parts, stem].map(pyNameKey)];
}

/** One directory's entry for a name, in the order Python's `FileFinder` takes them. */
type Entry = { kind: 'package' | 'module'; file: string; dir?: string } | { kind: 'namespace'; dir: string };

type Lookup = { kind: 'file'; file: string } | { kind: 'namespace'; dirs: string[] } | { kind: 'ambiguous' } | undefined;

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/**
 * Python import resolution over one snapshot of the repo's files (COD-44), following CPython's path finder: in each
 * `sys.path` entry a regular package (`pkg/__init__.py`) comes before a module (`pkg.py`), and a folder without
 * `__init__.py` is a namespace portion that only counts when no entry has a regular match. Only listed files count, so
 * nothing resolves into a virtualenv or build output.
 *
 * `sys.path` is not known statically. It is taken as the importing file's project source roots: the `src/` folder and
 * root of the nearest folder with a project file, or only `src/` for a file inside it. Two regular matches on different entries could each win depending on
 * the real order, so they are unknown.
 */
export class PythonResolver {
  private py: string[] | undefined;
  private pySet: Set<string> | undefined;
  private dirs: Set<string> | undefined;
  private names: Set<string> | undefined;
  private readonly projects = new Map<string, string>();

  constructor(
    private readonly files: FileSet,
    private readonly readConfig: (path: string) => string | undefined,
    private readonly probe: (key: string) => void = () => {},
  ) {}

  /** Where `spec`, imported by repo file `from`, leads; `sysPathEdited` comes from the importing file's parse. */
  resolve(from: string, spec: string, sysPathEdited = false): PythonResolution {
    if (!spec) return { status: 'unknown' };
    if (spec.startsWith('.')) return this.relative(from, spec);
    const top = spec.split('.')[0]!;
    if (STDLIB.has(top)) return { status: 'external' };
    if (sysPathEdited) return { status: 'unknown' };
    return this.absolute(from, spec);
  }

  private index(): { py: Set<string>; dirs: Set<string>; names: Set<string> } {
    if (!this.pySet) {
      this.py = [...this.files].filter((p) => p.endsWith('.py') || p.endsWith('.pyi'));
      this.pySet = new Set(this.py);
      this.dirs = new Set();
      this.names = new Set();
      for (const path of this.py) {
        const parts = path.split('/');
        const stem = parts.pop()!.replace(/\.pyi?$/, '');
        if (stem !== '__init__') this.names.add(stem);
        for (let i = 1; i <= parts.length; i++) {
          this.dirs.add(parts.slice(0, i).join('/'));
          this.names.add(parts[i - 1]!);
        }
      }
    }
    return { py: this.pySet, dirs: this.dirs!, names: this.names! };
  }

  private has(path: string): boolean {
    return this.files.has(path);
  }

  private isDir(dir: string): boolean {
    this.probe(pyDirKey(dir));
    return this.index().dirs.has(dir);
  }

  /** What `name` is in one directory: a regular package, then a module, then a namespace portion. */
  private entry(dir: string, name: string): Entry | undefined {
    const base = join(dir, name);
    // CPython has no loader for `.pyi` stubs: a stub is never what an import runs.
    if (this.has(`${base}/__init__.py`)) return { kind: 'package', file: `${base}/__init__.py`, dir: base };
    if (this.has(`${base}.py`)) return { kind: 'module', file: `${base}.py` };
    return this.isDir(base) ? { kind: 'namespace', dir: base } : undefined;
  }

  /** One import step across `sys.path` entries: the regular match, or every namespace portion when there is none. */
  private step(entries: readonly string[], name: string): Lookup | { kind: 'package'; file: string; dir: string } {
    const regular = new Map<string, Exclude<Entry, { kind: 'namespace' }>>();
    const portions: string[] = [];
    for (const dir of entries) {
      const found = this.entry(dir, name);
      if (found?.kind === 'namespace') portions.push(found.dir);
      else if (found) regular.set(found.file, found);
    }
    if (regular.size > 1) return { kind: 'ambiguous' };
    const [hit] = regular.values();
    if (hit?.kind === 'package') return { kind: 'package', file: hit.file, dir: hit.dir! };
    if (hit) return { kind: 'file', file: hit.file };
    return portions.length ? { kind: 'namespace', dirs: portions } : undefined;
  }

  /** A dotted module path from `entries`; every part before the last must be a package. */
  private lookup(entries: readonly string[], parts: readonly string[]): Lookup {
    let search = [...entries];
    for (let i = 0; i < parts.length; i++) {
      const found = this.step(search, parts[i]!);
      const last = i === parts.length - 1;
      if (!found || found.kind === 'ambiguous') return found;
      if (found.kind === 'package') {
        if (last) return { kind: 'file', file: found.file };
        search = [found.dir];
      } else if (found.kind === 'namespace') {
        if (last) return found;
        search = found.dirs;
      } else {
        // A module file before the last part: `a.b` with only `a.py` names an attribute, not a module.
        return last ? found : undefined;
      }
    }
    return undefined;
  }

  private toResolution(found: Lookup, otherwise: () => PythonResolution): PythonResolution {
    if (found?.kind === 'file') return { status: 'resolved', resolved: found.file };
    if (found?.kind === 'namespace') return { status: 'unknown', ...(found.dirs.length === 1 && { packageFolder: found.dirs[0]! }) };
    if (found?.kind === 'ambiguous') return { status: 'unknown' };
    return otherwise();
  }

  /** The nearest folder at or above `dir` with a project file; the repo root when there is none. */
  private project(dir: string): string {
    let found = this.projects.get(dir);
    if (found === undefined) {
      found = PROJECT_FILES.some((name) => this.readConfig(join(dir, name)) !== undefined) || !dir ? dir : this.project(dirOf(dir));
      this.projects.set(dir, found);
    }
    return found;
  }

  /** A project's source roots: its `src/` folder when it holds Python files, then the project root. */
  private sources(project: string): string[] {
    const src = join(project, 'src');
    return this.isDir(src) ? [src, project] : [project];
  }

  /**
   * `sys.path` as the importing file is taken to see it: its project's source roots. The folder a file or its package
   * sits in is not assumed: whether it is on `sys.path` depends on how the code is started (as a script, from inside a
   * namespace folder, through an installed package), which the repo does not prove.
   */
  private roots(from: string): string[] {
    const sources = this.sources(this.project(dirOf(from)));
    // Installed, a src layout's package does not see the project root; only code started from the root (tests, scripts) does.
    const src = sources.length > 1 ? sources[0]! : undefined;
    return src !== undefined && from.startsWith(`${src}/`) ? [src] : sources;
  }

  private absolute(from: string, spec: string): PythonResolution {
    const parts = spec.split('.');
    if (parts.some((p) => !p)) return { status: 'unknown' };
    const roots = this.roots(from);
    // CPython installs a regular `test` package (left out of `sys.stdlib_module_names`), which beats a repo namespace folder.
    if (parts[0] === 'test' && this.lookup(roots, ['test'])?.kind === 'namespace') return { status: 'unknown' };
    return this.toResolution(this.lookup(roots, parts), () => this.missing(parts[0]!));
  }

  /**
   * A relative import, as the absolute name it means: the file's package is its folder path below the deepest source
   * root holding it, and each dot after the first climbs one package. That name is then looked up like any absolute
   * one, so a namespace package with portions on several roots stays unknown. A file directly on a root has no
   * package, dots cannot climb above the top-level package, and a file whose own package the import system would find
   * elsewhere never runs under that name.
   */
  private relative(from: string, spec: string): PythonResolution {
    const level = spec.length - spec.replace(/^\.+/, '').length;
    const rest = spec.slice(level).split('.').filter(Boolean);
    const dir = dirOf(from);
    const roots = this.roots(from);
    const root = roots.filter((r) => r !== dir && (r === '' || dir.startsWith(`${r}/`))).sort((a, b) => b.length - a.length)[0];
    if (root === undefined) return { status: 'unknown' };
    const pkg = (root ? dir.slice(root.length + 1) : dir).split('/');
    if (level > pkg.length) return { status: 'unknown' };
    const own = this.lookup(roots, pkg);
    const runsHere = own?.kind === 'file' ? own.file === `${dir}/__init__.py` : own?.kind === 'namespace' && own.dirs.includes(dir);
    // A standard-library module or package of the same name beats a namespace folder. `sys.stdlib_module_names` leaves
    // out the `test` package, but CPython installs it, so a `test/` folder without __init__.py never runs as `test`.
    const top = this.lookup(roots, pkg.slice(0, 1));
    if ((STDLIB.has(pkg[0]!) || pkg[0] === 'test') && top?.kind !== 'file') return { status: 'unknown' };
    if (!runsHere) return { status: 'unknown' };
    return this.toResolution(this.lookup(roots, [...pkg.slice(0, pkg.length - (level - 1)), ...rest]), () => ({ status: 'unknown' }));
  }

  /**
   * A name no `sys.path` entry holds. Found nowhere in the repo, it is a third-party package (site-packages) and so
   * external; a module or folder of that name elsewhere in the repo may be what runs, so that is unknown.
   */
  private missing(top: string): PythonResolution {
    this.probe(pyNameKey(top));
    return this.index().names.has(top) ? { status: 'unknown' } : { status: 'external' };
  }
}

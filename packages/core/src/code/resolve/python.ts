import { dirOf, joinRepo, type FileSet } from './files.js';

/** Where a Python spec leads, before it is attached to an `Import`. */
export interface PythonResolution {
  status: 'resolved' | 'unknown' | 'external';
  resolved?: string;
  /**
   * A folder the spec names, when its name may also be a module in it: `from nspkg import mod` on a namespace package.
   * The import itself stays unknown; the linker uses the folder to resolve `mod`.
   */
  packageFolder?: string;
}

/**
 * The Python standard library. Frozen rather than read from the running runtime, so a resolution does not depend on
 * which machine parses the repo; a repo that pins an older Python still resolves these names as external either way.
 */
export const PYTHON_STDLIB: readonly string[] = [
  '__future__', '__main__', '_thread', 'abc', 'aifc', 'argparse', 'array', 'ast', 'asynchat', 'asyncio', 'asyncore', 'atexit',
  'audioop', 'base64', 'bdb', 'binascii', 'bisect', 'builtins', 'bz2', 'cProfile', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath',
  'cmd', 'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall', 'compression', 'concurrent', 'configparser',
  'contextlib', 'contextvars', 'copy', 'copyreg', 'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm',
  'decimal', 'difflib', 'dis', 'distutils', 'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler',
  'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob',
  'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'imghdr', 'imp', 'importlib',
  'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache', 'locale', 'logging', 'lzma', 'mailbox',
  'mailcap', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder', 'msilib', 'msvcrt', 'multiprocessing', 'netrc', 'nis',
  'nntplib', 'nt', 'numbers', 'operator', 'optparse', 'os', 'ossaudiodev', 'parser', 'pathlib', 'pdb', 'pickle', 'pickletools',
  'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd',
  'py_compile', 'pyclbr', 'pydoc', 'pyexpat', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib', 'resource',
  'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtpd',
  'smtplib', 'sndhdr', 'socket', 'socketserver', 'spwd', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'stringprep',
  'struct', 'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile',
  'termios', 'test', 'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'trace', 'traceback',
  'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv',
  'warnings', 'wave', 'weakref', 'webbrowser', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib',
  'zoneinfo',
];

export const STDLIB = new Set(PYTHON_STDLIB);

/** A requirement's project name, lower-cased, from `flask>=2`, `requests[socks]` or `django (>=4)`. */
function requirementName(line: string): string | undefined {
  const match = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@(]|\s|$)/);
  return match && !line.trimStart().startsWith('-') ? match[1]!.toLowerCase() : undefined;
}

/** Third-party names a project file declares, as `pyproject.toml`, `setup.py`, `Pipfile` and `requirements.txt` write them. */
export function declaredDeps(text: string): string[] {
  const names: string[] = [];
  for (const block of text.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g)) {
    for (const entry of block[1]!.matchAll(/["']([A-Za-z0-9][A-Za-z0-9_.-]*)/g)) names.push(entry[1]!.toLowerCase());
  }
  for (const line of text.split('\n')) {
    const name = requirementName(line);
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

/** Files that mark a folder as a Python project, for the source roots it lays out. */
const PROJECT_FILES = ['pyproject.toml', 'setup.py', 'setup.cfg'];

/** Files a project keeps its dependencies in, at its root. */
const DECLARATION_NAMES = ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'requirements.txt'];

interface Found {
  file?: string;
  /** A folder with Python files but no `__init__.py`: a namespace package, which has no file of its own. */
  packageFolder?: string;
}

/**
 * Python import resolution over one snapshot of the repo's files (COD-44). Only listed files count, so nothing
 * resolves into a virtualenv, `site-packages` or build output.
 *
 * A target depends on where the importing file sits, not on run time: relative imports walk up from its package,
 * absolute imports look along the source roots the repo lays out (`src/`, the package root, the repo root). A file
 * that edits `sys.path` makes its absolute imports unprovable, and the caller says so.
 */
export class PythonResolver {
  private readonly probe: (path: string) => void;
  private py: string[] | undefined;
  private pySet: Set<string> | undefined;
  private topLevel: Set<string> | undefined;
  private readonly deps = new Map<string, Set<string>>();

  constructor(
    private readonly files: FileSet,
    private readonly read: (path: string) => string | undefined,
    probe: (path: string) => void = () => {},
  ) {
    this.probe = probe;
  }

  /** Where `spec`, imported by repo file `from`, leads; `sysPathEdited` comes from the importing file's parse. */
  resolve(from: string, spec: string, sysPathEdited = false): PythonResolution {
    if (!spec) return { status: 'unknown' };
    // Python's relative form is leading dots, not `./`.
    if (spec.startsWith('.')) return this.relative(from, spec);
    if (STDLIB.has(spec.split('.')[0]!)) return { status: 'external' };
    if (sysPathEdited) return { status: 'unknown' };
    return this.absolute(from, spec);
  }

  private python(): string[] {
    if (!this.py) {
      this.py = [...this.files].filter((p) => p.endsWith('.py') || p.endsWith('.pyi')).sort();
      this.pySet = new Set(this.py);
    }
    return this.py;
  }

  /** A path's module: `x.py` before `x.pyi`, `x/__init__.py` with its stub as stand-in, else a namespace folder. */
  private at(path: string): Found | undefined {
    const set = this.pySet ?? new Set(this.python());
    const candidates = [`${path}.py`, `${path}.pyi`, `${path}/__init__.py`, `${path}/__init__.pyi`];
    for (const candidate of candidates) this.probe(candidate);
    const run = candidates[0]!;
    if (set.has(run)) return { file: run };
    const stub = candidates[1]!;
    if (set.has(stub)) return { file: stub };
    const init = candidates[2]!;
    if (set.has(init)) return { file: init };
    const initStub = candidates[3]!;
    if (set.has(initStub)) return { file: initStub };
    // A folder's first Python file is one of the candidates above, so a namespace package needs no folder probe.
    const prefix = `${path}/`;
    return this.py!.some((p) => p.startsWith(prefix)) ? { packageFolder: path } : undefined;
  }

  /** The project a file belongs to: the nearest folder holding its `pyproject.toml`, `setup.py` or `setup.cfg`. */
  private projectRoot(dir: string): string {
    for (let d: string | undefined = dir; d !== undefined; d = d ? dirOf(d) : undefined) {
      if (PROJECT_FILES.some((name) => this.read(d ? `${d}/${name}` : name) !== undefined)) return d;
    }
    return '';
  }

  /**
   * The source roots of one project: its `src/` folder when it has one, else the project root itself. A monorepo's
   * other projects are not on this file's `sys.path`, so their `src/` folders are never searched.
   */
  private sources(project: string): string[] {
    const src = (p: string) => (this.files.has(p ? `${p}/src/__init__.py` : 'src/__init__.py') || this.python().some((file) => file.startsWith(`${p ? `${p}/` : ''}src/`)) ? [p ? `${p}/src` : 'src'] : []);
    return [...src(project), project];
  }

  /**
   * `sys.path` as this file sees it: its own package folder (the topmost package around it, or the folder of a script
   * outside any package), then its project's source roots. A script outside any package keeps its own folder only when
   * the project has no `src/` layout, where a launcher or test runner would put the project's roots instead.
   */
  private roots(from: string): string[] {
    const dir = dirOf(from);
    const own = this.packageRoot(dir);
    const project = this.projectRoot(dir);
    const sources = this.sources(project);
    const out = own === undefined ? [] : [own];
    // A script outside any package: its own folder is a source root only when there is a `src/` layout to prefer.
    if (own === dir && dir && sources.some((r) => r.endsWith('/src') || r === 'src')) out.pop();
    for (const root of sources) if (!out.includes(root)) out.push(root);
    return out;
  }

  private packageRoot(dir: string): string | undefined {
    let top: string | undefined;
    for (let d = dir; ; d = dirOf(d)) {
      if (!this.files.has(d ? `${d}/__init__.py` : '__init__.py')) break;
      top = d;
      if (!d) break;
    }
    // A folder named `src` is the project's source root, and the package under it starts the import path.
    return top === undefined || top === 'src' || top.endsWith('/src') ? dir : top;
  }

  private absolute(from: string, spec: string): PythonResolution {
    const segments = spec.split('.').filter(Boolean);
    if (!segments.length) return { status: 'unknown' };
    const hits = new Set<string>();
    let namespacePackage: string | undefined;
    for (const root of this.roots(from)) {
      const found = this.walk(root, segments);
      if (!found) continue;
      if (found.file) hits.add(found.file);
      else if (found.depth === segments.length) namespacePackage ??= found.packageFolder;
    }
    if (hits.size === 1) return { status: 'resolved', resolved: [...hits][0]! };
    if (hits.size > 1) return { status: 'unknown' };
    if (namespacePackage !== undefined) return { status: 'unknown', packageFolder: namespacePackage };
    return this.missing(segments[0]!, from);
  }

  /** Walks a dotted path under one root. Each step but the last must be a package folder, not a module file. */
  private walk(root: string, segments: string[]): (Found & { depth: number }) | undefined {
    let base = root;
    for (let i = 0; i < segments.length; i++) {
      const path = joinRepo(base, segments[i]!);
      if (path === undefined) return undefined;
      const found = this.at(path);
      if (!found) return undefined;
      const last = i === segments.length - 1;
      if (found.file) {
        // A package's `__init__` is a folder on the way; a module file mid-path makes the rest an attribute.
        const init = found.file === `${path}/__init__.py` || found.file === `${path}/__init__.pyi`;
        if (init && !last) {
          base = path;
          continue;
        }
        return { file: found.file, depth: i + 1 };
      }
      // The last segment may name a namespace package: a folder with Python files but no `__init__.py`.
      if (last) return { packageFolder: found.packageFolder, depth: i + 1 };
      base = found.packageFolder!;
    }
    return undefined;
  }

  /** A relative import: one dot is the file's package, each further dot one package up. */
  private relative(from: string, spec: string): PythonResolution {
    const level = spec.match(/^\.+/)![0].length;
    const rest = spec.replace(/^\.+/, '');
    let base = dirOf(from);
    for (let i = 1; i < level; i++) base = dirOf(base);
    if (!base && level > 1) return { status: 'unknown' };
    if (!rest) {
      const init = base ? `${base}/__init__.py` : undefined;
      if (init && this.files.has(init)) return { status: 'resolved', resolved: init };
      const stub = base ? `${base}/__init__.pyi` : undefined;
      if (stub && this.files.has(stub)) return { status: 'resolved', resolved: stub };
      return { status: 'unknown' };
    }
    const segments = rest.split('.').filter(Boolean);
    const found = this.walk(base, segments);
    if (found?.file) return { status: 'resolved', resolved: found.file };
    if (found?.packageFolder !== undefined && found.depth === segments.length) return { status: 'unknown', packageFolder: found.packageFolder };
    return { status: 'unknown' };
  }

  /**
   * A spec that matches no module. A declared dependency is external; anything else is unknown, because a name that is
   * absent from the repo may live in a virtualenv, a built package or a folder only `sys.path` at run time reaches.
   */
  private missing(top: string, from: string): PythonResolution {
    if (this.declared(from).has(top.toLowerCase())) return { status: 'external' };
    return { status: 'unknown' };
  }

  /**
   * Third-party packages the project declares. Its declaration files are not code, so they are not in the listing: they
   * are read from the project folder a file belongs to, which is where Python tooling looks for them too.
   */
  private declared(from: string): Set<string> {
    const project = this.projectRoot(dirOf(from));
    let deps = this.deps.get(project);
    if (!deps) {
      deps = new Set();
      for (const name of DECLARATION_NAMES) {
        const path = project ? `${project}/${name}` : name;
        this.probe(path);
        const text = this.read(path);
        if (text !== undefined) for (const dep of declaredDeps(text)) deps.add(dep);
      }
      this.deps.set(project, deps);
    }
    return deps;
  }

}

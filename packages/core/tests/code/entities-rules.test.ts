import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';

const parse = async (path: string, text: string) => (await parseCode(path, text))!;
const outline = (parsed: ParsedFile) => parsed.entities.map((e) => `${e.path.join(' > ')} ${e.kind} ${e.range.start.line}-${e.range.end.line}`);
const candidates = (parsed: ParsedFile) => parsed.refs.map((r) => [r.spec, r.candidate]);

/** A root package.json with one script `s`; the refs as [spec, candidate]. */
const script = async (command: string) => candidates(await parse('package.json', JSON.stringify({ scripts: { s: command } })));

/** A workflow job on Ubuntu that checks the repo out, then runs `run`. */
const workflow = (run: string, extra = '') =>
  `jobs:\n  j:\n    runs-on: ubuntu-latest\n${extra}    steps:\n      - uses: actions/checkout@v4\n      - run: ${run}\n`;
const workflowRefs = async (text: string, path = '.github/workflows/w.yml') => candidates(await parse(path, text));

describe('commands in scripts and run steps', () => {
  it('splits on separators only outside quotes', async () => {
    expect(await script('echo "a; ./scripts/x.sh && ./y.sh"')).toEqual([]);
    expect(await script("echo 'a | ./x.sh'")).toEqual([]);
    expect(await script('echo ./x.sh')).toEqual([]);
  });

  it.each([
    ['true || ./a.sh', [['./a.sh', 'a.sh']]],
    ['cat f | ./b.sh', [['./b.sh', 'b.sh']]],
    ['./c.sh &', [['./c.sh', 'c.sh']]],
    ['./d.sh; ./e.sh', [['./d.sh', 'd.sh'], ['./e.sh', 'e.sh']]],
    ['./f.sh&&./g.sh', [['./f.sh', 'f.sh'], ['./g.sh', 'g.sh']]],
    ['scripts/x.sh --flag', [['scripts/x.sh', 'scripts/x.sh']]],
    ['/opt/x.sh', [['/opt/x.sh', undefined]]],
    ['~/x.sh', [['~/x.sh', undefined]]],
    ['./$NAME.sh', [['./$NAME.sh', undefined]]],
    ['FOO=1 BAR=2 node a.js', [['a.js', 'a.js']]],
    ['env FOO=1 node a.js', [['a.js', 'a.js']]],
    ['npx tsx a.ts', [['a.ts', 'a.ts']]],
  ])('reads `%s`', async (command, expected) => {
    expect(await script(command)).toEqual(expected);
  });

  it.each([
    ['bash a.sh', 'a.sh'],
    ['sh a.sh', 'a.sh'],
    ['zsh a.sh', 'a.sh'],
    ['bash -e -o pipefail a.sh', 'a.sh'],
    ['bash -x a.sh', 'a.sh'],
    ['python a.py', 'a.py'],
    ['python3 a.py', 'a.py'],
    ['python -u t.py', 't.py'],
    ['python -W ignore t.py', 't.py'],
    ['node a.js', 'a.js'],
    ['node --inspect a.js', 'a.js'],
    ['node --require ./setup.js scripts/a.js', 'scripts/a.js'],
    ['node -r ./setup.js a.js', 'a.js'],
    ['node --import=./r.js a.js', 'a.js'],
    ['node -- a.js', 'a.js'],
    ['tsx a.ts', 'a.ts'],
    ['tsx watch src/a.ts', 'src/a.ts'],
    ['ts-node a.ts', 'a.ts'],
    ['source ./a.sh', 'a.sh'],
    ['. ./a.sh', 'a.sh'],
  ])('reads the file `%s` runs', async (command, file) => {
    const spec = command.split(' ').at(-1)!;
    expect(await script(command)).toEqual([[spec, file]]);
  });

  it.each(['bash -c "./x.sh"', 'python -m pkg', 'python -c "print(1)"', 'node -e "1"', 'node -p "1"', 'node', 'ts-node -e "1"'])('reads no file from `%s`', async (command) => {
    expect(await script(command)).toEqual([]);
  });

  it('leaves `source` of a bare name unfixed: bash searches PATH first', async () => {
    expect(await script('source lib.sh')).toEqual([['lib.sh', undefined]]);
  });

  it('places a JSON-escaped path on its real characters', async () => {
    const text = JSON.stringify({ scripts: { s: 'bash "scripts/x.sh"' } });
    const parsed = await parse('package.json', text);
    expect(candidates(parsed)).toEqual([['scripts/x.sh', 'scripts/x.sh']]);
    const at = text.indexOf('scripts/x.sh');
    expect(parsed.refs[0]!.range).toEqual({ start: { line: 1, column: at }, end: { line: 1, column: at + 'scripts/x.sh'.length } });
  });
});

describe('package.json scripts', () => {
  it('reads only the top-level scripts object', async () => {
    const parsed = await parse('package.json', '{"config": {"scripts": {"x": "./a.sh"}}}');
    expect([parsed.entities, parsed.refs]).toEqual([[], []]);
    expect((await parse('package.json', '[{"scripts": {"x": "./a.sh"}}]')).entities).toEqual([]);
  });

  it('keeps the last of a repeated key, as JSON.parse does', async () => {
    const parsed = await parse('package.json', '{\n"scripts": {\n"b": "./one.sh",\n"b": "./two.sh"\n}\n}');
    expect(outline(parsed)).toEqual(['b script 4-4']);
    expect(candidates(parsed)).toEqual([['./two.sh', 'two.sh']]);
    const twice = await parse('package.json', '{\n"scripts": {"a": "./one.sh"},\n"scripts": {"b": "./two.sh"}\n}');
    expect(outline(twice)).toEqual(['b script 3-3']);
  });
});

describe('workflow folders and shells', () => {
  it('runs from the workflow default, the job default, then the step folder', async () => {
    const wf = 'defaults:\n  run:\n    working-directory: app\n' + workflow('python tools/check.py');
    expect(await workflowRefs(wf)).toEqual([['tools/check.py', 'app/tools/check.py']]);
    const job = 'defaults:\n  run:\n    working-directory: app\n' + workflow('./x.sh', '    defaults:\n      run:\n        working-directory: scripts\n');
    expect(await workflowRefs(job)).toEqual([['./x.sh', 'scripts/x.sh']]);
    const step = workflow('./x.sh\n        working-directory: tools', '    defaults:\n      run:\n        working-directory: scripts\n');
    expect(await workflowRefs(step)).toEqual([['./x.sh', 'tools/x.sh']]);
  });

  it('normalises the folder', async () => {
    expect(await workflowRefs(workflow('./x.sh\n        working-directory: ./app/'))).toEqual([['./x.sh', 'app/x.sh']]);
    expect(await workflowRefs(workflow('./x.sh\n        working-directory: scripts/../app'))).toEqual([['./x.sh', 'app/x.sh']]);
    expect(await workflowRefs(workflow('./x.sh\n        working-directory: /tmp'))).toEqual([['./x.sh', undefined]]);
  });

  it('reads only bash and sh, from the step, job or workflow shell', async () => {
    expect(await workflowRefs(workflow('./x.sh', '    defaults:\n      run:\n        shell: pwsh\n'))).toEqual([]);
    expect(await workflowRefs('defaults:\n  run:\n    shell: pwsh\n' + workflow('./x.sh'))).toEqual([]);
    expect(await workflowRefs(workflow('./x.sh\n        shell: bash', '    defaults:\n      run:\n        shell: pwsh\n'))).toEqual([['./x.sh', 'x.sh']]);
    expect(await workflowRefs(workflow('./x.sh\n        shell: sh'))).toEqual([['./x.sh', 'x.sh']]);
    expect(await workflowRefs(workflow('./x.sh\n        shell: bash --noprofile --norc -eo pipefail {0}'))).toEqual([['./x.sh', 'x.sh']]);
    expect(await workflowRefs(workflow('./x.sh\n        shell: python'))).toEqual([]);
  });

  it('reads no default shell on Windows runners, and no fixed path when the runner is an expression', async () => {
    const on = (runner: string) => workflow('./x.sh').replace('ubuntu-latest', runner);
    expect(await workflowRefs(on('windows-latest'))).toEqual([]);
    expect(await workflowRefs(on('[self-hosted, windows]'))).toEqual([]);
    expect(await workflowRefs(on('${{ matrix.os }}'))).toEqual([['./x.sh', undefined]]);
    expect(await workflowRefs(on('macos-14'))).toEqual([['./x.sh', 'x.sh']]);
  });

  it('fixes the folder only after a checkout of this repo, into its path', async () => {
    const steps = (list: string) => `jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${list}`;
    expect(await workflowRefs(steps('      - run: ./x.sh\n'))).toEqual([['./x.sh', undefined]]);
    expect(await workflowRefs(steps('      - run: ./x.sh\n      - uses: actions/checkout@v4\n'))).toEqual([['./x.sh', undefined]]);
    // `path` puts the repo in $GITHUB_WORKSPACE/src: the workspace root is outside it.
    expect(await workflowRefs(steps('      - uses: actions/checkout@v4\n        with:\n          path: src\n      - run: ./x.sh\n'))).toEqual([['./x.sh', undefined]]);
    const inRepo = steps('      - uses: actions/checkout@v4\n        with:\n          path: src\n      - run: ./x.sh\n        working-directory: src/tools\n');
    expect(await workflowRefs(inRepo)).toEqual([['./x.sh', 'tools/x.sh']]);
    expect(await workflowRefs(steps('      - uses: actions/checkout@v4\n        with:\n          repository: other/repo\n      - run: ./x.sh\n'))).toEqual([['./x.sh', undefined]]);
  });

  it('reads workflows only directly in the root .github/workflows', async () => {
    for (const path of ['.github/workflows/sub/x.yml', 'pkg/.github/workflows/ci.yml']) {
      const parsed = await parse(path, workflow('./x.sh'));
      expect([parsed.entities, parsed.refs]).toEqual([[], []]);
    }
  });
});

describe('workflow YAML forms', () => {
  it('folds a > scalar into one command', async () => {
    expect(await workflowRefs(workflow('>\n          ./a.sh\n          ./b.sh'))).toEqual([['./a.sh', 'a.sh']]);
  });

  it('joins a backslash line continuation', async () => {
    expect(await workflowRefs(workflow('|\n          ./a.sh \\\n            ./b.sh\n          ./c.sh'))).toEqual([['./a.sh', 'a.sh'], ['./c.sh', 'c.sh']]);
  });

  it('skips comments and quoted words', async () => {
    expect(await workflowRefs(workflow('|\n          # ./a.sh\n          echo "./b.sh" # ./c.sh'))).toEqual([]);
  });

  it('reads CRLF text with the same lines and columns', async () => {
    const lf = await parse('.github/workflows/w.yml', workflow('|\n          npm ci\n          ./a.sh'));
    const crlf = await parse('.github/workflows/w.yml', workflow('|\n          npm ci\n          ./a.sh').replace(/\n/g, '\r\n'));
    expect(crlf.refs.map((r) => [r.spec, r.candidate, r.range])).toEqual(lf.refs.map((r) => [r.spec, r.candidate, r.range]));
    expect(lf.refs[0]!.range).toEqual({ start: { line: 8, column: 10 }, end: { line: 8, column: 16 } });
  });

  it('reads flow style, quoted keys and a quoted run', async () => {
    const flow = 'jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps: [{uses: actions/checkout@v4}, {run: ./x.sh}]\n';
    expect(await workflowRefs(flow)).toEqual([['./x.sh', 'x.sh']]);
    expect(outline(await parse('.github/workflows/w.yml', flow))).toEqual(['j job 2-4', 'j > actions/checkout@v4 step 4-4', 'j > #2 step 4-4']);
    const quoted = '"jobs":\n  \'j\':\n    "runs-on": ubuntu-latest\n    "steps":\n      - "uses": actions/checkout@v4\n      - "run": \'./x.sh\'\n';
    expect(await workflowRefs(quoted)).toEqual([['./x.sh', 'x.sh']]);
  });

  it('leaves a path with an expression unfixed', async () => {
    expect(await workflowRefs(workflow('./${{ matrix.x }}.sh'))).toEqual([['./${{ matrix.x }}.sh', undefined]]);
  });

  it('numbers repeated step names', async () => {
    const text = 'jobs:\n  j:\n    steps:\n      - name: go\n        run: echo\n      - name: go\n        run: echo\n';
    expect((await parse('.github/workflows/w.yml', text)).entities.map((e) => e.id)).toEqual([
      '.github/workflows/w.yml::j::job',
      '.github/workflows/w.yml::j.go::step',
      '.github/workflows/w.yml::j.go::step~2',
    ]);
  });
});

describe('HTML references', () => {
  const html = async (body: string) => candidates(await parse('web/page.html', body));

  it('has no fixed folder once <base href> moves it', async () => {
    expect(await html('<base href="/x/">\n<script src="a.js"></script>')).toEqual([['a.js', undefined]]);
  });

  it('skips comments, other tags and empty values', async () => {
    expect(await html('<!-- <script src="a.js"></script> -->\n<a href="x.html">x</a>\n<img src="i.png">\n<link href="">')).toEqual([]);
  });

  it('reads tag and attribute names in any case, and unquoted values', async () => {
    expect(await html('<SCRIPT SRC=app.js></SCRIPT>\n<Link HREF=s.css>')).toEqual([['app.js', 'web/app.js'], ['s.css', 'web/s.css']]);
  });

  it('reads the path as a browser does: no fragment or query, percent-decoded, backslashes as slashes', async () => {
    expect(await html('<script src="app.js#x"></script><script src="b.js?x#y"></script>')).toEqual([['app.js#x', 'web/app.js'], ['b.js?x#y', 'web/b.js']]);
    expect(await html('<script src="my%20file.js"></script><script src="bad%zz.js"></script>')).toEqual([['my%20file.js', 'web/my file.js'], ['bad%zz.js', undefined]]);
    expect(await html('<script src="js\\a.js"></script>')).toEqual([['js\\a.js', 'web/js/a.js']]);
  });

  it('fixes no path for other schemes or template syntax', async () => {
    expect(await html('<link href="mailto:a@b.c"><link href="data:text/css,a{}"><script src="{{ static }}/a.js"></script>')).toEqual([
      ['mailto:a@b.c', undefined],
      ['data:text/css,a{}', undefined],
      ['{{ static }}/a.js', undefined],
    ]);
  });
});

describe('CSS references', () => {
  const css = async (text: string) => candidates(await parse('web/s.css', text));

  it('reads unquoted url() and import conditions, not comments or other urls', async () => {
    expect(await css('/* @import "x.css"; */\n@import url(base.css);\n@import url("a.css") layer(x) supports(display: grid);\nbody { background: url(i.png); }')).toEqual([
      ['base.css', 'web/base.css'],
      ['a.css', 'web/a.css'],
    ]);
  });

  it('reads @import after @charset, but not after a style rule: browsers ignore it there', async () => {
    expect(await css('@charset "utf-8";\n@import "a.css";\nbody {}\n@import "b.css";')).toEqual([['a.css', 'web/a.css']]);
  });
});

describe('Bash folder variables and functions', () => {
  const sourced = async (text: string) => candidates(await parse('bin/run.sh', text));

  it('trusts only one plain top-level assignment made before the use', async () => {
    expect(await sourced('D="$(dirname "$0")"\nsource "${D}/a.sh"\n')).toEqual([['${D}/a.sh', 'bin/a.sh']]);
    expect(await sourced('source "$D/a.sh"\nD="$(dirname "$0")"\n')).toEqual([['$D/a.sh', undefined]]);
  });

  it.each([
    ['export', 'export D="$(dirname "$0")"\nsource "$D/a.sh"\n'],
    ['readonly', 'readonly D="$(dirname "$0")"\nsource "$D/a.sh"\n'],
    ['local in a function', 'f() { local D="$(dirname "$0")"; }\nsource "$D/a.sh"\n'],
    ['inside a function only', 'f() { D="$(dirname "$0")"; }\nf\nsource "$D/a.sh"\n'],
    ['appended', 'D="$(dirname "$0")"\nD+=/sub\nsource "$D/a.sh"\n'],
    ['read', 'D="$(dirname "$0")"\nread D\nsource "$D/a.sh"\n'],
    ['for', 'D="$(dirname "$0")"\nfor D in a b; do :; done\nsource "$D/a.sh"\n'],
    ['a command prefix', 'D="$(dirname "$0")" true\nsource "$D/a.sh"\n'],
  ])('does not trust a folder variable set by %s', async (_, text) => {
    expect(await sourced(text)).toEqual([['$D/a.sh', undefined]]);
  });

  it('names nested functions by their path, and reads .bash files', async () => {
    const parsed = await parse('bin/run.bash', 'outer() {\n  inner() { source "${BASH_SOURCE%/*}/x.sh"; }\n}\n');
    expect(parsed.symbols.map((s) => s.id)).toEqual(['bin/run.bash::outer::function', 'bin/run.bash::outer.inner::function']);
    expect(parsed.refs.map((r) => [r.candidate, r.from])).toEqual([['bin/x.sh', 'bin/run.bash::outer.inner::function']]);
  });
});

describe('SQL names', () => {
  it('reads backtick and double-quoted, schema-qualified names', async () => {
    const parsed = await parse('a.sql', 'CREATE TABLE `t1` (a int);\nCREATE TABLE "s"."t2" (a int);\n');
    expect(parsed.entities.map((e) => e.path)).toEqual([['t1'], ['s', 't2']]);
  });
});

describe('the committed SQL grammar', () => {
  it('is the build of scripts/build-sql-grammar.sh', () => {
    const wasm = readFileSync(join(import.meta.dirname, '..', '..', 'grammars', 'tree-sitter-sql.wasm'));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe('3c7acad1cda9d565e6884e1d058a5b141c7b6b2983a3b2e4fb0f2ea2efe36ad8');
  });
});

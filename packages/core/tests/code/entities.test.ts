import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeEntitySchema, codeRefSchema, codeSymbolSchema } from '../../src/code/model.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'code', 'entities');
const fixture = (path: string) => readFileSync(join(FIXTURE, path), 'utf8');
const parse = async (path: string, text = fixture(path), lastGood?: ParsedFile) => (await parseCode(path, text, lastGood))!;
const outline = (parsed: ParsedFile) => parsed.entities.map((e) => `${e.path.join(' > ')} ${e.kind} ${e.range.start.line}-${e.range.end.line}`);
/** What a reference says before the link pass: spec, kind, the repo path it names (if fixed), line, the entity or symbol it sits in. */
const stated = (parsed: ParsedFile) => parsed.refs.map((r) => [r.spec, r.kind, r.candidate, r.range.start.line, r.from]);

describe('SQL entities', () => {
  it('reads each CREATE TABLE as a table, schema-qualified and quoted names included', async () => {
    const parsed = await parse('db/schema.sql');
    // The commented-out CREATE TABLE, the view and the string literal are not tables.
    expect(outline(parsed)).toEqual(['users table 2-5', 'public > orders table 7-10', 'Tmp Cache table 12-12']);
    expect(parsed.entities.map((e) => e.id)).toEqual(['db/schema.sql::users::table', 'db/schema.sql::public.orders::table', 'db/schema.sql::Tmp Cache::table']);
    expect(parsed.file.lang).toBe('sql');
    expect(parsed.refs).toEqual([]);
    for (const e of parsed.entities) codeEntitySchema.parse(e);
  });

  it('keeps an identity when lines above it change', async () => {
    const before = await parse('db/schema.sql');
    const after = await parse('db/schema.sql', `-- header\n\n${fixture('db/schema.sql')}`);
    expect(after.entities.map((e) => e.id)).toEqual(before.entities.map((e) => e.id));
    expect(after.entities[0]!.range.start.line).toBe(4);
  });

  it('numbers a repeated table in source order', async () => {
    const parsed = await parse('a.sql', 'CREATE TABLE t (a int);\nCREATE TABLE t (b int);\n');
    expect(parsed.entities.map((e) => e.id)).toEqual(['a.sql::t::table', 'a.sql::t::table~2']);
  });
});

describe('GitHub Actions workflow entities', () => {
  it('reads jobs and steps, a step named by its id, name, action, else its position', async () => {
    expect(outline(await parse('.github/workflows/ci.yml'))).toEqual([
      'test job 4-16',
      'test > actions/checkout@v4 step 7-7',
      'test > Run tests step 8-11',
      'test > #3 step 12-13',
      'test > Windows only step 14-16',
      'deploy job 17-31',
      'deploy > actions/checkout@v4 step 23-23',
      'deploy > ship step 24-25',
      'deploy > #3 step 26-26',
      'deploy > Matrix dir step 27-29',
      'deploy > Escape step 30-31',
    ]);
  });

  it('references the files a run command runs, from the folder the step runs in', async () => {
    const step = (path: string) => `.github/workflows/ci.yml::${path}::step`;
    expect(stated(await parse('.github/workflows/ci.yml'))).toEqual([
      ['./scripts/test.sh', 'run', 'scripts/test.sh', 11, step('test.Run tests')],
      ['scripts/lint.sh', 'run', 'scripts/lint.sh', 11, step('test.Run tests')],
      ['tools/check.py', 'run', 'app/tools/check.py', 12, step('test.#3')],
      // `shell: pwsh` is not a shell we read; the job default working directory applies below.
      ['./deploy.sh', 'run', 'scripts/deploy.sh', 25, step('deploy.ship')],
      ['./missing.sh', 'run', 'scripts/missing.sh', 26, step('deploy.#3')],
      // An expression decides the folder: no fixed path.
      ['./deploy.sh', 'run', undefined, 29, step('deploy.Matrix dir')],
      // Leaves the repo: no repo path.
      ['../../../etc/passwd', 'run', undefined, 31, step('deploy.Escape')],
    ]);
  });

  it('places a reference on its own line inside a block scalar', async () => {
    const ref = (await parse('.github/workflows/ci.yml')).refs[1]!;
    expect(ref.range).toEqual({ start: { line: 11, column: 43 }, end: { line: 11, column: 58 } });
  });

  it('reads no workflow outside .github/workflows', async () => {
    const parsed = await parse('config/app.yml');
    expect([parsed.entities, parsed.refs]).toEqual([[], []]);
  });

  it('reads a workflow saved as .yaml too', async () => {
    const parsed = await parse('.github/workflows/x.yaml', 'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./go.sh\n');
    expect(outline(parsed)).toEqual(['build job 2-5', 'build > actions/checkout@v4 step 4-4', 'build > #2 step 5-5']);
    expect(stated(parsed)).toEqual([['./go.sh', 'run', 'go.sh', 5, '.github/workflows/x.yaml::build.#2::step']]);
  });
});

describe('docker-compose entities', () => {
  it('reads each service', async () => {
    const parsed = await parse('docker-compose.yml');
    expect(outline(parsed)).toEqual(['api service 2-5', 'db service 6-7']);
    expect(parsed.refs).toEqual([]);
  });

  it('knows compose files by their names only', async () => {
    const text = 'services:\n  web:\n    image: nginx\n';
    for (const path of ['compose.yaml', 'deploy/docker-compose.prod.yml', 'compose.override.yml']) {
      expect(outline(await parse(path, text))).toEqual(['web service 2-3']);
    }
    expect(outline(await parse('config/app.yml'))).toEqual([]);
  });
});

describe('package.json entities', () => {
  it('reads each script and references the files it runs, from the package folder', async () => {
    const parsed = await parse('package.json');
    expect(outline(parsed)).toEqual(['build script 5-5', 'test script 6-6', 'deploy script 7-7', 'lint script 8-8']);
    expect(stated(parsed)).toEqual([
      ['scripts/build.js', 'run', 'scripts/build.js', 5, 'package.json::build::script'],
      ['./scripts/deploy.sh', 'run', 'scripts/deploy.sh', 7, 'package.json::deploy::script'],
      ['scripts/lint.sh', 'run', 'scripts/lint.sh', 8, 'package.json::lint::script'],
    ]);
  });

  it('resolves a nested package script from its own folder', async () => {
    expect(stated(await parse('packages/web/package.json'))).toEqual([
      ['src/gen.ts', 'run', 'packages/web/src/gen.ts', 4, 'packages/web/package.json::gen::script'],
    ]);
  });

  it('reads no scripts from other JSON files', async () => {
    const parsed = await parse('config/settings.json');
    expect([parsed.entities, parsed.refs]).toEqual([[], []]);
  });
});

describe('HTML and CSS references', () => {
  it('references script src and link href, relative to the page', async () => {
    expect(stated(await parse('web/index.html'))).toEqual([
      ['style.css', 'link', 'web/style.css', 4, undefined],
      ['../shared/reset.css?v=1', 'link', 'shared/reset.css', 5, undefined],
      ['app.js', 'script', 'web/app.js', 6, undefined],
      ['https://cdn.example.com/lib.js', 'script', undefined, 7, undefined],
      // A root-relative path depends on the web server's root, which the repo does not say.
      ['/abs.js', 'script', undefined, 8, undefined],
      ['missing.js', 'script', 'web/missing.js', 9, undefined],
    ]);
  });

  it('references @import, quoted or url(), relative to the stylesheet', async () => {
    const parsed = await parse('web/style.css');
    expect(stated(parsed)).toEqual([
      ['base.css', 'import', 'web/base.css', 1, undefined],
      ['https://fonts.example.com/f.css', 'import', undefined, 2, undefined],
      ['./missing.css', 'import', 'web/missing.css', 3, undefined],
    ]);
    expect(parsed.entities).toEqual([]);
  });
});

describe('Bash', () => {
  it('reads functions as symbols', async () => {
    const symbols = [...(await parse('scripts/deploy.sh')).symbols, ...(await parse('scripts/lib.sh')).symbols];
    expect(symbols.map((s) => `${s.id} ${s.range.start.line}-${s.range.end.line}`)).toEqual([
      'scripts/deploy.sh::deploy::function 8-10',
      'scripts/lib.sh::log::function 1-1',
      'scripts/lib.sh::retry::function 3-5',
    ]);
    for (const s of symbols) codeSymbolSchema.parse(s);
  });

  it("resolves source only from the script's own folder, written with dirname or BASH_SOURCE", async () => {
    expect(stated(await parse('scripts/deploy.sh'))).toEqual([
      ['$(dirname "$0")/lib.sh', 'source', 'scripts/lib.sh', 4, undefined],
      ['$SCRIPT_DIR/util.sh', 'source', 'scripts/util.sh', 5, undefined],
      // Relative to wherever the script is run from: no fixed path.
      ['./lib.sh', 'source', undefined, 6, undefined],
    ]);
  });

  it('knows the other ways to write the script folder', async () => {
    const text = [
      '. "${BASH_SOURCE%/*}/a.sh"',
      'source "$(dirname "${BASH_SOURCE[0]}")/b.sh"',
      'source "${0%/*}/c.sh"',
      'source "$(cd "$(dirname "$0")" && pwd)/d.sh"',
      'source "$HOME/e.sh"',
      'source "$(dirname "$0")/$NAME.sh"',
      'f() { source "${BASH_SOURCE%/*}/g.sh"; }',
      '',
    ].join('\n');
    expect(stated(await parse('bin/run.sh', text))).toEqual([
      ['${BASH_SOURCE%/*}/a.sh', 'source', 'bin/a.sh', 1, undefined],
      ['$(dirname "${BASH_SOURCE[0]}")/b.sh', 'source', 'bin/b.sh', 2, undefined],
      ['${0%/*}/c.sh', 'source', 'bin/c.sh', 3, undefined],
      ['$(cd "$(dirname "$0")" && pwd)/d.sh', 'source', 'bin/d.sh', 4, undefined],
      ['$HOME/e.sh', 'source', undefined, 5, undefined],
      ['$(dirname "$0")/$NAME.sh', 'source', undefined, 6, undefined],
      ['${BASH_SOURCE%/*}/g.sh', 'source', 'bin/g.sh', 7, 'bin/run.sh::f::function'],
    ]);
  });

  it('does not trust a folder variable assigned twice', async () => {
    const text = 'DIR="$(dirname "$0")"\nDIR=/opt\nsource "$DIR/a.sh"\n';
    expect(stated(await parse('bin/run.sh', text))).toEqual([['$DIR/a.sh', 'source', undefined, 3, undefined]]);
  });
});

describe('references and entities on every fixture file', () => {
  it('match their schemas', async () => {
    for (const path of ['.github/workflows/ci.yml', 'docker-compose.yml', 'package.json', 'web/index.html', 'web/style.css', 'scripts/deploy.sh', 'db/schema.sql']) {
      const parsed = await parse(path);
      for (const e of parsed.entities) codeEntitySchema.parse(e);
      for (const r of parsed.refs) codeRefSchema.parse(r);
      expect(parsed.refs.every((r) => r.file === path && r.status === 'unknown' && r.resolved === undefined)).toBe(true);
    }
  });
});

describe('entities and references on broken text (Live map #11)', () => {
  it('keeps the last good table a syntax error hides, and makes none from broken text', async () => {
    const good = await parse('db/schema.sql');
    // `CREATE TABL` no longer reads as a table: the users table comes from the last good parse.
    const text = fixture('db/schema.sql').replace('CREATE TABLE users (', 'CREATE TABL users (');
    const broken = await parse('db/schema.sql', `${text}\nCREATE TABLE added ( (;\n`, good);
    expect(broken.parseErrors.length).toBeGreaterThan(0);
    expect(broken.entities.map((e) => e.id).sort()).toEqual(good.entities.map((e) => e.id).sort());
    expect(broken.kept).toEqual(['db/schema.sql::users::table']);
  });

  it('keeps a reference hidden by a syntax error while the text still names it', async () => {
    const good = await parse('web/style.css');
    const broken = await parse('web/style.css', fixture('web/style.css').replace('@import "base.css";', '@import "base.css" {{;'), good);
    expect(broken.parseErrors.length).toBeGreaterThan(0);
    expect(stated(broken)[0]).toEqual(['base.css', 'import', 'web/base.css', 1, undefined]);
  });

  it('keeps a hidden reference even when another one with the same spec still parses', async () => {
    const text = '@import "a.css";\n@import "a.css";\n';
    const good = await parse('web/s.css', text);
    const broken = await parse('web/s.css', text.replace('@import "a.css";\n@import', '@import "a.css";\n@import {{'), good);
    expect(broken.parseErrors.length).toBeGreaterThan(0);
    expect(broken.refs.map((r) => [r.spec, r.range.start.line])).toEqual([
      ['a.css', 1],
      ['a.css', 2],
    ]);
  });

  it('keeps a hidden reference written with escapes, by its spelling in the source', async () => {
    const css = '@import "a\\.css";\n';
    const goodCss = await parse('web/s.css', css);
    expect(goodCss.refs.map((r) => [r.spec, r.written])).toEqual([['a.css', 'a\\.css']]);
    const brokenCss = await parse('web/s.css', css.replace('";', '" {{;'), goodCss);
    expect(brokenCss.parseErrors.length).toBeGreaterThan(0);
    expect(brokenCss.refs.map((r) => r.spec)).toEqual(['a.css']);

    const html = '<script src="a&amp;b.js"></script>\n';
    const goodHtml = await parse('web/p.html', html);
    expect(goodHtml.refs.map((r) => [r.spec, r.written])).toEqual([['a&b.js', 'a&amp;b.js']]);
    const brokenHtml = await parse('web/p.html', html.replace('<script src', '<script <<src'), goodHtml);
    expect(brokenHtml.parseErrors.length).toBeGreaterThan(0);
    expect(brokenHtml.refs.map((r) => r.spec)).toEqual(['a&b.js']);
  });

  it('records no separate spelling when the spec is written as is', async () => {
    expect((await parse('web/style.css')).refs.every((r) => r.written === undefined)).toBe(true);
  });

  it('drops a reference that was deleted, not hidden', async () => {
    const good = await parse('web/style.css');
    const broken = await parse('web/style.css', fixture('web/style.css').replace('@import "base.css";\n', '').replace(':root {', ':root {{'), good);
    expect(broken.parseErrors.length).toBeGreaterThan(0);
    expect(broken.refs.map((r) => r.spec)).not.toContain('base.css');
  });

  it('keeps a job, a script and a function the broken text hides', async () => {
    const yml = await parse('.github/workflows/ci.yml');
    const ymlBroken = await parse('.github/workflows/ci.yml', fixture('.github/workflows/ci.yml').replace('  test:\n', '  test: [\n'), yml);
    expect(ymlBroken.parseErrors.length).toBeGreaterThan(0);
    expect(ymlBroken.entities.map((e) => e.id).sort()).toEqual(yml.entities.map((e) => e.id).sort());
    const pkg = await parse('package.json');
    const pkgBroken = await parse('package.json', fixture('package.json').replace('"test": "vitest run",', '"test": "vitest run",,'), pkg);
    expect(pkgBroken.parseErrors.length).toBeGreaterThan(0);
    expect(pkgBroken.entities.map((e) => e.id).sort()).toEqual(pkg.entities.map((e) => e.id).sort());
    const sh = await parse('scripts/lib.sh');
    const shBroken = await parse('scripts/lib.sh', fixture('scripts/lib.sh').replace('log() { echo "$@"; }', 'log() { echo "$@";'), sh);
    expect(shBroken.parseErrors.length).toBeGreaterThan(0);
    expect(shBroken.symbols.map((s) => s.id).sort()).toEqual(sh.symbols.map((s) => s.id).sort());
  });
});

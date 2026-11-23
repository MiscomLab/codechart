import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCodeIndex, type CodeIndex } from '../../src/code/code-index.js';
import type { CodeRef } from '../../src/code/model.js';
import type { ParsedFile } from '../../src/code/parse.js';
import { parseRepo } from '../../src/code/repo.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'code', 'entities');
let repo: string;

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

const outcomes = (parsed: ParsedFile | undefined) => (parsed?.refs ?? []).map((r) => [r.spec, r.status, r.resolved]);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'codechart-entities-'));
  cpSync(FIXTURE, repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('references resolved on the entities fixture', () => {
  let files: ParsedFile[];
  const fileOf = (path: string) => files.find((f) => f.file.path === path);

  beforeEach(async () => {
    files = await parseRepo(repo);
  });

  it('resolves workflow run commands to repo files, else unknown', () => {
    expect(outcomes(fileOf('.github/workflows/ci.yml'))).toEqual([
      ['./scripts/test.sh', 'resolved', 'scripts/test.sh'],
      ['scripts/lint.sh', 'resolved', 'scripts/lint.sh'],
      ['tools/check.py', 'resolved', 'app/tools/check.py'],
      ['./deploy.sh', 'resolved', 'scripts/deploy.sh'],
      ['./missing.sh', 'unknown', undefined],
      ['./deploy.sh', 'unknown', undefined],
      ['../../../etc/passwd', 'unknown', undefined],
    ]);
  });

  it('resolves package.json scripts, HTML, CSS and Bash references', () => {
    expect(outcomes(fileOf('package.json'))).toEqual([
      ['scripts/build.js', 'resolved', 'scripts/build.js'],
      ['./scripts/deploy.sh', 'resolved', 'scripts/deploy.sh'],
      ['scripts/lint.sh', 'resolved', 'scripts/lint.sh'],
    ]);
    expect(outcomes(fileOf('packages/web/package.json'))).toEqual([['src/gen.ts', 'resolved', 'packages/web/src/gen.ts']]);
    expect(outcomes(fileOf('web/index.html'))).toEqual([
      ['style.css', 'resolved', 'web/style.css'],
      ['../shared/reset.css?v=1', 'resolved', 'shared/reset.css'],
      ['app.js', 'resolved', 'web/app.js'],
      ['https://cdn.example.com/lib.js', 'external', undefined],
      ['/abs.js', 'unknown', undefined],
      ['missing.js', 'unknown', undefined],
    ]);
    expect(outcomes(fileOf('web/style.css'))).toEqual([
      ['base.css', 'resolved', 'web/base.css'],
      ['https://fonts.example.com/f.css', 'external', undefined],
      ['./missing.css', 'unknown', undefined],
    ]);
    expect(outcomes(fileOf('scripts/deploy.sh'))).toEqual([
      ['$(dirname "$0")/lib.sh', 'resolved', 'scripts/lib.sh'],
      ['$SCRIPT_DIR/util.sh', 'resolved', 'scripts/util.sh'],
      ['./lib.sh', 'unknown', undefined],
    ]);
  });

  it('lists entities for every language of the fixture', () => {
    const kinds = new Set(files.flatMap((f) => f.entities.map((e) => `${f.file.lang} ${e.kind}`)));
    expect([...kinds].sort()).toEqual(['json script', 'sql table', 'yaml job', 'yaml service', 'yaml step']);
  });
});

describe('resolver references', () => {
  const ref = (spec: string, candidate?: string): CodeRef => ({
    file: 'web/index.html',
    spec,
    kind: 'script',
    status: 'unknown',
    ...(candidate !== undefined && { candidate }),
    range: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
  });
  const resolver = createResolver(['web/app.js', 'web/index.html'], () => undefined);

  it('resolves only to a listed file', () => {
    expect(resolver.ref(ref('app.js', 'web/app.js'))).toEqual({ status: 'resolved', resolved: 'web/app.js' });
    expect(resolver.ref(ref('node_modules/x.js', 'web/node_modules/x.js'))).toEqual({ status: 'unknown' });
    expect(resolver.ref(ref('/abs.js'))).toEqual({ status: 'unknown' });
  });

  it('calls a URL external, whatever its scheme', () => {
    for (const spec of ['https://a.example/x.js', 'http://a.example/x.js', '//a.example/x.js']) expect(resolver.ref(ref(spec))).toEqual({ status: 'external' });
    expect(resolver.ref(ref('data:text/javascript,1'))).toEqual({ status: 'unknown' });
  });

  it('reports each path it checks', () => {
    const seen: string[] = [];
    createResolver(['web/app.js'], () => undefined, { path: (p) => seen.push(p) }).ref(ref('missing.js', 'web/missing.js'));
    expect(seen).toEqual(['web/missing.js']);
  });
});

describe('references in the live index', () => {
  let index: CodeIndex;

  beforeEach(async () => {
    index = await openCodeIndex(repo);
  });

  it('resolves a reference once its file appears, and unknowns it when the file goes', async () => {
    write('scripts/missing.sh', 'echo here\n');
    const added = await index.update(['scripts/missing.sh']);
    expect(outcomes(index.file('.github/workflows/ci.yml'))[4]).toEqual(['./missing.sh', 'resolved', 'scripts/missing.sh']);
    expect(added).toEqual({ changed: ['scripts/missing.sh'], parsed: ['scripts/missing.sh'], relinked: ['.github/workflows/ci.yml'], removed: [] });

    rmSync(join(repo, 'web/base.css'));
    const removed = await index.update(['web/base.css']);
    expect(outcomes(index.file('web/style.css'))[0]).toEqual(['base.css', 'unknown', undefined]);
    expect(removed).toEqual({ changed: ['web/base.css'], parsed: [], relinked: ['web/style.css'], removed: ['web/base.css'] });
  });

  it('re-reads entities and references of an edited file', async () => {
    write('web/index.html', '<script src="app.js"></script>\n<link href="gone.css">\n');
    write('db/schema.sql', 'CREATE TABLE only_one (id int);\n');
    const update = await index.update(['web/index.html', 'db/schema.sql']);
    expect(update.parsed).toEqual(['db/schema.sql', 'web/index.html']);
    expect(outcomes(index.file('web/index.html'))).toEqual([
      ['app.js', 'resolved', 'web/app.js'],
      ['gone.css', 'unknown', undefined],
    ]);
    expect(index.file('db/schema.sql')!.entities.map((e) => e.id)).toEqual(['db/schema.sql::only_one::table']);
  });
});

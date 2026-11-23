import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCodeIndex } from '../../src/code/code-index.js';
import { entityGrammarOf, grammarOf, langOf } from '../../src/code/languages.js';
import { codeEntitySchema, codeRefSchema, type CodeRef } from '../../src/code/model.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { listCodeFiles, parseRepo } from '../../src/code/repo.js';

// The fixtures pass `prisma validate` (Prisma 6). The entities and relation fields below are the models, enums, views,
// composite types and model-typed fields Prisma's own DMMF lists for them.
const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'code', 'prisma');
const fixture = (path: string) => readFileSync(join(FIXTURE, path), 'utf8');
const parse = async (path: string, text = fixture(path), lastGood?: ParsedFile) => (await parseCode(path, text, lastGood))!;
const outline = (parsed: ParsedFile) => parsed.entities.map((e) => `${e.path.join(' > ')} ${e.kind} ${e.range.start.line}-${e.range.end.line}`);
/** A relation as stated: the model it sits in, the model its type names, and the field's line. */
const relations = (parsed: ParsedFile) => parsed.refs.map((r) => [r.from, r.spec, r.to, r.range.start.line]);

const BLOG = 'prisma/schema.prisma';
const blog = (name: string, kind = 'model') => `${BLOG}::${name}::${kind}`;

describe('Prisma files', () => {
  it.each(['schema.prisma', 'prisma/schema/user.prisma', 'db/Schema.PRISMA'])('%s is prisma, read for entities', (path) => {
    expect([langOf(path), grammarOf(path), entityGrammarOf(path)]).toEqual(['prisma', undefined, 'prisma']);
  });

  it('skips a file named only .prisma, as other dotfiles', () => {
    expect(langOf('prisma/.prisma')).toBeUndefined();
  });
});

describe('Prisma entities', () => {
  it('reads each model, enum and view with its name and range', async () => {
    const parsed = await parse(BLOG);
    // The commented-out model, the string holding "model Fake", the generator and the datasource are not entities.
    expect(outline(parsed)).toEqual([
      'User model 13-20',
      'Profile model 22-27',
      'Post model 29-39',
      'Category model 41-48',
      'Role enum 50-53',
      'PostCount view 55-58',
    ]);
    expect(parsed.entities.map((e) => e.id)).toEqual([blog('User'), blog('Profile'), blog('Post'), blog('Category'), blog('Role', 'enum'), blog('PostCount', 'view')]);
    expect(parsed.file.lang).toBe('prisma');
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.entities[0]!.range).toEqual({ start: { line: 13, column: 0 }, end: { line: 20, column: 1 } });
    for (const e of parsed.entities) codeEntitySchema.parse(e);
  });

  it('reads composite types as entities of kind type', async () => {
    const parsed = await parse('mongo/schema.prisma');
    expect(outline(parsed)).toEqual(['Address type 10-14', 'Geo type 16-19', 'Customer model 21-25', 'Order model 27-32']);
    expect(parsed.entities[0]!.id).toBe('mongo/schema.prisma::Address::type');
  });

  it('reads each file of a multi-file schema on its own', async () => {
    expect(outline(await parse('multi/prisma/schema/schema.prisma'))).toEqual([]);
    expect(outline(await parse('multi/prisma/schema/user.prisma'))).toEqual(['User model 1-5', 'Status enum 7-10']);
    expect(outline(await parse('multi/prisma/schema/order.prisma'))).toEqual(['Order model 1-7', 'OrderLine model 9-13']);
  });

  it('keeps an identity when lines above it change', async () => {
    const before = await parse(BLOG);
    const after = await parse(BLOG, `// header\n\n${fixture(BLOG)}`);
    expect(after.entities.map((e) => e.id)).toEqual(before.entities.map((e) => e.id));
    expect(after.entities[0]!.range.start.line).toBe(15);
    expect(relations(after)).toEqual(relations(before).map(([from, spec, to, line]) => [from, spec, to, (line as number) + 2]));
  });

  it('reads an empty model, and numbers a repeated name in source order', async () => {
    const parsed = await parse('a.prisma', 'model A {}\nmodel A {\n  id Int @id\n}\n');
    expect(parsed.entities.map((e) => e.id)).toEqual(['a.prisma::A::model', 'a.prisma::A::model~2']);
  });

  it('makes no entity of a type alias, which is not Prisma schema syntax', async () => {
    const parsed = await parse('a.prisma', 'type UUID String @go.type("uuid.UUID")\ntype Numeric = Float\n');
    expect(parsed.entities).toEqual([]);
  });
});

describe('Prisma relations', () => {
  it('references the model each model-typed field names, both sides of a relation and self-relations', async () => {
    const parsed = await parse(BLOG);
    expect(relations(parsed)).toEqual([
      [blog('User'), 'Post', blog('Post'), 17],
      [blog('User'), 'Profile', blog('Profile'), 18],
      [blog('Profile'), 'User', blog('User'), 25],
      [blog('Post'), 'User', blog('User'), 32],
      [blog('Post'), 'Category', blog('Category'), 34],
      [blog('Category'), 'Post', blog('Post'), 44],
      [blog('Category'), 'Category', blog('Category'), 45],
      [blog('Category'), 'Category', blog('Category'), 47],
    ]);
  });

  it('states a relation as a reference to its own file, on the type name', async () => {
    const ref = (await parse(BLOG)).refs[0]!;
    expect(ref).toEqual({
      file: BLOG,
      from: blog('User'),
      spec: 'Post',
      kind: 'relation',
      candidate: BLOG,
      to: blog('Post'),
      status: 'unknown',
      range: { start: { line: 17, column: 10 }, end: { line: 17, column: 14 } },
    } satisfies CodeRef);
    codeRefSchema.parse(ref);
  });

  it('makes no reference for scalars, Unsupported, enums, views or composite types', async () => {
    const mongo = await parse('mongo/schema.prisma');
    expect(relations(mongo)).toEqual([
      ['mongo/schema.prisma::Customer::model', 'Order', 'mongo/schema.prisma::Order::model', 24],
      ['mongo/schema.prisma::Order::model', 'Customer', 'mongo/schema.prisma::Customer::model', 30],
    ]);
    const text = 'model A {\n  id Int @id\n  v  V\n  e  E\n  b  B?\n}\nmodel B {\n  id Int @id\n  a  A\n}\nview V {\n  id Int @unique\n}\nenum E {\n  X\n}\n';
    // A view's fields and a model field typed with a view are not relations between models.
    expect(relations(await parse('a.prisma', text))).toEqual([
      ['a.prisma::A::model', 'B', 'a.prisma::B::model', 5],
      ['a.prisma::B::model', 'A', 'a.prisma::A::model', 9],
    ]);
  });

  it('states a type another file declares as an unknown relation with no file: the file does not prove which schema it is in', async () => {
    const user = 'multi/prisma/schema/user.prisma';
    const order = 'multi/prisma/schema/order.prisma';
    // `Status` is an enum of user.prisma, but order.prisma alone can't tell a model from an enum there.
    expect(relations(await parse(user))).toEqual([[`${user}::User::model`, 'Order', undefined, 3]]);
    expect(relations(await parse(order))).toEqual([
      [`${order}::Order::model`, 'User', undefined, 3],
      [`${order}::Order::model`, 'OrderLine', `${order}::OrderLine::model`, 5],
      [`${order}::Order::model`, 'Status', undefined, 6],
      [`${order}::OrderLine::model`, 'Order', `${order}::Order::model`, 11],
    ]);
    const cross = (await parse(order)).refs[0]!;
    expect(cross).toEqual({ file: order, from: `${order}::Order::model`, spec: 'User', kind: 'relation', status: 'unknown', range: { start: { line: 3, column: 9 }, end: { line: 3, column: 13 } } } satisfies CodeRef);
  });

  it('keeps a relation to another file unknown after the link pass', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'codechart-prisma-'));
    try {
      cpSync(join(FIXTURE, 'multi'), repo, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const order = (await parseRepo(repo)).find((f) => f.file.path === 'prisma/schema/order.prisma')!;
      expect(order.refs.map((r) => [r.spec, r.status, r.resolved, r.to])).toEqual([
        ['User', 'unknown', undefined, undefined],
        ['OrderLine', 'resolved', 'prisma/schema/order.prisma', 'prisma/schema/order.prisma::OrderLine::model'],
        ['Status', 'unknown', undefined, undefined],
        ['Order', 'resolved', 'prisma/schema/order.prisma', 'prisma/schema/order.prisma::Order::model'],
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes'].flatMap((s) => [s, `${s}?`, `${s}[]`]))(
    'makes no reference for the scalar field type %s',
    async (type) => {
      const parsed = await parse('a.prisma', `model A {\n  id Int @id\n  f  ${type}\n}\n`);
      expect([parsed.parseErrors, parsed.refs]).toEqual([[], []]);
    },
  );

  it.each(['Unsupported("circle")', 'Unsupported("circle")?', 'Unsupported("circle")[]'])('makes no reference for %s', async (type) => {
    const parsed = await parse('a.prisma', `model A {\n  id Int @id\n  f  ${type}\n}\n`);
    expect([parsed.parseErrors, parsed.refs]).toEqual([[], []]);
  });

  it.each([
    ['an enum', 'enum A {\n  X\n}\n'],
    ['a view', 'view A {\n  id Int @unique\n}\n'],
    ['a composite type', 'type A {\n  x Int\n}\n'],
  ])('makes no reference to a name declared both as a model and as %s', async (_, other) => {
    const parsed = await parse('a.prisma', `model A {\n  id Int @id\n}\n${other}model B {\n  id Int @id\n  a  A\n}\n`);
    expect(parsed.refs).toEqual([]);
  });

  it('reads keyword-named fields and models, trailing comments, CRLF and a multi-line @relation', async () => {
    const text = [
      'model Model {',
      '  id    Int    @id',
      '  type  Type   @relation(',
      '    fields:     [typeA, typeB],',
      '    references: [a, b]',
      '  ) // the kind',
      '  typeA Int',
      '  typeB Int',
      '  view  View[] /// shown in',
      '}',
      'model Type {',
      '  a     Int',
      '  b     Int',
      '  model Model[]',
      '  enum  String',
      '  @@id([a, b])',
      '}',
      'model View {',
      '  id      Int   @id',
      '  modelId Int',
      '  owner   Model @relation(fields: [modelId], references: [id])',
      '}',
      'type Box {',
      '  model Model',
      '}',
      '',
    ].join('\r\n');
    const parsed = await parse('a.prisma', text);
    expect(parsed.parseErrors).toEqual([]);
    expect(outline(parsed)).toEqual(['Model model 1-10', 'Type model 11-17', 'View model 18-22', 'Box type 23-25']);
    expect(parsed.entities[0]!.range).toEqual({ start: { line: 1, column: 0 }, end: { line: 10, column: 1 } });
    // A composite type's field typed with a model is not a relation between models.
    expect(relations(parsed)).toEqual([
      ['a.prisma::Model::model', 'Type', 'a.prisma::Type::model', 3],
      ['a.prisma::Model::model', 'View', 'a.prisma::View::model', 9],
      ['a.prisma::Type::model', 'Model', 'a.prisma::Model::model', 14],
      ['a.prisma::View::model', 'Model', 'a.prisma::Model::model', 21],
    ]);
    expect(parsed.refs[0]!.range).toEqual({ start: { line: 3, column: 8 }, end: { line: 3, column: 12 } });
  });

  it('makes no reference to a name the file declares twice', async () => {
    const parsed = await parse('a.prisma', 'model A {\n  id Int @id\n}\nmodel A {\n  id Int @id\n}\nmodel B {\n  id Int @id\n  a  A\n  b  B?\n}\n');
    expect(relations(parsed)).toEqual([['a.prisma::B::model', 'B', 'a.prisma::B::model', 10]]);
  });
});

describe('Prisma with a syntax error', () => {
  const postBroken = () => fixture(BLOG).replace('model Post {', 'model Post {{');
  const profileBroken = () => fixture(BLOG).replace('model Profile {', 'model Profile');
  /** No reference points from or to an entity the file does not have. */
  const live = (parsed: ParsedFile) => {
    const ids = new Set(parsed.entities.map((e) => e.id));
    expect(parsed.refs.filter((r) => !ids.has(r.from!) || (r.to !== undefined && !ids.has(r.to)))).toEqual([]);
  };
  const intact = [
    [blog('User'), 'Profile', blog('Profile'), 18],
    [blog('Profile'), 'User', blog('User'), 25],
    [blog('Category'), 'Category', blog('Category'), 45],
    [blog('Category'), 'Category', blog('Category'), 47],
  ];

  it('drops a broken model without a last good parse, and every relation from or to it', async () => {
    const parsed = await parse(BLOG, postBroken());
    expect(parsed.parseErrors.length).toBeGreaterThan(0);
    expect(parsed.entities.map((e) => e.id)).toEqual([blog('User'), blog('Profile'), blog('Category'), blog('Role', 'enum'), blog('PostCount', 'view')]);
    // `posts Post[]` names a model the file declares, broken: neither a relation nor an unknown one.
    expect(relations(parsed)).toEqual(intact);
    live(parsed);
  });

  it('keeps a broken model the last good parse had in place, with its relations both ways', async () => {
    const parsed = await parse(BLOG, postBroken(), await parse(BLOG));
    expect(parsed.entities.map((e) => e.id)).toEqual([blog('User'), blog('Profile'), blog('Post'), blog('Category'), blog('Role', 'enum'), blog('PostCount', 'view')]);
    // The grammar still reads `model Post` as a declaration: it updates in place, not as kept.
    expect(parsed.kept).toEqual([]);
    expect(relations(parsed)).toEqual([
      ...intact,
      [blog('User'), 'Post', blog('Post'), 17],
      [blog('Post'), 'User', blog('User'), 32],
      [blog('Post'), 'Category', blog('Category'), 34],
      [blog('Category'), 'Post', blog('Post'), 44],
    ]);
    live(parsed);
  });

  it('keeps a model the broken text swallows, and its relations, once each', async () => {
    const parsed = await parse(BLOG, profileBroken(), await parse(BLOG));
    expect(parsed.entities.map((e) => e.id)).toEqual([blog('User'), blog('Post'), blog('Category'), blog('Role', 'enum'), blog('PostCount', 'view'), blog('Profile')]);
    expect(parsed.kept).toEqual([blog('Profile')]);
    expect(relations(parsed)).toEqual([
      [blog('User'), 'Post', blog('Post'), 17],
      [blog('Post'), 'User', blog('User'), 32],
      [blog('Post'), 'Category', blog('Category'), 34],
      [blog('Category'), 'Post', blog('Post'), 44],
      [blog('Category'), 'Category', blog('Category'), 45],
      [blog('Category'), 'Category', blog('Category'), 47],
      [blog('User'), 'Profile', blog('Profile'), 18],
      [blog('Profile'), 'User', blog('User'), 25],
    ]);
    live(parsed);
  });

  it('makes no unknown relation to a name the broken text still declares', async () => {
    const parsed = await parse(BLOG, profileBroken());
    expect(parsed.entities.map((e) => e.id)).toEqual([blog('User'), blog('Post'), blog('Category'), blog('Role', 'enum'), blog('PostCount', 'view')]);
    expect(relations(parsed)).toEqual([
      [blog('User'), 'Post', blog('Post'), 17],
      [blog('Post'), 'User', blog('User'), 32],
      [blog('Post'), 'Category', blog('Category'), 34],
      [blog('Category'), 'Post', blog('Post'), 44],
      [blog('Category'), 'Category', blog('Category'), 45],
      [blog('Category'), 'Category', blog('Category'), 47],
    ]);
  });

  it('makes no relation to a broken enum', async () => {
    const parsed = await parse(BLOG, fixture(BLOG).replace('enum Role {', 'enum Role {{'));
    expect(parsed.entities.map((e) => e.id)).toEqual([blog('User'), blog('Profile'), blog('Post'), blog('Category'), blog('PostCount', 'view')]);
    expect(relations(parsed)).toEqual(relations(await parse(BLOG)));
  });

  it('makes nothing new from a model typed while the file is broken', async () => {
    const good = await parse('a.prisma', 'model A {\n  id Int @id\n}\n');
    const parsed = await parse('a.prisma', 'model A {\n  id Int @id\n}\nmodel B {\n  id Int @id\n  a  A\n', good);
    expect(parsed.parseErrors.length).toBeGreaterThan(0);
    expect(parsed.entities.map((e) => e.id)).toEqual(['a.prisma::A::model']);
    expect(parsed.refs).toEqual([]);
  });

  it('keeps no relation once its field is gone, and none that points at a missing model', async () => {
    const good = await parse('a.prisma', 'model A {\n  id Int @id\n  b  B?\n}\nmodel B {\n  id Int @id\n  a  A\n}\n');
    // B broken, A's field to B deleted: B.a stays (B is broken, A is there), A.b is gone from the text.
    const parsed = await parse('a.prisma', 'model A {\n  id Int @id\n}\nmodel B {{\n  id Int @id\n  a  A\n}\n', good);
    expect(parsed.entities.map((e) => e.id)).toEqual(['a.prisma::A::model', 'a.prisma::B::model']);
    expect(relations(parsed)).toEqual([['a.prisma::B::model', 'A', 'a.prisma::A::model', 7]]);
    live(parsed);
  });
});

describe('Prisma in a repo', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'codechart-prisma-'));
    cpSync(FIXTURE, repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('lists schema.prisma and every file of a multi-file schema', () => {
    expect(listCodeFiles(repo)).toEqual(['mongo/schema.prisma', 'multi/prisma/schema/order.prisma', 'multi/prisma/schema/schema.prisma', 'multi/prisma/schema/user.prisma', BLOG]);
  });

  it('resolves each relation to its own file in parseRepo and openCodeIndex', async () => {
    for (const files of [await parseRepo(repo), (await openCodeIndex(repo)).files]) {
      const file = files.find((f) => f.file.path === BLOG)!;
      expect(file.refs.map((r) => [r.spec, r.status, r.resolved, r.to])).toEqual(
        relations(await parse(BLOG)).map(([, spec, to]) => [spec, 'resolved', BLOG, to]),
      );
    }
  });

  it('re-reads entities and relations of an edited schema in the live index', async () => {
    const index = await openCodeIndex(repo);
    writeFileSync(join(repo, BLOG), 'model User {\n  id   Int  @id\n  team Team @relation(fields: [teamId], references: [id])\n  teamId Int\n}\nmodel Team {\n  id    Int    @id\n  users User[]\n}\n');
    const update = await index.update([BLOG]);
    expect(update.parsed).toEqual([BLOG]);
    const file = index.file(BLOG)!;
    expect(file.entities.map((e) => e.id)).toEqual([blog('User'), blog('Team')]);
    expect(file.refs.map((r) => [r.from, r.to, r.status])).toEqual([
      [blog('User'), blog('Team'), 'resolved'],
      [blog('Team'), blog('User'), 'resolved'],
    ]);
  });
});

describe('the committed Prisma grammar', () => {
  it('is the build of scripts/build-prisma-grammar.sh', () => {
    const wasm = readFileSync(join(import.meta.dirname, '..', '..', 'grammars', 'tree-sitter-prisma.wasm'));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe('5df064fd975d5b8edaf907042097b7be10099261469564ed260101e5e4f67d90');
  });
});

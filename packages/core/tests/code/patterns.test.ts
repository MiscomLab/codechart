import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { patternGrammarOf, PATTERN_GRAMMARS } from '../../src/code/languages.js';
import type { PatternMatch } from '../../src/code/model.js';
import { parseCode } from '../../src/code/parse.js';
import { checkPattern, compilePatterns, type CodePattern, type PatternSet } from '../../src/code/patterns.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'code', 'patterns');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

/** A range as `[startLine, startColumn, endLine, endColumn]`: 1-based lines, 0-based columns. */
const at = (m: PatternMatch) => [m.range.start.line, m.range.start.column, m.range.end.line, m.range.end.column];

/** The source a range covers: lines 1-based, columns in UTF-16 code units, as JavaScript strings count. */
const slice = (source: string, m: PatternMatch): string => {
  const lines = source.split('\n');
  const offset = (line: number, column: number) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column;
  return source.slice(offset(m.range.start.line, m.range.start.column), offset(m.range.end.line, m.range.end.column));
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const sets: PatternSet[] = [];
const compile = async (patterns: CodePattern[], limits?: Parameters<typeof compilePatterns>[1]) => {
  const set = await compilePatterns(patterns, limits);
  sets.push(set);
  return set;
};
afterAll(() => sets.forEach((s) => s.delete()));

const matchesOf = async (path: string, text: string, patterns: CodePattern[]) => {
  const parsed = await parseCode(path, text, undefined, { patterns: await compile(patterns) });
  return parsed?.matches;
};

// Module-level route calls: app.get('/users', h), not calls inside a function.
const EXPRESS_ROUTES = `
(program
  (expression_statement
    (call_expression
      function: (member_expression
        object: (identifier) @app
        property: (property_identifier) @method)
      arguments: (arguments . (string (string_fragment) @path))) @entity)
  (#any-of? @method "get" "post" "put" "patch" "delete"))
`;

const FASTIFY_ROUTES = `
(program
  (expression_statement
    (call_expression
      function: (member_expression object: (identifier) @app property: (property_identifier) @method)
      arguments: (arguments . (string (string_fragment) @path))) @entity)
  (#eq? @app "fastify")
  (#match? @method "^(get|post|put|patch|delete)$"))
(program
  (expression_statement
    (call_expression
      function: (member_expression object: (identifier) @app property: (property_identifier) @method)
      arguments: (arguments . (object (pair key: (property_identifier) @_key value: (string (string_fragment) @path))))) @entity)
  (#eq? @method "route")
  (#eq? @_key "url"))
`;

// Function and arrow components proven by the JSX they return; the same text works in the tsx and javascript grammars.
const JSX_COMPONENTS = `
(function_declaration
  name: (_) @name
  body: (statement_block
    (return_statement [(jsx_element) (jsx_self_closing_element) (parenthesized_expression [(jsx_element) (jsx_self_closing_element)])]))) @entity
(variable_declarator
  name: (identifier) @name
  value: (arrow_function body: [(jsx_element) (jsx_self_closing_element) (parenthesized_expression [(jsx_element) (jsx_self_closing_element)])])) @entity
`;

// TypeScript's grammar wraps the parent class in an extends_clause; JavaScript's has none.
const TSX_CLASS_COMPONENTS = `
(class_declaration
  name: (type_identifier) @name
  (class_heritage (extends_clause value: (member_expression object: (identifier) @react property: (property_identifier) @base)))
  (#eq? @react "React")
  (#eq? @base "Component")) @entity
(class_declaration
  name: (type_identifier) @name
  (class_heritage (extends_clause value: (identifier) @base))
  (#eq? @base "Component")) @entity
`;

const JS_CLASS_COMPONENTS = `
(class_declaration
  name: (identifier) @name
  (class_heritage (member_expression object: (identifier) @react property: (property_identifier) @base))
  (#eq? @react "React")
  (#eq? @base "Component")) @entity
`;

const TYPEORM_ENTITIES = `
(export_statement
  decorator: (decorator (call_expression function: (identifier) @decorator))
  declaration: (class_declaration name: (type_identifier) @name)
  (#eq? @decorator "Entity")) @entity
(class_declaration
  decorator: (decorator (call_expression function: (identifier) @decorator))
  name: (type_identifier) @name
  (#eq? @decorator "Entity")) @entity
`;

const SQLALCHEMY_MODELS = `
(class_definition
  name: (identifier) @name
  superclasses: (argument_list (identifier) @base)
  (#eq? @base "Base")) @entity
`;

const DJANGO_MODELS = `
(class_definition
  name: (identifier) @name
  superclasses: (argument_list (attribute object: (identifier) @module attribute: (identifier) @base))
  (#eq? @module "models")
  (#eq? @base "Model")) @entity
`;

describe('patterns on real framework code', () => {
  it('Express: module-level route calls with their method and path', async () => {
    const matches = await matchesOf('src/express.js', fixture('express.js'), [{ id: 'express-route', grammar: 'javascript', pattern: EXPRESS_ROUTES }]);
    expect(matches?.map((m) => [m.pattern, at(m), m.captures])).toEqual([
      ['express-route', [9, 0, 9, 28], { app: 'app', method: 'get', path: '/users' }],
      ['express-route', [10, 0, 10, 30], { app: 'app', method: 'post', path: '/users' }],
      ['express-route', [12, 0, 14, 2], { app: 'router', method: 'delete', path: '/users/:id' }],
    ]);
    expect(slice(fixture('express.js'), matches![0]!)).toBe("app.get('/users', listUsers)");
    expect(slice(fixture('express.js'), matches![1]!)).toBe('app.post("/users", createUser)');
  });

  it('Fastify: shorthand routes and fastify.route({ url }), not routes inside a plugin', async () => {
    const matches = await matchesOf('src/server.ts', fixture('fastify.ts'), [{ id: 'fastify-route', grammar: 'typescript', pattern: FASTIFY_ROUTES }]);
    // `@_key` only feeds a predicate: tree-sitter's convention for a capture that isn't output.
    expect(matches?.map((m) => [at(m), m.captures])).toStrictEqual([
      [[6, 0, 6, 34], { app: 'fastify', method: 'get', path: '/users/:id' }],
      [[8, 0, 14, 2], { app: 'fastify', method: 'route', path: '/users' }],
    ]);
  });

  it('React in .tsx: function and arrow components returning JSX, classes extending React.Component or Component', async () => {
    const matches = await matchesOf('src/components.tsx', fixture('components.tsx'), [
      { id: 'jsx-component', grammar: 'tsx', pattern: JSX_COMPONENTS },
      { id: 'class-component', grammar: 'tsx', pattern: TSX_CLASS_COMPONENTS },
    ]);
    expect(matches?.map((m) => [m.pattern, m.captures.name, at(m)])).toEqual([
      ['jsx-component', 'Greeting', [5, 7, 7, 1]],
      ['jsx-component', 'UserList', [9, 13, 15, 1]],
      ['class-component', 'Counter', [17, 7, 22, 1]],
      ['class-component', 'Clock', [24, 7, 28, 1]],
    ]);
    expect(matches?.find((m) => m.captures.name === 'Counter')?.captures).toEqual({ name: 'Counter', react: 'React', base: 'Component' });
  });

  it('React in .jsx: the javascript grammar reads JSX', async () => {
    const matches = await matchesOf('src/Legacy.jsx', fixture('Legacy.jsx'), [
      { id: 'jsx-component', grammar: 'javascript', pattern: JSX_COMPONENTS },
      { id: 'class-component', grammar: 'javascript', pattern: JS_CLASS_COMPONENTS },
    ]);
    expect(matches?.map((m) => [m.pattern, m.captures.name, at(m)])).toEqual([
      ['jsx-component', 'Legacy', [3, 15, 5, 1]],
      ['class-component', 'Panel', [7, 7, 11, 1]],
    ]);
  });

  it('TypeORM: classes decorated with @Entity(), exported or not', async () => {
    const matches = await matchesOf('src/entities.ts', fixture('entities.ts'), [{ id: 'typeorm-entity', grammar: 'typescript', pattern: TYPEORM_ENTITIES }]);
    expect(matches?.map((m) => [m.captures.name, at(m)])).toEqual([
      ['User', [4, 0, 11, 1]],
      ['Order', [13, 0, 20, 1]],
      ['AuditLog', [27, 0, 31, 1]],
    ]);
  });

  it('SQLAlchemy: declarative models on Base, not Base itself or plain classes', async () => {
    const matches = await matchesOf('app/models.py', fixture('models_sqlalchemy.py'), [{ id: 'sqlalchemy-model', grammar: 'python', pattern: SQLALCHEMY_MODELS }]);
    expect(matches?.map((m) => [m.captures.name, at(m)])).toEqual([
      ['User', [9, 0, 14, 62]],
      ['Address', [17, 0, 21, 53]],
    ]);
  });

  it('Django: models.Model subclasses, not forms or the nested Meta', async () => {
    const matches = await matchesOf('blog/models.py', fixture('models_django.py'), [{ id: 'django-model', grammar: 'python', pattern: DJANGO_MODELS }]);
    expect(matches?.map((m) => [m.captures.name, at(m)])).toEqual([
      ['Author', [4, 0, 5, 43]],
      ['Article', [8, 0, 13, 26]],
    ]);
  });

  it('SQL: a pattern runs in a language without imports too', async () => {
    const matches = await matchesOf('db/schema.sql', fixture('schema.sql'), [
      { id: 'sql-table', grammar: 'sql', pattern: '(create_table (object_reference name: (identifier) @name)) @entity' },
    ]);
    expect(matches?.map((m) => [m.captures.name, at(m)])).toEqual([
      ['users', [1, 0, 4, 1]],
      ['orders', [6, 0, 9, 1]],
    ]);
  });

  it('Prisma: the relation fields of each model, with their model and type', async () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'code', 'prisma', 'prisma', 'schema.prisma'), 'utf8');
    const pattern = `
(model_declaration
  (identifier) @model
  (statement_block
    (column_declaration
      (identifier) @field
      (column_type (identifier) @type)
      (attribute (call_expression (identifier) @_attribute))) @entity)
  (#eq? @_attribute "relation"))
`;
    expect(await checkPattern('prisma', pattern)).toEqual({ ok: true });
    const matches = await matchesOf('prisma/schema.prisma', source, [{ id: 'relation', grammar: 'prisma', pattern }]);
    expect(matches?.map((m) => [at(m), m.captures])).toStrictEqual([
      [[25, 2, 25, 80], { model: 'Profile', field: 'user', type: 'User' }],
      [[32, 2, 32, 71], { model: 'Post', field: 'author', type: 'User' }],
      [[45, 2, 45, 77], { model: 'Category', field: 'parent', type: 'Category' }],
      [[47, 2, 47, 39], { model: 'Category', field: 'children', type: 'Category' }],
    ]);
    expect(slice(source, matches![0]!)).toBe('user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)');
  });

  it("runs the docs' example (COD-49) as written", async () => {
    const docs = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'configuration.md'), 'utf8');
    const pattern = /- pattern: \|\n((?: {8}.*\n)+)/.exec(docs)?.[1]?.replace(/^ {8}/gm, '');
    expect(pattern).toContain('#eq? @base "Model"');
    const source = 'class Order(Model):\n    pass\n\nclass Note(Base):\n    pass\n';
    const matches = await matchesOf('app/models.py', source, [{ id: 'docs', grammar: 'python', pattern: pattern! }]);
    expect(matches?.map((m) => [slice(source, m), at(m), m.captures])).toEqual([['class Order(Model):\n    pass', [1, 0, 2, 8], { base: 'Model' }]]);
  });
});

describe('predicates', () => {
  const PY = 'def alpha(): pass\ndef beta(): pass\ndef gamma_x(): pass\n';
  const names = async (predicate: string) =>
    (await matchesOf('m.py', PY, [{ id: 'p', grammar: 'python', pattern: `((function_definition name: (identifier) @name) @entity ${predicate})` }]))?.map((m) => m.captures.name);

  it.each([
    ['(#eq? @name "beta")', ['beta']],
    ['(#not-eq? @name "beta")', ['alpha', 'gamma_x']],
    ['(#match? @name "^g")', ['gamma_x']],
    ['(#not-match? @name "^g")', ['alpha', 'beta']],
    ['(#any-of? @name "alpha" "gamma_x")', ['alpha', 'gamma_x']],
    ['(#not-any-of? @name "alpha" "gamma_x")', ['beta']],
  ])('%s', async (predicate, expected) => {
    expect(await names(predicate)).toEqual(expected);
  });

  it('#eq? compares two captures', async () => {
    const matches = await matchesOf('m.py', 'a = a\nb = c\n', [{ id: 'self', grammar: 'python', pattern: '((assignment left: (identifier) @left right: (identifier) @right) @entity (#eq? @left @right))' }]);
    expect(matches?.map((m) => slice('a = a\nb = c\n', m))).toEqual(['a = a']);
  });

  it('#match? is a JavaScript regular expression, unanchored', async () => {
    expect(await names('(#match? @name "ta")')).toEqual(['beta']);
    expect(await names('(#match? @name "_\\\\w$")')).toEqual(['gamma_x']);
  });

  // A quantified capture passes a plain predicate only when every node does, an any- one when one node does
  // (https://tree-sitter.github.io/tree-sitter/using-parsers/queries/3-predicates-and-directives.html).
  const DECORATED = '@app.route("/a")\n@login_required\ndef a(): pass\n\n@app.route("/b")\n@app.cache\ndef b(): pass\n\n@login_required\ndef c(): pass\n\n@app.route("/d")\n@app.route("/e")\ndef d(): pass\n';
  it.each([
    ['#match? @d "route"', ['d']],
    ['#any-match? @d "route"', ['a', 'b', 'd']],
    ['#not-match? @d "route"', ['c']],
    ['#any-not-match? @d "route"', ['a', 'b', 'c']],
    ['#eq? @d "@login_required"', ['c']],
    ['#any-eq? @d "@login_required"', ['a', 'c']],
    ['#not-eq? @d "@login_required"', ['b', 'd']],
    ['#any-not-eq? @d "@login_required"', ['a', 'b', 'd']],
  ])('on a quantified capture: (%s)', async (predicate, expected) => {
    const pattern = `((decorated_definition (decorator)+ @d definition: (function_definition name: (identifier) @name)) @entity (${predicate}))`;
    expect((await matchesOf('views.py', DECORATED, [{ id: 'view', grammar: 'python', pattern }]))?.map((m) => m.captures.name)).toEqual(expected);
  });
});

describe('match results', () => {
  it('names each capture once, by its first node, and leaves @entity out of captures', async () => {
    const matches = await matchesOf('a.ts', '@A() @B() class X {}\n', [
      { id: 'decorated', grammar: 'typescript', pattern: '(class_declaration (decorator)+ @decorator name: (type_identifier) @name) @entity' },
    ]);
    expect(matches).toStrictEqual([
      { set: 'patterns', pattern: 'decorated', range: { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } }, hash: sha256('@A() @B() class X {}'), captures: { decorator: '@A()', name: 'X' } },
    ]);
  });

  it('leaves out an optional capture that matched nothing, and captures named with a leading _', async () => {
    const matches = await matchesOf('m.py', 'def f(): pass\ndef g() -> int: pass\n', [
      { id: 'f', grammar: 'python', pattern: '((function_definition name: (identifier) @name @_also return_type: (type)? @returns) @entity)' },
    ]);
    expect(matches?.map((m) => m.captures)).toStrictEqual([{ name: 'f' }, { name: 'g', returns: 'int' }]);
  });

  it('maps each pattern of a multi-pattern query to its id, whatever comes before or after', async () => {
    const text = 'x = 1\ndef f(): pass\nclass C: pass\n';
    const multi = { id: 'multi', grammar: 'python', pattern: '(function_definition) @entity\n(class_definition) @entity' } as const;
    const assign = { id: 'assign', grammar: 'python', pattern: '(assignment) @entity' } as const;
    const expected = [
      ['assign', 1],
      ['multi', 2],
      ['multi', 3],
    ];
    expect((await matchesOf('m.py', text, [multi, assign]))?.map((m) => [m.pattern, m.range.start.line])).toEqual(expected);
    expect((await matchesOf('m.py', text, [assign, multi]))?.map((m) => [m.pattern, m.range.start.line])).toEqual(expected);
  });

  it('a pattern ending in a comment does not swallow the next one', async () => {
    const set = await compile([
      { id: 'a', grammar: 'python', pattern: '(function_definition) @entity ; functions' },
      { id: 'c', grammar: 'python', pattern: '(class_definition) @entity' },
    ]);
    expect(set.ids).toEqual(['a', 'c']);
    const parsed = await parseCode('m.py', 'def f(): pass\nclass C: pass\n', undefined, { patterns: set });
    expect(parsed?.matches?.map((m) => m.pattern)).toEqual(['a', 'c']);
  });

  it('gives one result per pattern and @entity node, the first match found', async () => {
    const matches = await matchesOf('a.ts', '@A() @B() class X {}\n', [{ id: 'each-decorator', grammar: 'typescript', pattern: '(class_declaration (decorator) @decorator) @entity' }]);
    expect(matches?.map((m) => [m.pattern, m.captures])).toEqual([['each-decorator', { decorator: '@A()' }]]);
  });

  it('keeps a result per pattern when two patterns capture the same node, in pattern order', async () => {
    const matches = await matchesOf('m.py', 'def f(): pass\n', [
      { id: 'second', grammar: 'python', pattern: '(function_definition) @entity' },
      { id: 'first', grammar: 'python', pattern: '(function_definition name: (identifier) @name) @entity' },
    ]);
    expect(matches?.map((m) => m.pattern)).toEqual(['second', 'first']);
  });

  it('sorts results by position, then by pattern order', async () => {
    const matches = await matchesOf('m.py', 'x = 1\ndef f(): pass\ny = 2\n', [
      { id: 'functions', grammar: 'python', pattern: '(function_definition) @entity' },
      { id: 'assignments', grammar: 'python', pattern: '(assignment) @entity' },
    ]);
    expect(matches?.map((m) => [m.pattern, m.range.start.line])).toEqual([
      ['assignments', 1],
      ['functions', 2],
      ['assignments', 3],
    ]);
  });

  it('a query with several patterns reports each match under the one id', async () => {
    const matches = await matchesOf('m.py', 'def f(): pass\nclass C: pass\n', [{ id: 'both', grammar: 'python', pattern: '(function_definition) @entity\n(class_definition) @entity' }]);
    expect(matches?.map((m) => [m.pattern, m.range.start.line])).toEqual([
      ['both', 1],
      ['both', 2],
    ]);
  });

  it('uses 1-based lines and 0-based columns counted in UTF-16 code units, like the rest of the code layer', async () => {
    const parsed = await parseCode('a.ts', '// é\nconst s = "é"; function f() {}\n', undefined, {
      patterns: await compile([{ id: 'f', grammar: 'typescript', pattern: '(function_declaration name: (identifier) @name) @entity' }]),
    });
    // `const s = "é"; ` is 15 UTF-16 code units (16 UTF-8 bytes).
    expect(parsed?.matches?.map((m) => [at(m), m.hash, m.captures])).toEqual([[[2, 15, 2, 30], sha256('function f() {}'), { name: 'f' }]]);
    expect(parsed?.symbols.map((s) => s.range)).toEqual(parsed?.matches?.map((m) => m.range));
  });
});

describe('match shape', () => {
  it('holds no source text: the range proves it, the hash names its content, the captures carry the names', async () => {
    const source = fixture('models_django.py');
    const matches = await matchesOf('blog/models.py', source, [{ id: 'django-model', grammar: 'python', pattern: DJANGO_MODELS }]);
    expect(matches).toHaveLength(2);
    for (const m of matches!) {
      expect(Object.keys(m).sort()).toEqual(['captures', 'hash', 'pattern', 'range', 'set']);
      expect(m.hash).toBe(sha256(slice(source, m)));
    }
    expect(slice(source, matches![0]!).split('\n')[0]).toBe('class Author(models.Model):');
  });
});

describe('pattern sets', () => {
  const CONSTS = '(lexical_declaration (variable_declarator name: (identifier) @name)) @entity';
  const SLOW = '(_ (_)* @a (_)* @b (_)* @c) @entity';
  const big = Array.from({ length: 4000 }, (_, i) => `const a${i} = [${Array.from({ length: 30 }, (_, j) => j).join(', ')}];`).join('\n');

  it('a slow user set times out without costing the built-in set any match on the same file', async () => {
    const builtin = await compile([{ id: 'consts', grammar: 'typescript', pattern: CONSTS }], { id: 'builtin' });
    const user = await compile([{ id: 'slow', grammar: 'typescript', pattern: SLOW }], { id: 'user', timeoutMs: 20 });
    const parsed = await parseCode('big.ts', big, undefined, { patterns: [builtin, user] });
    expect(parsed?.patternLimits).toStrictEqual({ user: 'timeout' });
    const fromBuiltin = parsed!.matches!.filter((m) => m.set === 'builtin');
    expect(fromBuiltin).toHaveLength(4000);
    expect(fromBuiltin.every((m) => m.pattern === 'consts')).toBe(true);
    expect(parsed!.matches!.filter((m) => m.set === 'user').length).toBeGreaterThan(0);
    expect(parsed!.matches!.every((m) => m.set === 'builtin' || m.set === 'user')).toBe(true);
  });

  it('each set keeps its own time limit', async () => {
    const short = await compile([{ id: 'slow', grammar: 'typescript', pattern: SLOW }], { id: 'short', timeoutMs: 20 });
    const long = await compile([{ id: 'slow', grammar: 'typescript', pattern: SLOW }], { id: 'long', timeoutMs: 300 });
    const parsed = await parseCode('big.ts', big, undefined, { patterns: [short, long] });
    expect(parsed?.patternLimits).toStrictEqual({ short: 'timeout', long: 'timeout' });
    const count = (set: string) => parsed!.matches!.filter((m) => m.set === set).length;
    // The query finds matches at a steady rate: after one per node, raw web-tree-sitter gave about 25 in 20 ms and 195 in 300 ms.
    expect(count('long')).toBeGreaterThan(2 * count('short'));
  });

  it('reports a limit under any set id, __proto__ included (Greptile #101)', async () => {
    const set = await compile([{ id: 'slow', grammar: 'typescript', pattern: SLOW }], { id: '__proto__', timeoutMs: 20 });
    const parsed = await parseCode('big.ts', big, undefined, { patterns: set });
    expect(Object.keys(parsed?.patternLimits ?? {})).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(parsed?.patternLimits, '__proto__')?.value).toBe('timeout');
    expect(parsed?.matches?.[0]?.set).toBe('__proto__');
  });

  it('the same pattern id in two sets gives a match per set, in the order the sets are given', async () => {
    const a = await compile([{ id: 'f', grammar: 'python', pattern: '(function_definition) @entity' }], { id: 'a' });
    const b = await compile([{ id: 'f', grammar: 'python', pattern: '(function_definition name: (identifier) @name) @entity' }], { id: 'b' });
    const parsed = await parseCode('m.py', 'def f(): pass\n', undefined, { patterns: [b, a] });
    expect(parsed?.matches?.map((m) => [m.set, m.pattern, m.captures])).toEqual([
      ['b', 'f', { name: 'f' }],
      ['a', 'f', {}],
    ]);
  });

  it('orders matches at one position by set before pattern', async () => {
    const b = await compile(
      [
        { id: 'x', grammar: 'python', pattern: '(class_definition) @entity' },
        { id: 'f', grammar: 'python', pattern: '(function_definition) @entity' },
      ],
      { id: 'b' },
    );
    const a = await compile([{ id: 'f', grammar: 'python', pattern: '(function_definition) @entity' }], { id: 'a' });
    const parsed = await parseCode('m.py', 'def f(): pass\n', undefined, { patterns: [b, a] });
    expect(parsed?.matches?.map((m) => [m.set, m.pattern])).toEqual([
      ['b', 'f'],
      ['a', 'f'],
    ]);
  });

  it('a file with more matches than a call can take arguments still parses', async () => {
    const set = await compile([{ id: 'name', grammar: 'javascript', pattern: '(identifier) @entity' }], { timeoutMs: 30_000 });
    const parsed = await parseCode('a.js', 'x;\n'.repeat(150_000), undefined, { patterns: set });
    expect(parsed?.matches).toHaveLength(150_000);
  }, 60_000);

  it('a set is named patterns unless given an id, and one set alone or in a list gives the same', async () => {
    const set = await compile([{ id: 'f', grammar: 'python', pattern: '(function_definition) @entity' }]);
    expect(set.id).toBe('patterns');
    const alone = await parseCode('m.py', 'def f(): pass\n', undefined, { patterns: set });
    const listed = await parseCode('m.py', 'def f(): pass\n', undefined, { patterns: [set] });
    expect(alone?.matches).toStrictEqual(listed?.matches);
    expect(alone?.matches?.map((m) => m.set)).toEqual(['patterns']);
  });

  it('refuses two sets with the same id in one parse, and an empty id', async () => {
    const a = await compile([{ id: 'f', grammar: 'python', pattern: '(function_definition) @entity' }], { id: 'same' });
    const b = await compile([{ id: 'g', grammar: 'python', pattern: '(class_definition) @entity' }], { id: 'same' });
    await expect(parseCode('m.py', 'def f(): pass\n', undefined, { patterns: [a, b] })).rejects.toThrow("pattern set id 'same' is given twice");
    await expect(compilePatterns([], { id: '' })).rejects.toThrow('a pattern set id must not be empty');
    await expect(parseCode('m.py', 'def f(): pass\n', undefined, { patterns: [a, a] })).rejects.toThrow("pattern set id 'same' is given twice");
  });

  it('refuses a deleted set in a list', async () => {
    const set = await compilePatterns([{ id: 'f', grammar: 'python', pattern: '(function_definition) @entity' }], { id: 'gone' });
    set.delete();
    await expect(parseCode('m.py', 'def f(): pass\n', undefined, { patterns: [set] })).rejects.toThrow('this pattern set was deleted');
  });

  it('an empty list of sets gives every file an empty list', async () => {
    const parsed = await parseCode('m.py', 'def f(): pass\n', undefined, { patterns: [] });
    expect(parsed?.matches).toEqual([]);
  });
});

describe('grammars', () => {
  it('a pattern grammar is the grammar core parses the file with: tsx for .tsx, javascript for .jsx', () => {
    expect(PATTERN_GRAMMARS).toEqual(['typescript', 'tsx', 'javascript', 'python', 'html', 'css', 'sql', 'bash', 'yaml', 'json', 'prisma']);
    expect(['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.py', 'a.pyi', 'a.html', 'a.htm', 'a.css', 'a.sql', 'a.sh', 'a.bash', 'a.yml', 'a.yaml', 'a.json', 'schema.prisma', 'a.md'].map(patternGrammarOf)).toEqual([
      'typescript',
      'typescript',
      'typescript',
      'tsx',
      'javascript',
      'javascript',
      'javascript',
      'javascript',
      'python',
      'python',
      'html',
      'html',
      'css',
      'sql',
      'bash',
      'bash',
      'yaml',
      'yaml',
      'json',
      'prisma',
      undefined,
    ]);
  });

  it('runs a pattern only on files of its grammar', async () => {
    const set = await compile([
      { id: 'ts', grammar: 'typescript', pattern: '(function_declaration) @entity' },
      { id: 'tsx', grammar: 'tsx', pattern: '(function_declaration) @entity' },
      { id: 'js', grammar: 'javascript', pattern: '(function_declaration) @entity' },
    ]);
    const ids = async (path: string) => (await parseCode(path, 'function f() {}\n', undefined, { patterns: set }))?.matches?.map((m) => m.pattern);
    expect(await ids('a.ts')).toEqual(['ts']);
    expect(await ids('a.tsx')).toEqual(['tsx']);
    expect(await ids('a.jsx')).toEqual(['js']);
    expect(await ids('a.js')).toEqual(['js']);
    expect(await ids('a.py')).toEqual([]);
  });

  it('leaves matches out when no patterns are given, as before', async () => {
    const parsed = await parseCode('a.ts', 'function f() {}\n');
    expect(parsed).toBeDefined();
    expect('matches' in parsed!).toBe(false);
    expect('patternLimits' in parsed!).toBe(false);
  });
});

describe('checkPattern', () => {
  it.each([
    ['javascript', EXPRESS_ROUTES],
    ['typescript', FASTIFY_ROUTES],
    ['tsx', JSX_COMPONENTS],
    ['javascript', JSX_COMPONENTS],
    ['tsx', TSX_CLASS_COMPONENTS],
    ['javascript', JS_CLASS_COMPONENTS],
    ['typescript', TYPEORM_ENTITIES],
    ['python', SQLALCHEMY_MODELS],
    ['python', DJANGO_MODELS],
    ['python', '[(function_definition) @entity (class_definition) @entity]'],
    ['prisma', '(model_declaration (identifier) @name) @entity'],
  ] as const)('accepts a working %s pattern', async (grammar, pattern) => {
    expect(await checkPattern(grammar, pattern)).toEqual({ ok: true });
  });

  it.each([
    ['tsx', '(function_declaration', 'syntax error at line 1, column 22'],
    ['tsx', '(jsx_elemnt) @entity', "unknown node type 'jsx_elemnt' at line 1, column 2"],
    ['typescript', '(jsx_element) @entity', "unknown node type 'jsx_element' at line 1, column 2"],
    // JavaScript's grammar has neither TypeScript's type_identifier nor its extends_clause.
    ['javascript', TSX_CLASS_COMPONENTS, "unknown node type 'type_identifier' at line 3, column 10"],
    ['javascript', '(class_heritage (extends_clause)) @entity', "unknown node type 'extends_clause' at line 1, column 18"],
    ['tsx', '; é\n(jsx_elemnt) @entity', "unknown node type 'jsx_elemnt' at line 2, column 2"],
    ['python', '(class_definition nme: (identifier)) @entity', "unknown field 'nme' at line 1, column 19"],
    ['python', '(identifier (identifier)) @entity', 'impossible pattern at line 1, column 13'],
    ['python', '[(function_definition) @entity (class_definition)]', 'the pattern at line 1 captures @entity optionally or more than once: capture exactly one node as @entity'],
    ['python', '((identifier) @entity (#eq? @other "x"))', "unknown capture '@other' at line 1, column 30"],
    ['python', '(identifier) @name', 'the pattern at line 1 has no @entity capture: capture the node the rule applies to as @entity'],
    ['python', '(identifier) @entity\n(string) @name', 'the pattern at line 2 has no @entity capture: capture the node the rule applies to as @entity'],
    ['python', '(class_definition (identifier)? @entity)', 'the pattern at line 1 captures @entity optionally or more than once: capture exactly one node as @entity'],
    ['python', '(argument_list (identifier)+ @entity)', 'the pattern at line 1 captures @entity optionally or more than once: capture exactly one node as @entity'],
    [
      'python',
      '((identifier) @entity (#contains? @entity "x"))',
      'unsupported predicate #contains? in the pattern at line 1: use #eq?, #not-eq?, #any-eq?, #any-not-eq?, #match?, #not-match?, #any-match?, #any-not-match?, #any-of? or #not-any-of?',
    ],
    [
      'python',
      '((identifier) @entity (#set! kind "table"))',
      'unsupported predicate #set! in the pattern at line 1: use #eq?, #not-eq?, #any-eq?, #any-not-eq?, #match?, #not-match?, #any-match?, #any-not-match?, #any-of? or #not-any-of?',
    ],
    [
      'python',
      '((identifier) @entity (#is? local))',
      'unsupported predicate #is? in the pattern at line 1: use #eq?, #not-eq?, #any-eq?, #any-not-eq?, #match?, #not-match?, #any-match?, #any-not-match?, #any-of? or #not-any-of?',
    ],
    [
      'python',
      '((identifier) @entity (#is-not? local))',
      'unsupported predicate #is-not? in the pattern at line 1: use #eq?, #not-eq?, #any-eq?, #any-not-eq?, #match?, #not-match?, #any-match?, #any-not-match?, #any-of? or #not-any-of?',
    ],
    ['python', '', 'the query has no pattern'],
    ['python', '; only a comment\n', 'the query has no pattern'],
  ] as const)('%s %j: %s', async (grammar, pattern, error) => {
    expect(await checkPattern(grammar, pattern)).toEqual({ ok: false, error });
  });

  it('reports a predicate with the wrong arguments', async () => {
    expect(await checkPattern('python', '((identifier) @entity (#eq? @entity))')).toEqual({ ok: false, error: 'invalid predicate: Wrong number of arguments to `#eq?` predicate. Expected 2, got 1' });
  });

  it('reports a #match? regular expression JavaScript cannot compile', async () => {
    const result = await checkPattern('python', '((identifier) @entity (#match? @entity "("))');
    expect(result.ok).toBe(false);
    // The rest of the message is Node's own, which varies between versions.
    expect(!result.ok && result.error).toMatch(/^invalid #match\? regular expression: Invalid regular expression: \/\(\/.*: Unterminated group$/);
  });

  it('refuses a grammar core does not ship', async () => {
    expect(await checkPattern('rust' as never, '(identifier) @entity')).toEqual({
      ok: false,
      error: "unknown grammar 'rust': use typescript, tsx, javascript, python, html, css, sql, bash, yaml, json or prisma",
    });
  });
});

describe('compilePatterns', () => {
  it('refuses a broken pattern, naming it', async () => {
    await expect(compilePatterns([{ id: 'react', grammar: 'typescript', pattern: '(jsx_element) @entity' }])).rejects.toThrow(
      "pattern 'react' (typescript): unknown node type 'jsx_element' at line 1, column 2",
    );
  });

  it('refuses two patterns with the same id', async () => {
    await expect(
      compilePatterns([
        { id: 'x', grammar: 'python', pattern: '(identifier) @entity' },
        { id: 'x', grammar: 'typescript', pattern: '(identifier) @entity' },
      ]),
    ).rejects.toThrow("pattern id 'x' is used twice");
  });

  it('refuses limits outside what tree-sitter takes', async () => {
    const patterns: CodePattern[] = [{ id: 'x', grammar: 'python', pattern: '(identifier) @entity' }];
    await expect(compilePatterns(patterns, { matchLimit: 0 })).rejects.toThrow('matchLimit must be an integer from 1 to 65536');
    await expect(compilePatterns(patterns, { matchLimit: 65537 })).rejects.toThrow('matchLimit must be an integer from 1 to 65536');
    await expect(compilePatterns(patterns, { timeoutMs: 0 })).rejects.toThrow('timeoutMs must be a positive number');
  });

  it('lists its pattern ids', async () => {
    const set = await compile([
      { id: 'a', grammar: 'python', pattern: '(identifier) @entity' },
      { id: 'b', grammar: 'tsx', pattern: '(identifier) @entity' },
    ]);
    expect(set.ids).toEqual(['a', 'b']);
  });

  it('delete() frees once: a second call is harmless, and parsing with a deleted set throws', async () => {
    const set = await compilePatterns([{ id: 'f', grammar: 'python', pattern: '(function_definition) @entity' }]);
    set.delete();
    set.delete();
    await expect(parseCode('m.py', 'def f(): pass\n', undefined, { patterns: set })).rejects.toThrow('this pattern set was deleted');
    expect((await matchesOf('m.py', 'def f(): pass\n', [{ id: 'f', grammar: 'python', pattern: '(function_definition) @entity' }]))?.map((m) => m.pattern)).toEqual(['f']);
  });

  it('an empty set gives every file an empty list', async () => {
    expect(await matchesOf('a.ts', 'function f() {}\n', [])).toEqual([]);
  });
});

describe('cost bounds', () => {
  // Every node as @entity, each with every combination of its children: grows with the square of each node's child count.
  const PATHOLOGICAL = '(_ (_)* @a (_)* @b (_)* @c) @entity';
  const big = Array.from({ length: 4000 }, (_, i) => `const a${i} = [${Array.from({ length: 30 }, (_, j) => j).join(', ')}];`).join('\n');

  it('stops a pattern that runs past its time limit and marks the file', async () => {
    const set = await compile([{ id: 'slow', grammar: 'typescript', pattern: PATHOLOGICAL }], { timeoutMs: 20 });
    const started = performance.now();
    const parsed = await parseCode('big.ts', big, undefined, { patterns: set });
    const elapsed = performance.now() - started;
    expect(parsed?.patternLimits).toStrictEqual({ patterns: 'timeout' });
    // Uncapped, this query was still running after 30 s on this file (web-tree-sitter 0.27.2, M4 Max).
    expect(elapsed).toBeLessThan(5000);
    // What was found before the cap is kept, and is real code: each match's hash is that of the source at its range.
    expect(parsed!.matches!.length).toBeGreaterThan(0);
    for (const m of parsed!.matches!.slice(0, 50)) expect(m.hash).toBe(sha256(slice(big, m)));
  });

  it('caps a pathological pattern by default; when it also passes the match limit, the timeout is what the file reports', async () => {
    const set = await compile([{ id: 'slow', grammar: 'typescript', pattern: PATHOLOGICAL }]);
    const started = performance.now();
    const parsed = await parseCode('big.ts', big, undefined, { patterns: set });
    expect(parsed?.patternLimits).toStrictEqual({ patterns: 'timeout' });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('a pathological pattern cuts off the other patterns of its grammar on that file, which the mark says', async () => {
    const set = await compile(
      [
        { id: 'consts', grammar: 'typescript', pattern: '(lexical_declaration (variable_declarator name: (identifier) @name)) @entity' },
        { id: 'slow', grammar: 'typescript', pattern: PATHOLOGICAL },
      ],
      { timeoutMs: 20 },
    );
    const parsed = await parseCode('big.ts', big, undefined, { patterns: set });
    expect(parsed?.patternLimits).toStrictEqual({ patterns: 'timeout' });
    const consts = parsed?.matches?.filter((m) => m.pattern === 'consts').length ?? 0;
    expect(consts).toBeGreaterThan(0);
    expect(consts).toBeLessThan(4000);
  });

  it('a cheap pattern on the same file finishes without a mark', async () => {
    const set = await compile([{ id: 'consts', grammar: 'typescript', pattern: '(lexical_declaration (variable_declarator name: (identifier) @name)) @entity' }]);
    const parsed = await parseCode('big.ts', big, undefined, { patterns: set });
    expect(parsed?.matches).toHaveLength(4000);
    expect('patternLimits' in parsed!).toBe(false);
  });

});

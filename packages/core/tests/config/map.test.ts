import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { configJsonSchema, MAP_ENTITY_KINDS, parseConfigFile } from '../../src/config/schema.js';
import { writePinned } from '../../src/config/pinned.js';
import { entityId, symbolId } from '../../src/code/model.js';
import * as core from '../../src/index.js';
import type { MapConfig, MapRule, Pinned, PinnedEntry } from '../../src/index.js';
import { readFileSync } from 'node:fs';
import { makeSandbox, removeSandbox } from '../../../../tests/helpers/sandbox.js';

const parseMap = (map: unknown) => parseConfigFile({ map });
const errorsOf = (map: unknown): string[] => {
  const result = parseMap(map);
  if (result.ok) throw new Error('parsed');
  return result.errors;
};
const rule = (r: object) => ({ rules: [r] });

describe('map: existing configs', () => {
  it('a config without map still parses, and so does an empty file', () => {
    const existing = {
      defaults: { output: 'both', context: 'full', flows: 'auto', terminalMaxNodes: 15 },
      web: { theme: 'dark', minNodes: 8 },
      release: { product: 'Shop', branches: ['release/*'], auto: 'off' },
      ignore: ['generated/**'],
      useBuiltinRules: true,
      rules: [{ name: 'models', paths: ['app/models/**'], output: 'both' }, { name: 'api', when: 'an endpoint changed' }],
    };
    expect(parseConfigFile(existing)).toEqual({ ok: true, config: existing });
    expect(parseConfigFile(null)).toEqual({ ok: true, config: {} });
  });

  it('top-level rules and map.rules are separate: neither takes the other shape', () => {
    expect(parseConfigFile({ rules: [{ paths: ['a/**'], kind: 'table' }] }).ok).toBe(false);
    expect(errorsOf(rule({ name: 'x', paths: ['a/**'] })).join('\n')).toMatch(/map\.rules\[0\]/);
  });
});

describe('map.rules', () => {
  it('accepts globs or a tree-sitter pattern, mapped to a kind, a box or ignore', () => {
    const map = {
      rules: [
        { paths: ['app/models/**'], kind: 'model' },
        { pattern: '(class_definition\n  superclasses: (argument_list (identifier) @base)\n  (#eq? @base "Model")) @entity', lang: 'python', kind: 'table' },
        { paths: ['app/**'], pattern: '(class_definition) @entity', lang: 'python', kind: 'service' },
        { paths: ['legacy/billing/**'], box: 'billing' },
        { paths: ['generated/**'], ignore: true },
      ],
    };
    expect(parseMap(map)).toEqual({ ok: true, config: { map } });
  });

  it('kinds are the map layer entities', () => {
    expect([...MAP_ENTITY_KINDS]).toEqual(['table', 'model', 'service', 'endpoint', 'component', 'config']);
    for (const kind of MAP_ENTITY_KINDS) expect(parseMap(rule({ paths: ['a/**'], kind })).ok).toBe(true);
    expect(errorsOf(rule({ paths: ['a/**'], kind: 'job' })).join('\n')).toMatch(/^map\.rules\[0\]\.kind: .*"table"/m);
  });

  it('needs paths, a pattern or both', () => {
    expect(errorsOf(rule({ kind: 'table' }))).toEqual(['map.rules[0]: set paths, pattern or both']);
  });

  it('needs exactly one of kind, box or ignore', () => {
    const msg = 'map.rules[0]: set exactly one of kind, box or ignore';
    expect(errorsOf(rule({ paths: ['a/**'] }))).toEqual([msg]);
    expect(errorsOf(rule({ paths: ['a/**'], kind: 'table', box: 'billing' }))).toEqual([msg]);
    expect(errorsOf(rule({ paths: ['a/**'], kind: 'table', ignore: true }))).toEqual([msg]);
  });

  it('ignore is only ever true', () => {
    expect(errorsOf(rule({ paths: ['a/**'], ignore: false })).join('\n')).toMatch(/^map\.rules\[0\]\.ignore: /m);
  });

  it('a pattern names its language, and lang goes only with a pattern', () => {
    expect(errorsOf(rule({ pattern: '(class_definition) @entity', kind: 'table' }))).toEqual(['map.rules[0]: a pattern needs lang (its tree-sitter grammar)']);
    expect(errorsOf(rule({ paths: ['a/**'], lang: 'python', kind: 'table' }))).toEqual(['map.rules[0]: lang applies only to a pattern']);
    expect(errorsOf(rule({ pattern: '(x) @entity', lang: 'cobol', kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.lang: /m);
  });

  it('paths use the same glob checks as the other globs', () => {
    expect(errorsOf(rule({ paths: ['src/{a,b}/**'], kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.paths\[0\]: braces and extglobs/m);
    expect(errorsOf(rule({ paths: [], kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.paths: /m);
    expect(errorsOf(rule({ paths: ['a/*********'], kind: 'table' })).join('\n')).toMatch(/at most 8 of \* \?/);
  });

  it('a pattern may span lines but holds no control or invisible characters and stays bounded', () => {
    expect(errorsOf(rule({ pattern: '(x)\u0000', lang: 'python', kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.pattern: /m);
    expect(errorsOf(rule({ pattern: '(x)\u202e', lang: 'python', kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.pattern: /m);
    expect(errorsOf(rule({ pattern: '', lang: 'python', kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.pattern: /m);
    expect(parseMap(rule({ pattern: `(${'x'.repeat(1990)}) @entity`, lang: 'python', kind: 'table' })).ok).toBe(true);
    expect(errorsOf(rule({ pattern: 'x'.repeat(2001), lang: 'python', kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.pattern: /m);
  });

  it('a box is a box id', () => {
    expect(errorsOf(rule({ paths: ['a/**'], box: 'Billing' })).join('\n')).toMatch(/^map\.rules\[0\]\.box: /m);
    // Rule boxes stay flat slugs: a folder box comes from the folder, not from a rule.
    expect(errorsOf(rule({ paths: ['a/**'], box: 'folder:src' })).join('\n')).toMatch(/^map\.rules\[0\]\.box: /m);
    expect(errorsOf(rule({ paths: ['a/**'], box: 'src/payments' })).join('\n')).toMatch(/^map\.rules\[0\]\.box: /m);
  });

  it('unknown keys are errors, with their path', () => {
    expect(errorsOf(rule({ paths: ['a/**'], kind: 'table', name: 'x' })).join('\n')).toMatch(/^map\.rules\[0\]: .*"name"/m);
    expect(errorsOf({ colour: 'red' }).join('\n')).toMatch(/^map: .*"colour"/m);
  });
});

describe('map.guidance', () => {
  it('is plain text and may span lines', () => {
    const guidance = 'Group by business domain, not by technical layer.\n\tKeep payments apart.\nShip it 👨‍👩‍👧';
    expect(parseMap({ guidance })).toEqual({ ok: true, config: { map: { guidance } } });
  });

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(2001)],
    ['a NUL', 'a\u0000b'],
    ['a carriage return', 'a\rb'],
    ['an escape sequence', 'a\u001b[31mb'],
    ['a bidi override', 'a\u202eb'],
    ['a zero-width space', 'a\u200bb'],
    ['a line separator', 'a\u2028b'],
    ['a BOM', 'a\ufeffb'],
  ])('rejects %s', (_, guidance) => {
    expect(errorsOf({ guidance }).join('\n')).toMatch(/^map\.guidance: /m);
  });

  it('accepts exactly 2000 characters', () => {
    expect(parseMap({ guidance: 'x'.repeat(2000) }).ok).toBe(true);
  });
});

describe('map.pinned', () => {
  it('keys are box ids or node ids in the symbolId format', () => {
    const pinned = {
      billing: { name: 'Billing', reason: 'Invoices and payouts, apart from checkout' },
      'checkout-v2': { name: 'Checkout' },
      'src/pay.ts::PaymentService.charge::method': { name: 'Charge a card' },
      'db/schema.sql::public.orders::table': { name: 'Orders' },
      'src/a.ts::handler::function~2': { name: 'Second handler' },
      'app/models.py::Order::model': { name: 'Order' },
      'folder:src/payments': { name: 'Payments' },
      'folder:src': { name: 'Source' },
      'folder:billing': { name: 'Billing folder', reason: 'A folder named like the rule box billing; both can be pinned' },
      'folder:apps/my app/.github-like/x:y': { name: 'Odd but valid folder' },
    };
    expect(parseMap({ pinned })).toEqual({ ok: true, config: { map: { pinned } } });
  });

  it.each([
    ['an uppercase box id', 'Billing'],
    ['a box id with a dot', 'billing.v2'],
    ['a box id starting with a hyphen', '-billing'],
    ['a box id over 64 characters', 'a'.repeat(65)],
    ['a node id with no kind', 'src/a.ts::handler'],
    ['a node id with an empty path', 'src/a.ts::::function'],
    ['a node id with an empty file', '::handler::function'],
    ['a node id with an uppercase kind', 'src/a.ts::handler::Function'],
    ['an absolute file', '/src/a.ts::handler::function'],
    ['a file leaving the repo', '../a.ts::handler::function'],
    ['a file with a .. segment', 'src/../../a.ts::handler::function'],
    ['a Windows path', 'src\\a.ts::handler::function'],
    ['a ~1 suffix', 'src/a.ts::handler::function~1'],
    ['a ~0 suffix', 'src/a.ts::handler::function~0'],
    ['a line break', 'src/a.ts::handler\n::function'],
    ['a bidi override', 'src/a.ts::hand\u202eler::function'],
    ['an unprefixed folder path', 'src/payments'],
    ['an empty folder', 'folder:'],
    ['an absolute folder', 'folder:/src'],
    ['a folder with a trailing slash', 'folder:src/'],
    ['a folder with an empty segment', 'folder:src//a'],
    ['a folder with a . segment', 'folder:./src'],
    ['a folder ending in a . segment', 'folder:src/.'],
    ['a folder with a .. segment', 'folder:src/../x'],
    ['a folder with a backslash', 'folder:src\\a'],
    ['a folder with ::', 'folder:a::b'],
    ['a folder with a line break', 'folder:src\na'],
    ['a folder with a bidi override', 'folder:sr\u202ec'],
    ['an uppercase prefix', 'Folder:src'],
    ['a folder id over 1000 characters', `folder:${'a/'.repeat(497)}abc`],
  ])('rejects %s, naming the id and the formats', (_, id) => {
    const errors = errorsOf({ pinned: { [id]: { name: 'X' } } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^map\.pinned: ".+": .*box id .*node id/);
    expect(errors[0]).not.toMatch(/[\n\u202e]/);
  });

  it('an entry has a one-line name and an optional one-line reason, nothing else', () => {
    const err = (entry: unknown) => errorsOf({ pinned: { billing: entry } }).join('\n');
    expect(err({})).toMatch(/^map\.pinned\.billing\.name: /m);
    expect(err({ name: '' })).toMatch(/^map\.pinned\.billing\.name: /m);
    expect(err({ name: 'x'.repeat(81) })).toMatch(/^map\.pinned\.billing\.name: /m);
    expect(err({ name: 'Bill\ning' })).toMatch(/^map\.pinned\.billing\.name: .*one line/m);
    expect(err({ name: 'Billing', reason: '' })).toMatch(/^map\.pinned\.billing\.reason: /m);
    expect(err({ name: 'Billing', reason: 'x'.repeat(301) })).toMatch(/^map\.pinned\.billing\.reason: /m);
    expect(err({ name: 'Billing', reason: 'a\nb' })).toMatch(/^map\.pinned\.billing\.reason: .*one line/m);
    expect(err({ name: 'Billing', aiName: 'Payments' })).toMatch(/^map\.pinned\.billing: .*"aiName"/m);
    expect(err('Billing')).toMatch(/^map\.pinned\.billing: /m);
    expect(parseMap({ pinned: { billing: { name: 'x'.repeat(80), reason: 'y'.repeat(300) } } }).ok).toBe(true);
  });
});

describe('map in the config schema', () => {
  it('config.schema.json describes map.rules, map.guidance and map.pinned', () => {
    // `map` is an object or null (an emptied `map:`).
    const schema = configJsonSchema() as { properties: { map: { anyOf: { type?: string; properties?: Record<string, unknown> }[] } } };
    const object = schema.properties.map.anyOf.find((s) => s.type === 'object')!;
    expect(schema.properties.map.anyOf.map((s) => s.type).sort()).toEqual(['null', 'object']);
    expect(Object.keys(object.properties!).sort()).toEqual(['guidance', 'pinned', 'rules']);
  });
});

describe('map in .codechart.yaml', () => {
  let tmp: string;
  let home: string;
  let repo: string;
  beforeEach(() => {
    ({ tmp, home, repo } = makeSandbox('map', { git: 'dir', configDir: true }));
  });
  afterEach(() => removeSandbox(tmp));
  const load = () => loadConfig({ cwd: repo, home, env: {} });

  it('a repo file with a map section loads, and its rules stay the agent rules', () => {
    writeFileSync(
      join(repo, '.codechart.yaml'),
      'useBuiltinRules: false\nrules:\n  - name: models\n    paths: ["app/**"]\nmap:\n  rules:\n    - paths: ["app/**"]\n      kind: model\n  guidance: |\n    Group by domain.\n  pinned:\n    billing:\n      name: Billing\n',
    );
    expect(load().rules).toEqual([{ name: 'models', paths: ['app/**'] }]);
  });

  it('an invalid map entry names the file and the entry', () => {
    writeFileSync(join(repo, '.codechart.yaml'), 'map:\n  rules:\n    - paths: ["app/**"]\n');
    expect(load).toThrow(/\.codechart\.yaml: map\.rules\[0\]: set exactly one of kind, box or ignore/);
  });

  it('a pinned id written twice is a YAML error', () => {
    writeFileSync(join(repo, '.codechart.yaml'), 'map:\n  pinned:\n    billing:\n      name: A\n    billing:\n      name: B\n');
    expect(load).toThrow(/\.codechart\.yaml: .*unique/i);
  });
});

describe('writePinned', () => {
  const pins = {
    'src/pay.ts::PaymentService.charge::method': { name: 'Charge a card' },
    billing: { name: 'Billing', reason: 'Invoices and payouts' },
    'app/models.py::Order::model': { name: 'Order' },
  };
  const block = [
    'map:',
    '  pinned:',
    '    app/models.py::Order::model:',
    '      name: Order',
    '    billing:',
    '      name: Billing',
    '      reason: Invoices and payouts',
    '    src/pay.ts::PaymentService.charge::method:',
    '      name: Charge a card',
    '',
  ].join('\n');

  it('writes sorted pins into an empty file', () => {
    expect(writePinned('', pins)).toBe(block);
  });

  it('gives byte-identical output whatever order the pins come in', () => {
    const reversed = Object.fromEntries(Object.entries(pins).reverse());
    const base = '# repo config\nignore: ["generated/**"]\n';
    expect(writePinned(base, reversed)).toBe(writePinned(base, pins));
    const shuffled = '# repo config\nmap:\n  pinned:\n    billing:\n      name: Old\n    a:\n      name: A\n';
    expect(writePinned(shuffled, reversed)).toBe(writePinned(shuffled, pins));
  });

  it('sorts by id in code-unit order', () => {
    const out = writePinned('', { 'b-box': { name: 'B' }, 'a.ts::x::function': { name: 'X' }, 'a-box': { name: 'A' }, 'a/b.ts::y::function': { name: 'Y' } });
    expect(Object.keys((parse(out) as { map: { pinned: object } }).map.pinned)).toEqual(['a-box', 'a.ts::x::function', 'a/b.ts::y::function', 'b-box']);
  });

  it('appends the map section, leaving the rest of the file byte-identical', () => {
    const text = [
      '# yaml-language-server: $schema=https://unpkg.com/codechart/config.schema.json',
      '# my notes',
      'defaults:',
      '    output: both    # four-space indent, kept',
      'rules:',
      '  - name: models',
      "    paths: [\"app/models/**\", 'x/**']   # flow list",
      '    when_note: "a very long string that goes on and on and on and on and on and on and on and on and on and on"',
      'ignore: [generated/**]',
      '',
    ].join('\n');
    expect(writePinned(text, pins)).toBe(text + block);
  });

  it('adds a newline before the section when the file has none at its end', () => {
    expect(writePinned('useBuiltinRules: false', { billing: { name: 'Billing' } })).toBe('useBuiltinRules: false\nmap:\n  pinned:\n    billing:\n      name: Billing\n');
  });

  it('replaces only the pinned block of an existing map, keeping comments and keys around it', () => {
    const text = [
      '# header',
      'map:',
      '    # the guidance',
      '    guidance: |',
      '        Group by domain.',
      '        Not by layer.',
      '    # pins: written by codechart',
      '    pinned:',
      '        zeta:',
      '            name: Zeta',
      '        billing: { name: Old }',
      '    rules:   # after pinned',
      '        - paths: ["gen/**"]',
      '          ignore: true',
      'ignore: ["x/**"]   # trailing',
      '',
    ].join('\n');
    const expected = [
      '# header',
      'map:',
      '    # the guidance',
      '    guidance: |',
      '        Group by domain.',
      '        Not by layer.',
      '    # pins: written by codechart',
      '    pinned:',
      '        billing:',
      '            name: Billing',
      '        checkout:',
      '            name: Checkout',
      '            reason: One flow from cart to receipt',
      '    rules:   # after pinned',
      '        - paths: ["gen/**"]',
      '          ignore: true',
      'ignore: ["x/**"]   # trailing',
      '',
    ].join('\n');
    expect(writePinned(text, { checkout: { name: 'Checkout', reason: 'One flow from cart to receipt' }, billing: { name: 'Billing' } })).toBe(expected);
  });

  it('adds pinned to a map that has none, at its indent', () => {
    const text = 'map:\n  guidance: Group by domain.   # note\nignore: ["x/**"]\n';
    expect(writePinned(text, { billing: { name: 'Billing' } })).toBe('map:\n  guidance: Group by domain.   # note\n  pinned:\n    billing:\n      name: Billing\nignore: ["x/**"]\n');
  });

  it('keeps CRLF line ends', () => {
    const text = '# notes\r\nignore: ["x/**"]\r\n';
    expect(writePinned(text, { billing: { name: 'Billing' } })).toBe('# notes\r\nignore: ["x/**"]\r\nmap:\r\n  pinned:\r\n    billing:\r\n      name: Billing\r\n');
  });

  it('is idempotent', () => {
    const once = writePinned('# notes\nmap:\n  guidance: x\n', pins);
    expect(writePinned(once, pins)).toBe(once);
  });

  it('quotes what YAML would misread, and reads back the same pins', () => {
    const tricky = {
      'src/a b.ts::#x::function': { name: 'yes', reason: '# not a comment: really' },
      'src/c.ts::d::function': { name: '"quoted" and \'single\'', reason: 'null' },
      'e.ts::f::constant': { name: '123' },
      'g.ts::h::type': { name: '- a list? no', reason: 'ünïcödé 👨‍👩‍👧' },
    };
    const out = writePinned('', tricky);
    expect((parse(out) as { map: { pinned: object } }).map.pinned).toEqual(tricky);
    const result = parseConfigFile(parse(out));
    expect(result).toEqual({ ok: true, config: { map: { pinned: tricky } } });
  });

  it('removes the pinned block when there are no pins, and the map when it is then empty', () => {
    expect(writePinned('# notes\nmap:\n  guidance: x\n  pinned:\n    billing:\n      name: B\nignore: []\n', {})).toBe('# notes\nmap:\n  guidance: x\nignore: []\n');
    expect(writePinned('# notes\nmap:\n  pinned:\n    billing:\n      name: B\nignore: []\n', {})).toBe('# notes\nignore: []\n');
    const untouched = '# notes\nignore: []\n';
    expect(writePinned(untouched, {})).toBe(untouched);
  });

  it('writes only names and reasons: anything else in an entry is refused', () => {
    expect(() => writePinned('', { billing: { name: 'Billing', aiName: 'Payments' } as never })).toThrow(/pinned\.billing: .*"aiName"/);
    expect(() => writePinned('', { Billing: { name: 'Billing' } })).toThrow(/pinned: "Billing": .*box id/);
    expect(() => writePinned('', { billing: { name: 'a\nb' } })).toThrow(/pinned\.billing\.name: /);
  });

  it('refuses a file it cannot edit safely', () => {
    expect(() => writePinned('a: [1\n', { billing: { name: 'B' } })).toThrow();
    expect(() => writePinned('- a\n- b\n', { billing: { name: 'B' } })).toThrow(/mapping/);
    expect(() => writePinned('a: 1\n---\nb: 2\n', { billing: { name: 'B' } })).toThrow(/one YAML document/);
  });

  it('rewrites a flow-style or empty map value as a block', () => {
    expect(parse(writePinned('map: { guidance: x }\n', { billing: { name: 'B' } }))).toEqual({ map: { guidance: 'x', pinned: { billing: { name: 'B' } } } });
    expect(parse(writePinned('map:\nignore: []\n', { billing: { name: 'B' } }))).toEqual({ map: { pinned: { billing: { name: 'B' } } }, ignore: [] });
    expect(parse(writePinned('map:\n  pinned: {}\n', { billing: { name: 'B' } }))).toEqual({ map: { pinned: { billing: { name: 'B' } } } });
  });
});

describe('gate: package exports', () => {
  it('exports the writer, the kinds and the types from the package entry', () => {
    expect(core.writePinned).toBe(writePinned);
    expect(core.MAP_ENTITY_KINDS).toBe(MAP_ENTITY_KINDS);
    const r: MapRule = { paths: ['a/**'], kind: 'table' };
    const e: PinnedEntry = { name: 'A' };
    const p: Pinned = { a: e };
    const m: MapConfig = { rules: [r], guidance: 'g', pinned: p };
    expect(core.parseConfigFile({ map: m }).ok).toBe(true);
  });
});

describe('gate: empty map keys parse', () => {
  it.each(['map:\n', 'map: {}\n', 'map:\n  rules: []\n', 'map:\n  pinned: {}\n', 'map:\n  rules:\n  pinned:\n  guidance:\n', 'map:\n  # rules:\n  #   - paths: ["a/**"]\n'])(
    '%j',
    (text) => {
      expect(parseConfigFile(parse(text)).ok).toBe(true);
    },
  );

  it('the CLI template with every map line uncommented loads', () => {
    const template = readFileSync(join(import.meta.dirname, '..', '..', '..', 'cli', 'templates', 'codechart.yaml'), 'utf8');
    const lines = template.split('\n');
    const start = lines.findIndex((l) => l.startsWith('# map:'));
    const end = lines.findIndex((l, i) => i > start && !l.startsWith('# '));
    const map = parse(lines.slice(start, end).map((l) => l.slice(2)).join('\n'));
    expect(parseConfigFile(map).ok).toBe(true);
  });
});

describe('gate: rules', () => {
  it('reports every broken rule constraint', () => {
    expect(errorsOf(rule({}))).toEqual(['map.rules[0]: set paths, pattern or both', 'map.rules[0]: set exactly one of kind, box or ignore']);
    expect(errorsOf(rule({ paths: ['a/**'], pattern: '(x) @entity', kind: 'table' }))).toEqual(['map.rules[0]: a pattern needs lang (its tree-sitter grammar)']);
  });

  it('pattern characters: tabs and line breaks only', () => {
    expect(parseMap(rule({ pattern: '(x\t) @entity', lang: 'python', kind: 'table' })).ok).toBe(true);
    for (const bad of ['\r', '\u200b', '\ufeff', '\u2028']) {
      expect(errorsOf(rule({ pattern: `(x${bad}) @entity`, lang: 'python', kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.pattern: /m);
    }
  });
});

describe('gate: node ids core really makes', () => {
  it.each([
    entityId('.github/workflows/ci.yml', ['test', 'Run tests (node 20)'], 'step'),
    entityId('.github/workflows/ci.yml', ['test', 'Lint: eslint # strict'], 'step'),
    entityId('db/s.sql', ['public', 'my table'], 'table'),
    entityId('ci.yml', ['test', 'a::b'], 'step'),
    symbolId('src/a b.ts', ['x'], 'function'),
    symbolId('src/a.ts', ['handler'], 'function') + '~10',
    'app/models.py::Order::model',
    'a'.repeat(64),
  ])('accepts %j', (id) => {
    expect(parseMap({ pinned: { [id]: { name: 'X' } } }).ok).toBe(true);
  });

  it.each([
    'src/a.ts::handler::function~02',
    'src/a.ts::handler::function~',
    'src/a.ts::handler::function~2~3',
    'src/a.ts::handler::func2',
    'src/a.ts::handler::my-kind',
    'a//b.ts::handler::function',
    './a.ts::handler::function',
    `${'a'.repeat(990)}.ts::handler::function`,
  ])('rejects %j', (id) => {
    expect(errorsOf({ pinned: { [id]: { name: 'X' } } }).join('\n')).toMatch(/^map\.pinned: ".+": .*box id/);
  });
});

describe('gate: the JSON schema stays strict', () => {
  it('map and a pinned entry allow no other keys', () => {
    const json = JSON.stringify(configJsonSchema());
    const schema = configJsonSchema() as { properties: { map: { anyOf?: { additionalProperties?: boolean }[]; additionalProperties?: boolean } } };
    const map = schema.properties.map.anyOf?.find((s) => 'additionalProperties' in s) ?? schema.properties.map;
    expect(map.additionalProperties).toBe(false);
    expect(json).toContain('"name"');
  });
});

describe('gate: loading', () => {
  let tmp: string;
  let home: string;
  let repo: string;
  beforeEach(() => {
    ({ tmp, home, repo } = makeSandbox('map-gate', { git: 'dir', configDir: true }));
  });
  afterEach(() => removeSandbox(tmp));

  it('the loaded config has no map: the CLI does not use it', () => {
    writeFileSync(join(repo, '.codechart.yaml'), 'map:\n  pinned:\n    billing:\n      name: Billing\n');
    expect(loadConfig({ cwd: repo, home, env: {} })).not.toHaveProperty('map');
  });

  it('map is repo-only: a global config with one loads, with a warning that it is ignored', () => {
    const globalPath = join(home, '.config', 'codechart', 'config.yaml');
    writeFileSync(globalPath, 'map:\n  guidance: Group by domain.\n');
    const warnings: string[] = [];
    expect(() => loadConfig({ cwd: repo, home, env: {}, warn: (l) => warnings.push(l) })).not.toThrow();
    expect(warnings).toEqual([`${globalPath}: map is repo-only; ignored`]);
  });

  it('a repo map gives no warning, next to a global one', () => {
    const globalPath = join(home, '.config', 'codechart', 'config.yaml');
    writeFileSync(globalPath, 'map:\n  guidance: g\nweb:\n  keep: 3\n');
    writeFileSync(join(repo, '.codechart.yaml'), 'map:\n  guidance: r\n');
    const warnings: string[] = [];
    const config = loadConfig({ cwd: repo, home, env: {}, warn: (l) => warnings.push(l) });
    expect(warnings).toEqual([`${globalPath}: map is repo-only; ignored`]);
    expect(config.web.keep).toBe(3);
  });

  it('an invalid global map is still an error: the file must be valid config', () => {
    writeFileSync(join(home, '.config', 'codechart', 'config.yaml'), 'map:\n  colour: red\n');
    expect(() => loadConfig({ cwd: repo, home, env: {} })).toThrow(/config\.yaml: map: .*"colour"/);
  });
});

describe('gate: writePinned on real files', () => {
  const B = { billing: { name: 'B' } };
  const blockB = 'map:\n  pinned:\n    billing:\n      name: B\n';

  it('appends to a file of only comments, like the one init writes', () => {
    expect(writePinned('# notes\n# more\n', B)).toBe(`# notes\n# more\n${blockB}`);
    const template = readFileSync(join(import.meta.dirname, '..', '..', '..', 'cli', 'templates', 'codechart.yaml'), 'utf8');
    expect(writePinned(template, B)).toBe(template + blockB);
    expect(() => writePinned('hello\n', B)).toThrow(/mapping/);
  });

  it('keeps blank lines and comments right after the pinned block', () => {
    const text = 'map:\n  pinned:\n    a:\n      name: A\n\n  # rules for generated code\n  rules:\n    - paths: ["gen/**"]\n      ignore: true\n';
    expect(writePinned(text, B)).toBe(text.replace('    a:\n      name: A\n', '    billing:\n      name: B\n'));
    expect(writePinned('map:\n  pinned:\n    a:\n      name: A\n# end of file\n', B)).toBe(`${blockB}# end of file\n`);
    expect(writePinned('map:\n  pinned:\n    a:\n      name: A\n# about ignore\nignore: []\n', B)).toBe(`${blockB}# about ignore\nignore: []\n`);
    expect(writePinned('map:\n  pinned:\n    a:\n      name: A\n    # a note at the end of pinned\nignore: []\n', B)).toBe(`${blockB}    # a note at the end of pinned\nignore: []\n`);
  });

  it('refuses a map that is not a mapping', () => {
    expect(() => writePinned('map: [a]\n', B)).toThrow(/map/);
    expect(() => writePinned('map: text\n', B)).toThrow(/map/);
    expect(() => writePinned('map:\n  pinned: [a]\n', B)).toThrow(/pinned/);
  });

  it('refuses duplicate keys, aliases and merge keys', () => {
    expect(() => writePinned('map:\n  guidance: x\nmap:\n  guidance: y\n', B)).toThrow();
    expect(() => writePinned('map:\n  pinned: {}\n  pinned: {}\n', B)).toThrow();
    expect(() => writePinned('p: &p\n  a:\n    name: A\nmap:\n  pinned: *p\n', B)).toThrow(/alias/);
    expect(() => writePinned('m: &m\n  guidance: x\nmap: *m\n', B)).toThrow(/alias/);
    expect(() => writePinned('base: &b\n  guidance: x\nmap:\n  <<: *b\n', B)).toThrow(/alias/);
  });

  it('document markers: a start marker and directives are fine, an end marker is refused', () => {
    expect(parse(writePinned('---\nignore: []\n', B))).toEqual({ ignore: [], map: { pinned: B } });
    expect(parse(writePinned('%YAML 1.2\n---\na: 1\n', B))).toEqual({ a: 1, map: { pinned: B } });
    expect(() => writePinned('ignore: []\n...\n', B)).toThrow(/one YAML document/);
  });

  it('CRLF when replacing a block, a BOM, and a pinned block at the end without a newline', () => {
    expect(writePinned('map:\r\n  pinned:\r\n    b:\r\n      name: B\r\n  guidance: x\r\n', { a: { name: 'A' } })).toBe('map:\r\n  pinned:\r\n    a:\r\n      name: A\r\n  guidance: x\r\n');
    expect(writePinned('\ufeffignore: []\n', B)).toBe(`\ufeffignore: []\n${blockB}`);
    expect(writePinned('map:\n  pinned:\n    a:\n      name: A', B)).toBe(blockB);
  });

  it('removing the last pin keeps a map that holds comments', () => {
    expect(writePinned('map:\n  # keep me\n  pinned:\n    a:\n      name: A\n', {})).toBe('map:\n  # keep me\n');
    expect(writePinned('map: { pinned: { a: { name: A } } }\n', {})).toBe('');
    expect(writePinned('map:\n  pinned: {}\n', {})).toBe('');
  });

  it('values stay on one line and read back exactly', () => {
    const reason = 'word '.repeat(60).trim();
    const out = writePinned('', { billing: { name: 'B', reason } });
    expect(out.split('\n').filter((l) => l.startsWith('      reason: '))).toHaveLength(1);
    const odd = ['true', '~', '0x10', '2024-01-01', ' Billing', 'a: b', '[x]', 'x #y', '@at', '`tick', '%pct', '!bang', '&amp', '*star', '|pipe', '>gt', '{b}'];
    const pins = Object.fromEntries(odd.map((name, i) => [`box-${String(i).padStart(2, '0')}`, { name, reason: name }]));
    expect((parse(writePinned('', pins)) as { map: { pinned: object } }).map.pinned).toEqual(pins);
  });

  it('sorts by code unit, not locale', () => {
    const out = writePinned('', { 'a.ts::x::function': { name: 'a' }, 'B.ts::x::function': { name: 'B' } });
    expect(Object.keys((parse(out) as { map: { pinned: object } }).map.pinned)).toEqual(['B.ts::x::function', 'a.ts::x::function']);
  });

  it("indents with the map's own step, else 2", () => {
    expect(writePinned('map:\n  pinned:\n      a:\n          name: A\n', B)).toBe(blockB);
    expect(writePinned('defaults:\n    output: both\nmap:\n', B)).toBe(`defaults:\n    output: both\n${blockB}`);
  });

  it('writes pins even when the rest of the map is invalid: it owns only pinned', () => {
    expect(writePinned('map:\n  rules:\n    - paths: ["a/**"]\n', B)).toBe('map:\n  rules:\n    - paths: ["a/**"]\n  pinned:\n    billing:\n      name: B\n');
  });
});

describe('a pattern names what it applies to', () => {
  it('needs an @entity capture', () => {
    expect(errorsOf(rule({ pattern: '(class_definition) @cls', lang: 'python', kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.pattern: .*@entity/m);
    expect(errorsOf(rule({ pattern: '(class_definition) @entityish', lang: 'python', kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.pattern: .*@entity/m);
    expect(parseMap(rule({ pattern: '((class_definition) @entity)', lang: 'python', kind: 'table' })).ok).toBe(true);
  });
});

describe('pinned names read the same in YAML 1.1 tools', () => {
  it('quotes what a YAML 1.1 reader would turn into a boolean, date or number', () => {
    const words = ['yes', 'no', 'on', 'off', 'y', 'n', 'Yes', 'NO', '2024-01-01', '1_000', '0b101', '012', '1:20', '.5', 'null', '~', '<<', '='];
    const pins = Object.fromEntries(words.flatMap((w, i) => [[`box-${String(i).padStart(2, '0')}`, { name: w, reason: w }]]));
    const keyed = Object.fromEntries(['yes', 'on', 'null', 'true'].map((id) => [id, { name: 'x' }]));
    for (const p of [pins, keyed]) {
      const out = writePinned('', p);
      expect((parse(out, { version: '1.1' }) as { map: { pinned: object } }).map.pinned).toEqual(p);
      expect((parse(out) as { map: { pinned: object } }).map.pinned).toEqual(p);
    }
  });
});

describe('gate 2: errors stay one line and comments outside pinned stay', () => {
  it('an invalid id never reaches an error line raw, entry errors included', () => {
    const errors = errorsOf({ pinned: { 'x\ny‮': { name: '', zz: 1 }, 'Bad\nid': { name: 'A', zz: 1 } } });
    expect(errors.join('\n')).toContain('map.pinned: "x\\ny\\u202e": use a rule box id');
    for (const e of errors) expect(e).not.toMatch(/[\n‮]/);
  });

  it('a long invalid id is cut in the error', () => {
    const id = `${'A'.repeat(150)}`;
    const [error] = errorsOf({ pinned: { [id]: { name: 'X' } } });
    expect(error).toBe(`map.pinned: "${'A'.repeat(100)}…": use a rule box id (1-64 lowercase letters, digits or hyphens, not starting with a hyphen), a folder box id (folder: and a repo-relative folder, e.g. folder:src/payments) or a node id (file::path::kind, file repo-relative)`);
  });

  it('a pattern over 2000 characters is too long, @entity or not', () => {
    const pattern = `(${'x'.repeat(1991)}) @entity`;
    expect(pattern).toHaveLength(2001);
    expect(errorsOf(rule({ pattern, lang: 'python', kind: 'table' })).join('\n')).toMatch(/^map\.rules\[0\]\.pattern: Too big/m);
  });

  const B = { billing: { name: 'B' } };
  it('keeps the comment on a `map:` line it rewrites', () => {
    expect(writePinned('map:   # desktop app\nignore: []\n', B)).toBe('map:   # desktop app\n  pinned:\n    billing:\n      name: B\nignore: []\n');
    expect(writePinned('map: { guidance: x }  # keep\nignore: []\n', B)).toBe('map:  # keep\n  guidance: x\n  pinned:\n    billing:\n      name: B\nignore: []\n');
    expect(writePinned('map: { pinned: { a: { name: A } } }  # keep\n', {})).toBe('map:  # keep\n');
    expect(writePinned('map:   # desktop app\n', {})).toBe('map:   # desktop app\n');
  });

  it('a flow pinned that is not a mapping is refused like a block one', () => {
    expect(() => writePinned('map: { pinned: [1] }\n', B)).toThrow(/pinned/);
  });
});

describe('greptile on #98', () => {
  const B = { billing: { name: 'B' } };
  it('adds pins to map: null and map: ~, keeping a comment', () => {
    expect(writePinned('map: null\n', B)).toBe('map:\n  pinned:\n    billing:\n      name: B\n');
    expect(writePinned('map: ~  # c\nignore: []\n', B)).toBe('map:  # c\n  pinned:\n    billing:\n      name: B\nignore: []\n');
  });

  it('unpinning keeps a comment on the map: line', () => {
    expect(writePinned('map: # shared names\n  pinned:\n    a:\n      name: A\nignore: []\n', {})).toBe('map: # shared names\nignore: []\n');
  });

  it('digit-only box ids sort by code unit too', () => {
    const out = writePinned('', { '2': { name: 'Two' }, '10': { name: 'Ten' }, a: { name: 'A' } });
    const order = ['10', '2', 'a'].map((id) => out.search(new RegExp(`^ {4}"?${id}"?:`, 'm')));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect((parse(out) as { map: { pinned: object } }).map.pinned).toEqual({ '2': { name: 'Two' }, '10': { name: 'Ten' }, a: { name: 'A' } });
  });
});

describe('folder box ids', () => {
  it('pins folder boxes, rule boxes and nodes side by side, sorted by code unit', () => {
    const pins = {
      'src/a.ts::x::function': { name: 'X' },
      'folder:src/payments': { name: 'Payments', reason: 'Renamed from the folder name' },
      billing: { name: 'Billing' },
      'folder:src': { name: 'Source' },
    };
    const out = writePinned('', pins);
    expect(out).toBe(
      [
        'map:',
        '  pinned:',
        '    billing:',
        '      name: Billing',
        '    folder:src:',
        '      name: Source',
        '    folder:src/payments:',
        '      name: Payments',
        '      reason: Renamed from the folder name',
        '    src/a.ts::x::function:',
        '      name: X',
        '',
      ].join('\n'),
    );
    expect(parseConfigFile(parse(out))).toEqual({ ok: true, config: { map: { pinned: pins } } });
  });
});

describe('pinnedIdKind', () => {
  it('tells the three id forms apart by syntax alone', () => {
    expect(core.pinnedIdKind('billing')).toBe('rule-box');
    expect(core.pinnedIdKind('folder:billing')).toBe('folder');
    expect(core.pinnedIdKind('folder:src/payments')).toBe('folder');
    expect(core.pinnedIdKind('src/pay.ts::PaymentService.charge::method')).toBe('node');
    expect(core.pinnedIdKind('folder:a.ts::x::function')).toBe('node');
    expect(core.pinnedIdKind('src/payments')).toBeUndefined();
    expect(core.pinnedIdKind('folder:src/')).toBeUndefined();
    expect(core.FOLDER_BOX_PREFIX).toBe('folder:');
  });
});

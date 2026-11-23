import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callRefSchema } from '../../src/code/model.js';
import { parseCode, type ParsedFile } from '../../src/code/parse.js';
import { parseRepo } from '../../src/code/repo.js';
import { linkCode } from '../../src/code/resolve/link.js';
import { createResolver } from '../../src/code/resolve/resolver.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'code', 'ts-calls');
let repo: string;
let files: ParsedFile[];

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'codechart-calls-'));
  cpSync(FIXTURE, repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  files = await parseRepo(repo);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

const fileOf = (path: string): ParsedFile => files.find((f) => f.file.path === path)!;
const outcomes = (parsed: ParsedFile) => parsed.calls.map((c) => [c.name, c.via, c.receiver, c.to, c.evidence]);

/** Parses and links an in-memory repo. */
async function link(tree: Record<string, string>): Promise<ParsedFile[]> {
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter((f): f is ParsedFile => !!f);
  return linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path]));
}

const callsOf = (parsed: ParsedFile, from?: string) => parsed.calls.filter((c) => !from || c.from.endsWith(`::${from}::function`) || c.from.endsWith(`::${from}::method`));

describe('calls on the ts-calls fixture', () => {
  it('resolves imports, barrels, a default export, a namespace import and same-file definitions', () => {
    expect(outcomes(fileOf('src/main.ts'))).toEqual([
      ['charge', 'bare', undefined, 'src/service.ts::charge::function', 'resolved'],
      ['ship', 'bare', undefined, 'src/extra.ts::ship::function', 'resolved'],
      ['settle', 'bare', undefined, 'src/service.ts::settle::function', 'resolved'],
      ['charge', 'member', 'service', 'src/service.ts::charge::function', 'resolved'],
      ['helper', 'bare', undefined, undefined, 'name-only'],
      ['call', 'member', 'charge', undefined, 'name-only'],
    ]);
    expect(outcomes(fileOf('src/unresolved.ts'))).toEqual([['helper', 'bare', undefined, undefined, 'name-only']]);
  });

  it('resolves same-file and this calls, and leaves unknown names name-only', () => {
    const service = fileOf('src/service.ts');
    expect(outcomes(service)).toEqual([
      ['charge', 'bare', undefined, 'src/service.ts::charge::function', 'resolved'],
      ['refund', 'this', undefined, 'src/service.ts::PaymentService.refund::method', 'resolved'],
      ['unknown', 'bare', undefined, undefined, 'name-only'],
      ['charge', 'bare', undefined, 'src/service.ts::charge::function', 'resolved'],
    ]);
    expect(callsOf(service, 'PaymentService.run')[1]).toMatchObject({ from: 'src/service.ts::PaymentService.run::method', range: { start: { line: 12 } } });
  });

  it('keeps every call valid against the schema and records the innermost caller', () => {
    for (const parsed of files) for (const call of parsed.calls) callRefSchema.parse(call);
    const first = callsOf(fileOf('src/main.ts'), 'run')[0]!;
    expect(first).toMatchObject({ from: 'src/main.ts::run::function', range: { start: { line: 7, column: 2 } } });
  });

  it('resolves the same calls after the missing file appears', async () => {
    write('src/missing.ts', 'export function helper(): void {}\n');
    const after = await parseRepo(repo);
    const byPath = new Map(after.map((f) => [f.file.path, f]));
    expect(callsOf(byPath.get('src/main.ts')!, 'run').find((c) => c.name === 'helper')).toMatchObject({ to: 'src/missing.ts::helper::function', evidence: 'resolved' });
    expect(callsOf(byPath.get('src/unresolved.ts')!, 'callHelper')[0]).toMatchObject({ to: 'src/missing.ts::helper::function', evidence: 'resolved' });
  });
});

describe('call resolution rules', () => {
  it('prefers the nearest same-file definition', async () => {
    const [parsed] = await link({ 'x.ts': 'function outer() {\n  function inner() {}\n  inner();\n}\nfunction inner() {}\n' });
    expect(callsOf(parsed!, 'outer')[0]).toMatchObject({ name: 'inner', to: 'x.ts::outer.inner::function', evidence: 'resolved' });
  });

  it('leaves an ambiguous same-file name name-only', async () => {
    const [parsed] = await link({ 'x.ts': 'function dup() {}\nexport function dup() {}\nexport function run() { dup(); }\n' });
    expect(callsOf(parsed!, 'run')[0]).toMatchObject({ name: 'dup', evidence: 'name-only' });
    expect(callsOf(parsed!, 'run')[0]).not.toHaveProperty('to');
  });

  it('follows an aliased import to its definition', async () => {
    const [parsed] = await link({ 'a.ts': "import { charge as pay } from './s';\nexport function run() { pay(); }\n", 's.ts': 'export function charge() {}\n' });
    expect(callsOf(parsed!, 'run')[0]).toMatchObject({ name: 'pay', to: 's.ts::charge::function', evidence: 'resolved' });
  });

  it('follows a renamed re-export to the function behind it', async () => {
    const [parsed] = await link({
      'a.ts': "import { pay } from './barrel';\nexport function run() { pay(); }\n",
      'barrel.ts': "export { charge as pay } from './s';\n",
      's.ts': 'export function charge() {}\n',
    });
    expect(callsOf(parsed!, 'run')[0]).toMatchObject({ name: 'pay', to: 's.ts::charge::function', evidence: 'resolved' });
  });

  it('resolves a namespace member through a barrel', async () => {
    const [parsed] = await link({
      'a.ts': "import * as ns from './barrel';\nexport function run() { ns.charge(); }\n",
      'barrel.ts': "export { charge } from './s';\n",
      's.ts': 'export function charge() {}\n',
    });
    expect(callsOf(parsed!, 'run')[0]).toMatchObject({ name: 'charge', via: 'member', receiver: 'ns', to: 's.ts::charge::function', evidence: 'resolved' });
  });

  it('reads calls in JavaScript files', async () => {
    const [parsed] = await link({ 'a.js': 'export function run() { local(); }\nfunction local() {}\n' });
    expect(callsOf(parsed!, 'run')[0]).toMatchObject({ name: 'local', to: 'a.js::local::function', evidence: 'resolved' });
  });

  it('does not resolve a type-only import or a call whose target is only a type', async () => {
    const [parsed] = await link({ 'a.ts': "import type { charge } from './s';\nexport function run() { charge(); }\n", 's.ts': 'export function charge() {}\n' });
    expect(callsOf(parsed!, 'run')[0]).toMatchObject({ name: 'charge', evidence: 'name-only' });
  });

  it('skips file-scope calls, new expressions and require', async () => {
    const [parsed] = await link({ 'a.ts': "import { start } from './s';\nstart();\nnew Thing();\nconst x = require('./x');\nexport function run() { start(); }\n", 's.ts': 'export function start() {}\n' });
    expect(parsed!.calls.map((c) => [c.name, c.from])).toEqual([['start', 'a.ts::run::function']]);
  });

  it('reads no calls from broken text', async () => {
    const [parsed] = await link({ 'a.ts': 'export function run() { if ( }\n' });
    expect(parsed!.calls).toEqual([]);
  });

  it('resolves this calls from a constructor to the class method', async () => {
    const [parsed] = await link({ 'a.ts': 'export class K {\n  constructor() { this.go(); }\n  go() {}\n}\n' });
    expect(parsed!.calls[0]).toMatchObject({ name: 'go', to: 'a.ts::K.go::method', evidence: 'resolved' });
  });

  it('writes only the call model fields, with a receiver only for a member call', async () => {
    const [parsed] = await link({ 'a.ts': 'export function run() { local(); other.go(); }\nfunction local() {}\n' });
    expect(Object.keys(parsed!.calls[0]!).sort()).toEqual(['evidence', 'from', 'name', 'range', 'to', 'via']);
    expect(parsed!.calls[1]).toMatchObject({ name: 'go', via: 'member', receiver: 'other', evidence: 'name-only' });
    expect(parsed!.calls[1]).not.toHaveProperty('to');
  });
});

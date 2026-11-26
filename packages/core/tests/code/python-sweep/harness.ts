import { createHash } from 'node:crypto';
import type { CallRef, CodeSymbol } from '../../../src/code/model.js';
import { parseCode, type ParsedFile } from '../../../src/code/parse.js';
import { linkCode } from '../../../src/code/resolve/link.js';
import { createResolver } from '../../../src/code/resolve/resolver.js';
import type { Program } from './generate.js';

/**
 * COD-59: runs the generated Python programs through one core link pass and compares every resolved call with what
 * CPython did when `record.py` ran the same text.
 *
 * The comparison is the truth rule of the sweep: core `to` the program's module `f` is sound only if CPython reached
 * the module function (`module`), `b.py::f::function` only if it reached `b.f`, and any other symbol only if it reached
 * the callable at that symbol's path. A name-only call is always sound; when CPython reached a symbol core already has,
 * it is counted as precision core gave up. A site that ran more than once and reached different things (`varies`) has
 * no single target, so a resolved call there is a disagreement too. Nothing here reimplements Python's rules.
 */

export type Outcome =
  | { kind: 'reached'; tag: string }
  | { kind: 'error'; type: string }
  | { kind: 'varies' }
  | { kind: 'not-run' }
  | { kind: 'syntax' };

export interface Recorded {
  hash: string;
  outcome: Outcome;
}

export interface Fixture {
  python: string;
  outcomes: Record<string, Recorded>;
}

export interface Disagreement {
  id: string;
  /** The generated file's path, so a target can be told from the program's own module `f`. */
  path: string;
  construct: string;
  position: string;
  wrapper: string;
  to?: string;
  outcome: Outcome;
  text: string;
}

export interface CheckResult {
  python: string;
  total: number;
  nonSyntax: number;
  syntaxIds: string[];
  callsFound: number;
  resolved: number;
  nameOnly: number;
  /** Programs whose site never ran: a harness bug. */
  notRun: string[];
  /** Programs whose site ran more than once and reached different things: a single resolved target cannot be sound. */
  varies: string[];
  /** Site errors outside TypeError/UnboundLocalError/NameError, and core targets that are not symbols: harness bugs. */
  harnessErrors: string[];
  /** Non-syntax programs without exactly one `f` call in core's output. */
  callsMissing: string[];
  disagreements: Disagreement[];
  /** Per construct, name-only calls where CPython reached a symbol core already has. */
  precision: Map<string, number>;
  precisionTotal: number;
  missingFixture: string[];
  extraFixture: string[];
  hashMismatches: string[];
}

type Files = ReadonlyMap<string, ParsedFile>;

const SITE_ERRORS = new Set(['TypeError', 'UnboundLocalError', 'NameError']);

export function describeOutcome(outcome: Outcome): string {
  if (outcome.kind === 'reached') return `reached '${outcome.tag}'`;
  if (outcome.kind === 'error') return `error ${outcome.type}`;
  return outcome.kind;
}

export function describeDisagreement(disagreement: Disagreement): string {
  const { id, construct, position, wrapper, to, outcome } = disagreement;
  return `${id} [${construct} × ${position} × ${wrapper}] core to=${to ?? 'name-only'} cp=${describeOutcome(outcome)}`;
}

const symbolById = (id: string, files: Files): CodeSymbol | undefined => files.get(id.slice(0, id.indexOf('::')))?.symbols.find((symbol) => symbol.id === id);

/** The tag CPython must have reached for the call's core target, or why the target is not a symbol of the linked repo. */
function expectedTag(call: CallRef, path: string, files: Files): { tag?: string; problem?: string } {
  if (!call.to) return {};
  if (call.to === `${path}::f::function`) return { tag: 'module' };
  const symbol = symbolById(call.to, files);
  if (!symbol) return { problem: `core to=${call.to} is not a symbol of the linked files` };
  // A target in the shared `b.py` is tagged with its module prefix, since its log lives in b's own list.
  return { tag: call.to.startsWith('b.py::') ? `b.${symbol.path.join('.')}` : symbol.path.join('.') };
}

/** Whether a reached tag names a symbol the link pass already has, in this program or in `b.py`. */
function hasSymbolForTag(tag: string, path: string, files: Files): boolean {
  const callableKinds = new Set(['function', 'method', 'class']);
  if (tag === 'module') return (files.get(path)?.symbols ?? []).some((symbol) => symbol.id === `${path}::f::function`);
  if (tag.startsWith('b.')) {
    const wanted = tag.slice(2);
    return (files.get('b.py')?.symbols ?? []).some((symbol) => callableKinds.has(symbol.kind) && symbol.path.join('.') === wanted);
  }
  return (files.get(path)?.symbols ?? []).some((symbol) => callableKinds.has(symbol.kind) && symbol.path.join('.') === tag);
}

/** Links every program with one shared `b.py` and judges each recorded outcome against the call core resolved. */
export async function checkAll(programs: readonly Program[], fixture: Fixture): Promise<CheckResult> {
  const tree: Record<string, string> = { 'b.py': programs[0]?.b ?? '' };
  const paths = programs.map((_, index) => {
    const path = `a_${index}.py`;
    tree[path] = programs[index]!.text;
    return path;
  });
  const parsed = (await Promise.all(Object.entries(tree).map(([path, text]) => parseCode(path, text)))).filter(
    (file): file is ParsedFile => !!file,
  );
  const linked = new Map(linkCode(parsed, createResolver(Object.keys(tree), (path) => tree[path])).map((file) => [file.file.path, file]));

  const result: CheckResult = {
    python: fixture.python,
    total: programs.length,
    nonSyntax: 0,
    syntaxIds: [],
    callsFound: 0,
    resolved: 0,
    nameOnly: 0,
    notRun: [],
    varies: [],
    harnessErrors: [],
    callsMissing: [],
    disagreements: [],
    precision: new Map(),
    precisionTotal: 0,
    missingFixture: [],
    extraFixture: [],
    hashMismatches: [],
  };
  const generated = new Set(programs.map((program) => program.id));
  for (const id of Object.keys(fixture.outcomes)) if (!generated.has(id)) result.extraFixture.push(id);

  for (const [index, program] of programs.entries()) {
    const path = paths[index]!;
    const recorded = fixture.outcomes[program.id];
    if (!recorded) {
      result.missingFixture.push(program.id);
      continue;
    }
    const hash = createHash('sha256').update(program.text).digest('hex');
    if (hash !== recorded.hash) result.hashMismatches.push(`${program.id}: recorded ${recorded.hash}, generated ${hash}`);
    const outcome = recorded.outcome;
    if (outcome.kind === 'syntax') {
      result.syntaxIds.push(program.id);
      continue;
    }
    result.nonSyntax++;
    const calls = (linked.get(path)?.calls ?? []).filter((call) => call.name === 'f');
    result.callsFound += calls.length;
    if (calls.length !== 1) {
      result.callsMissing.push(`${program.id}: ${calls.length} calls named f in ${path}, expected 1`);
      continue;
    }
    const call = calls[0]!;
    if (program.site === 'constructed' && (call.via !== 'member' || call.receiver !== 'c')) {
      result.harnessErrors.push(`${program.id}: constructed site emitted via=${call.via} receiver=${call.receiver ?? 'none'}, expected the member call c.f()`);
    }
    if (outcome.kind === 'not-run') result.notRun.push(program.id);
    if (outcome.kind === 'varies') result.varies.push(program.id);
    if (outcome.kind === 'error' && !SITE_ERRORS.has(outcome.type)) result.harnessErrors.push(`${program.id}: site error ${outcome.type}`);
    if (!call.to) {
      result.nameOnly++;
      if (outcome.kind === 'reached' && hasSymbolForTag(outcome.tag, path, linked)) {
        result.precisionTotal++;
        result.precision.set(program.construct, (result.precision.get(program.construct) ?? 0) + 1);
      }
      continue;
    }
    result.resolved++;
    const expected = expectedTag(call, path, linked);
    if (expected.problem) {
      result.harnessErrors.push(`${program.id}: ${expected.problem}`);
      continue;
    }
    if (outcome.kind !== 'reached' || outcome.tag !== expected.tag) {
      result.disagreements.push({
        id: program.id,
        path,
        construct: program.construct,
        position: program.position,
        wrapper: program.wrapper,
        to: call.to,
        outcome,
        text: program.text,
      });
    }
  }
  return result;
}

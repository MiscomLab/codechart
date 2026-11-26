import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { programs } from './python-sweep/generate.js';
import { type CheckResult, type Fixture, checkAll, describeDisagreement } from './python-sweep/harness.js';

/**
 * COD-59: the generated Python sweep, checked against CPython itself.
 *
 * `generate.ts` expands every binding construct over every call position and control-flow wrapper. `record.py` ran the
 * same texts with `python3 -I` (CPython 3.14) and recorded, for each one, what each execution of the single call to `f`
 * reached, whether the executions varied, or which error it raised; `outcomes.json` is that committed fixture, so CI
 * needs no Python.
 *
 * Every program's hash is asserted against the fixture first: a changed generator must be re-recorded, never silently
 * re-judged. Then the soundness rule: a call core resolves to the program's module `f` must have reached `module`, a
 * call to `b.py::f::function` must have reached `b.f`, and any other symbol must have reached the callable at that
 * symbol's path. Name-only is always sound; when CPython reached a symbol core already has, the precision report counts
 * it. A program whose site never ran is a harness bug and fails too.
 *
 * Regenerate with:
 *   npx tsx packages/core/tests/code/python-sweep/dump.ts | python3 -I packages/core/tests/code/python-sweep/record.py
 */

const fixture = JSON.parse(readFileSync(new URL('./python-sweep/outcomes.json', import.meta.url), 'utf8')) as Fixture;

/** CPython rejects exactly the in-function star import; any other rejected program is a generator bug, not an exclusion. */
const EXPECTED_SYNTAX = ['star-import-in-function.function.none'];

let result: CheckResult;

beforeAll(async () => {
  const all = programs();
  result = await checkAll(all, fixture);
  const precision = [...result.precision.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([construct, count]) => `${construct}: ${count}`)
    .join(', ');
  console.info(
    `python sweep: ${result.python.split(' ')[0]}; ${result.total} programs (${result.syntaxIds.length} syntax-excluded, ${result.nonSyntax} run); ` +
      `core resolved ${result.resolved}, name-only ${result.nameOnly}; not-run ${result.notRun.length}; varies ${result.varies.length}; disagreements ${result.disagreements.length}`,
  );
  console.info(`precision cost (name-only although CPython reached a symbol core has): ${result.precisionTotal}${precision ? ` (${precision})` : ''}`);
}, 120_000);

describe('generated Python sweep: every resolved call is checked against CPython', () => {
  it('has a recorded outcome for every generated program, with the same text', () => {
    expect(result.missingFixture, 'programs without a recorded outcome; re-record the fixture').toEqual([]);
    expect(result.extraFixture, 'fixture entries the generator no longer produces; re-record the fixture').toEqual([]);
    expect(result.hashMismatches, 'programs whose text changed since recording; re-record the fixture').toEqual([]);
    expect(result.python, 'the fixture was recorded by CPython 3.14, whose scoping the sweep asserts').toMatch(/^3\.14\./);
  });

  it('excludes only the program CPython rejects', () => {
    expect(result.syntaxIds, 'programs CPython rejects at compile time, excluded from the sweep').toEqual(EXPECTED_SYNTAX);
  });

  it('finds exactly one f call for every runnable program (non-vacuous)', () => {
    expect(result.callsMissing, 'programs whose one f call the link pass did not emit exactly once').toEqual([]);
    expect(result.callsFound, 'f calls found in the linked files, one per runnable program').toBe(result.nonSyntax);
  });

  it('runs the site in every program', () => {
    expect(result.notRun, 'programs whose site never ran: a harness bug, not a binding').toEqual([]);
    expect(result.harnessErrors, 'site errors outside the scoping set, or core targets that are not symbols').toEqual([]);
  });

  it('resolves only where CPython reaches that symbol', () => {
    expect(result.disagreements.map(describeDisagreement), 'resolved calls CPython does not reach').toEqual([]);
  });
});

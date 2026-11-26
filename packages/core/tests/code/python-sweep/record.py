"""COD-59 Python sweep recorder: runs every generated program with this CPython and writes outcomes.json.

Usage (from the repo root):

    npx tsx packages/core/tests/code/python-sweep/dump.ts | python3 -I packages/core/tests/code/python-sweep/record.py

The oracle is CPython itself. Each program is compiled and executed in a fresh namespace with `b` importable; the
recorder reads the log the program's bindings append to and reports what the one call to `f` did:

    reached <tag>  the call ran and a binding logged <tag>
    error <type>   the call itself raised TypeError, UnboundLocalError or NameError
    not-run        the site was never evaluated (a harness bug; the test asserts there are none)
    syntax         CPython rejects the program (excluded from the sweep)

The log tag `<site>` is the generator's sentinel, logged just before the call; a tag after it is what the call reached,
and an exception with the sentinel but no tag happened at the call. `b.py` logs into its own list, merged per program.
"""

import hashlib
import json
import os
import sys
import tempfile

SITE_TAG = '<site>'

B_SOURCE = """LOG = []
def f():
    LOG.append('b.f')
    return object
__all__ = ['f']
"""


def run_program(b, program_id, text):
    """Compile and execute one program; return its outcome. Raises when the harness itself cannot explain the run."""
    b.LOG.clear()
    namespace = {'__name__': 'sweep_program', '__file__': program_id}
    try:
        code = compile(text, program_id, 'exec')
    except SyntaxError:
        return {'kind': 'syntax'}
    error = None
    try:
        exec(code, namespace)
    except BaseException as exc:  # noqa: BLE001 - the program's failure is the observation
        error = exc
    a_log = namespace.get('LOG')
    log = list(a_log if isinstance(a_log, list) else []) + list(b.LOG)
    tags = [tag for tag in log if tag != SITE_TAG]
    if len(tags) > 1:
        raise RuntimeError('%s: the site logged more than once: %r' % (program_id, tags))
    if tags:
        return {'kind': 'reached', 'tag': tags[0]}
    if error is not None:
        if SITE_TAG not in log:
            return {'kind': 'not-run'}
        return {'kind': 'error', 'type': type(error).__name__}
    if SITE_TAG in log:
        raise RuntimeError('%s: the site ran and returned without logging or raising' % program_id)
    return {'kind': 'not-run'}


def main():
    data = json.load(sys.stdin)
    programs = data.get('programs')
    if not isinstance(programs, list):
        raise SystemExit('stdin must be {"programs": [{"id", "text"}, ...]}')
    seen = set()
    for program in programs:
        if set(program) < {'id', 'text'}:
            raise SystemExit('a program is missing its id or text')
        if program['id'] in seen:
            raise SystemExit('duplicate program id: %s' % program['id'])
        seen.add(program['id'])

    with tempfile.TemporaryDirectory() as folder:
        with open(os.path.join(folder, 'b.py'), 'w', encoding='utf-8') as handle:
            handle.write(B_SOURCE)
        sys.path.insert(0, folder)
        import b  # noqa: E402 - after sys.path holds the module

        outcomes = {}
        for program in programs:
            outcomes[program['id']] = {
                'hash': hashlib.sha256(program['text'].encode('utf-8')).hexdigest(),
                'outcome': run_program(b, program['id'], program['text']),
            }

    destination = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'outcomes.json')
    with open(destination, 'w', encoding='utf-8') as handle:
        json.dump({'python': sys.version, 'outcomes': outcomes}, handle, indent=2, sort_keys=True)
        handle.write('\n')

    kinds = {}
    for entry in outcomes.values():
        kind = entry['outcome']['kind']
        kinds[kind] = kinds.get(kind, 0) + 1
    not_run = [program_id for program_id, entry in outcomes.items() if entry['outcome']['kind'] == 'not-run']
    print('python: %s' % sys.version.split()[0], file=sys.stderr)
    print('programs: %d %s' % (len(outcomes), json.dumps(kinds, sort_keys=True)), file=sys.stderr)
    if not_run:
        print('not-run: %s' % ', '.join(not_run), file=sys.stderr)
    print('wrote %s' % destination, file=sys.stderr)


if __name__ == '__main__':
    main()

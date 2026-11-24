import { describe, expect, it } from 'vitest';
import { parseConfigFile } from '../../src/config/schema.js';
import { writePinned } from '../../src/config/pinned.js';
import * as core from '../../src/index.js';

const errorsOf = (pinned: unknown): string[] => {
  const result = parseConfigFile({ map: { pinned } });
  if (result.ok) throw new Error('parsed');
  return result.errors;
};

// The desktop app's group boxes (codechart-app packages/map/src/grouping.ts): `group:<level id>/<first word>` or
// `group:<level id>/<first>..<last>`, the level a folder box id, a rule box id, or empty at the top.
describe('map.pinned: group box ids', () => {
  it('takes the ids the desktop app writes, at the top, in a folder and in a rule box', () => {
    const pinned = {
      'group:/doctor': { name: 'Health checks' },
      'group:/r01.ts..r02.ts': { name: 'First reports' },
      'group:/cli..f01': { name: 'A run of boxes and files' },
      'group:folder:commands/doctor': { name: 'Doctor commands' },
      'group:folder:tests/conftest.py..test_app.py': { name: 'App tests' },
      'group:folder:many/alpha.ts..bravo.ts': { name: 'Early files' },
      'group:folder:a/b/deep/only..zeta': { name: 'A run from a merged folder chain' },
      'group:billing/doctor': { name: 'Billing checks' },
      'group:billing/legacy/billing/a.ts..legacy/billing/f.ts': { name: 'Old billing' },
      'group:folder/doctor': { name: 'In a rule box named folder' },
      'group:group/doctor': { name: 'In a rule box named group' },
      'group:folder-x/a.ts..b.ts': { name: 'In a rule box named folder-x' },
    };
    expect(parseConfigFile({ map: { pinned } })).toEqual({ ok: true, config: { map: { pinned } } });
    for (const id of Object.keys(pinned)) expect(core.pinnedIdKind(id)).toBe('group');
    expect(core.GROUP_BOX_PREFIX).toBe('group:');
  });

  it.each([
    ['no level and label', 'group:'],
    ['no slash', 'group:doctor'],
    ['no label at the top', 'group:/'],
    ['no label in a folder', 'group:folder:src/'],
    ['an empty folder', 'group:folder:/doctor'],
    ['a folder with a .. segment', 'group:folder:../doctor'],
    ['a folder with an empty segment', 'group:folder:src//doctor'],
    ['a folder with a backslash', 'group:folder:src\\x/doctor'],
    ['an uppercase box', 'group:Billing/doctor'],
    ['a box starting with a hyphen', 'group:-x/doctor'],
    ['a box over 64 characters', `group:${'a'.repeat(65)}/doctor`],
    ['a group as the level', 'group:group:/a/doctor'],
    ['a label starting with a slash', 'group://doctor'],
    ['a line break', 'group:/doc\ntor'],
    ['a bidi override', 'group:/doc‮tor'],
    ['an uppercase prefix', 'Group:/doctor'],
    ['over 1000 characters', `group:/${'a'.repeat(994)}`],
  ])('rejects a group id with %s, naming the formats', (_, id) => {
    const errors = errorsOf({ [id]: { name: 'X' } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^map\.pinned: ".+": .*group box id .*node id/);
    expect(core.pinnedIdKind(id)).toBeUndefined();
  });

  it('is up to 1000 characters, like any id', () => {
    expect(core.pinnedIdKind(`group:/${'a'.repeat(993)}`)).toBe('group');
  });

  it('tells a group id from the other forms by syntax alone', () => {
    expect(core.pinnedIdKind('group:folder:a.ts::x::function')).toBe('node');
    expect(core.pinnedIdKind('folder:group:/x')).toBe('folder');
    expect(core.pinnedIdKind('group')).toBe('rule-box');
  });

  it('never takes a file id: a file keeps its own name', () => {
    expect(core.pinnedIdKind('file:src/a.ts')).toBeUndefined();
    expect(errorsOf({ 'file:src/a.ts': { name: 'A' } })[0]).toMatch(/^map\.pinned: "file:src\/a\.ts": /);
  });

  it('writePinned writes a group pin, sorted with the others by id', () => {
    const out = writePinned('', { 'group:folder:commands/doctor': { name: 'Health checks' }, billing: { name: 'Billing' }, 'group:/a.ts..f.ts': { name: 'Early files' } });
    expect(out).toBe(
      ['map:', '  pinned:', '    billing:', '      name: Billing', '    group:/a.ts..f.ts:', '      name: Early files', '    group:folder:commands/doctor:', '      name: Health checks', ''].join('\n'),
    );
  });
});

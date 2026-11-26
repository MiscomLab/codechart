import type { Construct } from './generate.js';

/**
 * COD-59 round 2: the causes the first sweep did not generate. Kept beside the generator because the constructs are
 * sized like a test file; `generate.ts` imports and appends them in order, so ids stay deterministic.
 *
 * P1 a base earlier in the MRO defines f; P2 a base the linker cannot read as a name (subscript, call, starred,
 * `type()`); P3 another module rebinds the module function through its namespace dict; P4 a call on an imported
 * module's attribute after a write or delete; P5 `__getattribute__`/`__new__` written from outside the class; P6
 * deletes of the module function and of a class method; P7 a method object escapes to a class that is not a subclass.
 */

const indent = (text: string, width = 4): string =>
  text
    .split('\n')
    .map((line) => (line.length ? ' '.repeat(width) + line : line))
    .join('\n');

const MEMBER_SITES = ['method-body', 'module-class-method-body'] as const;

/** A class body's plain method f, logging the core path of the class the member site sits in. */
const memberMethod = (tag: string): string[] => ['def f(self):', `    LOG.append('${tag}.f')`, '    return object'];

/** A member-site plan: the class's plain method f, then the driver's lines and the receiver it calls `m` on. */
const memberPlan = (tag: string, driverPre: readonly string[], driver = 'K().m()', base?: string) => ({
  ...(base ? { base } : {}),
  pre: memberMethod(tag),
  driverPre,
  driver,
});

/** An override of f on a driver class L: the runtime target for an L receiver. */
const override = (name = 'L'): string[] => ['    def f(self):', `        LOG.append('${name}.f')`, '        return object'];

export const ROUND2_CONSTRUCTS: readonly Construct[] = [
  // P3: `b.rebind` writes f through the module's namespace dict; the program hands it its own module object.
  { name: 'module-rebind-from-b', run: true, module: true, outer: ['import b', 'import sys', 'b.rebind(sys.modules[__name__])'] },
  // P4: the direct call is the precision pin; the write and setattr replace b.f; the delete makes the call raise
  // AttributeError, which the wrap records before afterCall restores b.f for the programs that share b.py.
  { name: 'module-attr-call', run: true, module: true, siteCall: 'b.f()', outer: ['import b'] },
  { name: 'module-attr-call-written', run: true, module: true, siteCall: 'b.f()', outer: ['import b', "b.f = _Mark('b.attr')"] },
  { name: 'module-attr-call-setattr', run: true, module: true, siteCall: 'b.f()', outer: ['import b', "setattr(b, 'f', _Mark('b.setattr'))"] },
  {
    name: 'module-attr-call-deleted',
    run: true,
    siteCall: 'b.f()',
    outer: ['import b', '_bf = b.f', 'del b.f'],
    wrap: (body) => `try:\n${indent(body)}\nexcept AttributeError:\n    LOG.append('b.deleted')`,
    afterCall: ['b.f = _bf'],
  },
  // P1: X precedes K in L's MRO, so L().m() reaches X.f.
  {
    name: 'member-mro-sibling',
    run: true,
    module: true,
    thisCall: true,
    positions: MEMBER_SITES,
    outer: ['class X:', '    def f(self):', "        LOG.append('X.f')", '        return object'],
    classPlan: (tag) => memberPlan(tag, ['class L(X, K):', '    pass'], 'L().m()'),
  },
  // P2: the base is a subscript, a call, a starred tuple or a type() call, so its name is not K to the linker.
  ...(
    [
      ['member-base-subscript', '_bases = [K]', 'class L(_bases[0]):'],
      ['member-base-call', 'def _base(): return K', 'class L(_base()):'],
      ['member-base-starred', '_bases = (K,)', 'class L(*_bases):'],
    ] as const
  ).map(([name, setup, head]) => ({
    name,
    run: true,
    module: true,
    thisCall: true,
    positions: MEMBER_SITES,
    classPlan: (tag: string) => memberPlan(tag, [setup, head, ...override()], 'L().m()'),
  })),
  {
    name: 'member-base-type',
    run: true,
    module: true,
    thisCall: true,
    positions: MEMBER_SITES,
    classPlan: (tag) => memberPlan(tag, ['L = type("L", (K,), {"f": _Mark("L.f")})'], 'L().m()'),
  },
  // P5: `__getattribute__` and `__new__` written after the class body.
  ...(
    [
      ['member-outside-getattribute', 'K.__getattribute__ = _getattribute'],
      ['member-outside-getattribute-setattr', "setattr(K, '__getattribute__', _getattribute)"],
    ] as const
  ).map(([name, write]) => ({
    name,
    run: true,
    module: true,
    thisCall: true,
    positions: MEMBER_SITES,
    classPlan: (tag: string) =>
      memberPlan(tag, [
        'def _getattribute(self, name):',
        `    if name == 'f': return mk('${tag}.getattribute')`,
        '    return object.__getattribute__(self, name)',
        write,
      ]),
  })),
  {
    name: 'member-outside-new',
    run: true,
    module: true,
    thisCall: true,
    positions: MEMBER_SITES,
    classPlan: (tag) =>
      memberPlan(tag, ['Other = type("Other", (K,), {"f": _Mark("Other.f"), "__new__": object.__new__})', 'K.__new__ = lambda cls: Other()']),
  },
  // P6: the deletes remove the module function, and delattr exposes a base method.
  { name: 'module-deleted-globals', run: true, module: true, outer: ["del globals()['f']"] },
  { name: 'module-deleted-sysmod', run: true, module: true, outer: ['import sys', "del sys.modules[__name__].f"] },
  {
    name: 'member-delattr-base',
    run: true,
    module: true,
    thisCall: true,
    positions: MEMBER_SITES,
    outer: ['class Base:', '    def f(self):', "        LOG.append('base.f')", '        return object'],
    classPlan: (tag) => memberPlan(tag, ["delattr(K, 'f')"], 'K().m()', 'Base'),
  },
  // P7: K.m runs with an L self, whether aliased outside or in L's body.
  ...(
    [
      ['member-method-alias-outside', 'L.m = K.m'],
      ['member-method-alias-body', '    m = K.m'],
    ] as const
  ).map(([name, alias]) => ({
    name,
    run: true,
    module: true,
    thisCall: true,
    positions: MEMBER_SITES,
    classPlan: (tag: string) => memberPlan(tag, ['class L:', ...override(), alias], 'L().m()'),
  })),
];

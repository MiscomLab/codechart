/**
 * COD-59: the generated Python sweep, the Python counterpart of `calls-scope-generated.test.ts`.
 *
 * Every binding construct of the Python language reference (Execution model, 4.2.2 Resolution of names) is expanded over
 * every place a call can sit and every control-flow wrapper. The generator decides program TEXT and labels only: what a
 * call reaches (or which exception it raises) is recorded by running the program with CPython (`record.py`), never
 * derived here. Each program holds exactly one call to `f`; the prelude logs a tag per binding and every `def`/`class`
 * that binds `f` logs its core symbol path, so the recorder can say what CPython reached.
 *
 * Skipped combinations are documented where they are skipped: a construct that binds in `run`'s body has no effect on a
 * module-level class skeleton, a class-body binding has no place in a class header, and the in-function star import is
 * generated once because CPython rejects the file wherever the import sits.
 */

export interface Program {
  id: string;
  text: string;
  /** `b.py` the program imports from. */
  b: string;
  construct: string;
  position: string;
  wrapper: string;
}

/** The sentinel the harness logs just before the one call site, so an error can be told from a site that never ran. */
export const SITE_TAG = '<site>';

/**
 * The prelude of every program. Besides module `f` it binds only helpers whose names never collide with `f`: `_Mark` is
 * a callable that logs its tag, `_Pair` a context manager yielding a tuple, `Box` a class pattern, and the `_of`
 * functions return values a class header accepts (`base_of(SITE)` must not fail because the call's value is odd).
 */
const PRELUDE = `LOG = []
class _Mark:
    def __init__(self, tag): self.tag = tag
    def __call__(self, *a, **k): LOG.append(self.tag); return object
    def __iadd__(self, other): return self
    def __iter__(self): return iter([0])
    def __enter__(self): return self
    def __exit__(self, *a): return False
class _Pair:
    def __init__(self, tag): self.tag = tag
    def __enter__(self): return (_Mark(self.tag), 0)
    def __exit__(self, *a): return False
class Box:
    __match_args__ = ('x',)
    def __init__(self, x): self.x = x
def mk(tag): return _Mark(tag)
def base_of(v): return object
def meta_of(v): return type
def deco_of(v): return lambda fn: fn
class Err(Exception):
    def __call__(self, *a, **k): LOG.append('except'); return object
def f(): LOG.append('module'); return object
import annotationlib
`;

/** `b.py`: the site reaches it only through an import of `f`, and logs `b.f` into its own list the recorder merges. */
const B = `LOG = []
def f():
    LOG.append('b.f')
    return object
__all__ = ['f']
`;

const indent = (text: string, width = 4): string =>
  text
    .split('\n')
    .map((line) => (line.length ? ' '.repeat(width) + line : line))
    .join('\n');

const joined = (parts: readonly (string | readonly string[])[]): string =>
  parts
    .flatMap((part) => (typeof part === 'string' ? [part] : [...part]))
    .filter((line) => line.length > 0)
    .join('\n');

type Wrap = (statement: string) => string;

const inBlock = (head: string, body: string, width = 4): string => `${head}\n${indent(body, width)}`;

/** A class body with the construct's class-scope bindings around the statement holding the site. */
const classWith = (head: string, pre: readonly string[], statement: string, post: readonly string[], driver: string, classWrap?: Wrap): string =>
  joined([`${head}\n${indent(joined([...pre, classWrap ? classWrap(statement) : statement, ...post]))}`, driver]);

interface Position {
  name: string;
  /** The position's skeleton is module level: no `run`, the driver defines and calls the class itself. */
  module?: boolean;
  /** The position has a class body a class-scope binding construct can be inserted into. */
  classBody?: boolean;
  /** One of the class-body sites the gate's class/def and flow constructs are applied to. */
  classCandidates?: boolean;
  build: (ctx: {
    site: string;
    wrap: Wrap;
    classPre: readonly string[];
    classPost: readonly string[];
    classHead: string;
    classWrap?: Wrap;
  }) => string;
}

const POSITIONS: readonly Position[] = [
  { name: 'function', build: ({ site, wrap }) => wrap(site) },
  { name: 'nested-def-body', build: ({ site, wrap }) => joined([`def inner():\n${indent(wrap(site))}`, 'inner()']) },
  { name: 'lambda-body', build: ({ site, wrap }) => wrap(`(lambda: ${site})()`) },
  { name: 'lambda-default', build: ({ site, wrap }) => wrap(`(lambda a=${site}: None)()`) },
  { name: 'comprehension-element', build: ({ site, wrap }) => wrap(`[${site} for _x in [0]]`) },
  { name: 'comprehension-condition', build: ({ site, wrap }) => wrap(`[0 for _x in [0] if ${site}]`) },
  { name: 'comprehension-first-iterable', build: ({ site, wrap }) => wrap(`[0 for _x in ${site}]`) },
  { name: 'comprehension-later-iterable', build: ({ site, wrap }) => wrap(`[0 for _x in [0] for _y in ${site}]`) },
  { name: 'genexpr-element', build: ({ site, wrap }) => wrap(`list(${site} for _x in [0])`) },
  { name: 'genexpr-first-iterable', build: ({ site, wrap }) => wrap(`list(0 for _x in ${site})`) },
  { name: 'nested-def-default', build: ({ site, wrap }) => joined([wrap(`def inner(a=${site}):\n    pass`), 'inner()']) },
  {
    name: 'nested-def-parameter-annotation',
    build: ({ site, wrap }) => joined([wrap(`def inner(a: ${site}):\n    pass`), 'annotationlib.get_annotations(inner, format=annotationlib.Format.VALUE)']),
  },
  {
    name: 'nested-def-return-annotation',
    build: ({ site, wrap }) => joined([wrap(`def inner() -> ${site}:\n    pass`), 'annotationlib.get_annotations(inner, format=annotationlib.Format.VALUE)']),
  },
  { name: 'nested-def-decorator', build: ({ site, wrap }) => joined([wrap(`@deco_of(${site})\ndef inner():\n    pass`), 'inner()']) },
  { name: 'class-body', classBody: true, classCandidates: true, build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`x = ${site}`), classPost, 'K', classWrap) },
  {
    name: 'class-body-lambda-body',
    classBody: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`x = (lambda: ${site})()`), classPost, 'K', classWrap),
  },
  {
    name: 'class-body-comprehension-element',
    classBody: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`x = [${site} for _x in [0]]`), classPost, 'K', classWrap),
  },
  {
    name: 'class-body-comprehension-first-iterable',
    classBody: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`x = [0 for _x in ${site}]`), classPost, 'K', classWrap),
  },
  { name: 'class-base', build: ({ site, wrap }) => joined([wrap(`class K(base_of(${site})):\n    pass`), 'K']) },
  {
    name: 'class-base-lambda-body',
    build: ({ site, wrap }) => joined([wrap(`class K(base_of((lambda: ${site})())):\n    pass`), 'K']),
  },
  {
    name: 'class-base-comprehension-element',
    build: ({ site, wrap }) => joined([wrap(`class K(base_of([${site} for _x in [0]])):\n    pass`), 'K']),
  },
  {
    name: 'class-base-comprehension-first-iterable',
    build: ({ site, wrap }) => joined([wrap(`class K(base_of([0 for _x in ${site}])):\n    pass`), 'K']),
  },
  { name: 'class-keyword', build: ({ site, wrap }) => joined([wrap(`class K(metaclass=meta_of(${site})):\n    pass`), 'K']) },
  {
    name: 'method-default',
    classBody: true,
    classCandidates: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`def m(self, a=${site}):\n    pass`), classPost, 'K().m()', classWrap),
  },
  {
    name: 'method-default-lambda-body',
    classBody: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`def m(self, a=(lambda: ${site})()):\n    pass`), classPost, 'K().m()', classWrap),
  },
  {
    name: 'method-default-comprehension-element',
    classBody: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`def m(self, a=[${site} for _x in [0]]):\n    pass`), classPost, 'K().m()', classWrap),
  },
  {
    name: 'method-default-comprehension-first-iterable',
    classBody: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`def m(self, a=[0 for _x in ${site}]):\n    pass`), classPost, 'K().m()', classWrap),
  },
  {
    name: 'method-parameter-annotation',
    classBody: true,
    classCandidates: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) =>
      joined([classWith(classHead, classPre, wrap(`def m(self, a: ${site}):\n    pass`), classPost, '', classWrap), 'annotationlib.get_annotations(K.m, format=annotationlib.Format.VALUE)']),
  },
  {
    name: 'method-return-annotation',
    classBody: true,
    classCandidates: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) =>
      joined([classWith(classHead, classPre, wrap(`def m(self) -> ${site}:\n    pass`), classPost, '', classWrap), 'annotationlib.get_annotations(K.m, format=annotationlib.Format.VALUE)']),
  },
  {
    name: 'method-body',
    classBody: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, `def m(self):\n${indent(wrap(site))}`, classPost, 'K().m()', classWrap),
  },
  {
    name: 'method-decorator',
    classBody: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`@deco_of(${site})\ndef m(self):\n    pass`), classPost, 'K().m()', classWrap),
  },
  {
    name: 'nested-class-header',
    classBody: true,
    classCandidates: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`class Inner(base_of(${site})):\n    pass`), classPost, 'K.Inner', classWrap),
  },
  {
    name: 'nested-class-keyword',
    classBody: true,
    classCandidates: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`class Inner(metaclass=meta_of(${site})):\n    pass`), classPost, 'K.Inner', classWrap),
  },
  {
    name: 'def-in-class-if',
    classBody: true,
    classCandidates: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) =>
      classWith(classHead, classPre, `if True:\n${indent(wrap(`def m(self, a=${site}):\n    pass`))}`, classPost, 'K().m()', classWrap),
  },
  { name: 'module-class-body', module: true, classBody: true, build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`x = ${site}`), classPost, 'K', classWrap) },
  { name: 'module-class-base', module: true, build: ({ site, wrap }) => joined([wrap(`class K(base_of(${site})):\n    pass`), 'K']) },
  {
    name: 'module-class-method-default',
    module: true,
    classBody: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`def m(self, a=${site}):\n    pass`), classPost, 'K().m()', classWrap),
  },
  {
    name: 'module-class-method-body',
    module: true,
    classBody: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, `def m(self):\n${indent(wrap(site))}`, classPost, 'K().m()', classWrap),
  },
  // A type alias's value is evaluated lazily: its annotation scope sees the enclosing scope (and, in a class body,
  // the class namespace); a lambda or comprehension inside it has its own nested scope.
  { name: 'type-alias-value', build: ({ site, wrap }) => joined([wrap(`type A = ${site}`), 'A.__value__']) },
  {
    name: 'type-alias-value-lambda-body',
    build: ({ site, wrap }) => joined([wrap(`type A = (lambda: ${site})()`), 'A.__value__']),
  },
  {
    name: 'type-alias-value-comprehension-element',
    build: ({ site, wrap }) => joined([wrap(`type A = [${site} for _x in [0]]`), 'A.__value__']),
  },
  {
    name: 'type-alias-value-comprehension-first-iterable',
    build: ({ site, wrap }) => joined([wrap(`type A = [0 for _x in ${site}]`), 'A.__value__']),
  },
  {
    name: 'class-body-type-alias-value',
    classBody: true,
    classCandidates: true,
    build: ({ site, wrap, classPre, classPost, classHead, classWrap }) => classWith(classHead, classPre, wrap(`type A = ${site}`), classPost, 'K.A.__value__', classWrap),
  },
  // A PEP 695 type-parameter bound is evaluated lazily, in the definition's annotation scope: the enclosing function
  // for a nested def, and the class body (through __classdict__) for a method.
  { name: 'type-param-bound', build: ({ site, wrap }) => joined([wrap(`def inner[T: ${site}]():\n    pass`), 'inner.__type_params__[0].__bound__']) },
  { name: 'class-type-param-bound', build: ({ site, wrap }) => joined([wrap(`class Inner[T: ${site}]:\n    pass`), 'Inner.__type_params__[0].__bound__']) },
];

/** Extra lines and wrapping for a position's class body, or a `class K[f]:` header. */
interface ClassPlan {
  pre?: readonly string[];
  post?: readonly string[];
  wrap?: Wrap;
  typeParam?: boolean;
}

/** Lines of one class-body binding, tagged with the core path of the class it sits in (`run.K` or `K`). */
const classBodyBinding = (shape: 'class' | 'def', tag: string): string[] =>
  shape === 'class' ? ['class f:', `    def __init__(self): LOG.append('${tag}.f')`] : ['def f():', `    LOG.append('${tag}.f')`, '    return object'];

const shifted = (lines: readonly string[]): string[] => indent(lines.join('\n')).split('\n');

type ClassSitePlacement = 'before' | 'after' | 'if-false' | 'try-raised' | 'rebind-after' | 'loop-rebind' | 'while-del';

/** The gate's placements of a class-body binding around the site: reached order, dead branches, and later loops. */
const classSite = (shape: 'class' | 'def', placement: ClassSitePlacement) => (tag: string): ClassPlan => {
  const binding = classBodyBinding(shape, tag);
  if (placement === 'before') return { pre: binding };
  if (placement === 'after') return { post: binding };
  if (placement === 'if-false') return { pre: ['if False:', ...shifted(binding)] };
  if (placement === 'try-raised') return { pre: ['try:', '    raise ValueError', ...shifted(binding), 'except ValueError:', '    pass'] };
  if (placement === 'rebind-after') return { pre: binding, post: ["f = mk('K.rebind')"] };
  if (placement === 'loop-rebind') return { pre: binding, wrap: (body) => `for _i in range(2):\n${indent(body)}\n    f = mk('K.loop')` };
  return { pre: binding, wrap: (body) => `while True:\n${indent(body)}\n    del f\n    break` };
};

interface Construct {
  name: string;
  /** Applies inside `run`'s body. */
  run?: boolean;
  /** Applies to the module-level class skeleton. */
  module?: boolean;
  /** On the module skeleton, restricts the construct to these positions. */
  modulePositions?: readonly string[];
  params?: string;
  call?: string;
  pre?: readonly string[];
  post?: readonly string[];
  outer?: readonly string[];
  /** Wraps the position's statement(s), for a construct that binds in a block around the site. */
  wrap?: (body: string) => string;
  /** `run` sits inside an outer function that binds `f`; the site closes over it. */
  nest?: 'nonlocal' | 'closure';
  typeParams?: string;
  /** Inserted into the position's class body, before or after the statement holding the site. */
  classBinding?: 'before' | 'after';
  /** A class-body plan; the tag is the core path of the class the position defines (`run.K` or `K`). */
  classPlan?: (tag: string) => ClassPlan;
  /** The class plan is only the gate's named class-body sites, not every class body. */
  classSiteOnly?: boolean;
  /** The site's expression becomes a lambda with a parameter `f`, called with a marker. */
  lambdaParam?: boolean;
  /** CPython rejects the program at compile time; generated once and excluded from the sweep. */
  syntax?: boolean;
}

/** The tags of `def`/`class` constructs are the core symbol path a Python call would reach. */
const CONSTRUCTS: readonly Construct[] = [
  { name: 'none', run: true, module: true },
  { name: 'param', run: true, params: 'f', call: "run(mk('param'))" },
  { name: 'default-param', run: true, params: "f=mk('param')" },
  { name: 'star-param', run: true, params: '*f', call: "run(mk('param'))" },
  { name: 'keyword-only-param', run: true, params: '*, f', call: "run(f=mk('kwonly'))" },
  { name: 'positional-only-param', run: true, params: 'f, /', call: "run(mk('posonly'))" },
  { name: 'annotated-param', run: true, params: 'f: int', call: "run(mk('annot'))" },
  { name: 'double-star-param', run: true, params: '**f', call: "run(f=mk('param'))" },
  { name: 'assign', run: true, module: true, pre: ["f = mk('assign')"] },
  { name: 'tuple-assign', run: true, module: true, pre: ["f, _g = mk('assign'), 0"] },
  { name: 'augmented-assign', run: true, module: true, pre: ["f = mk('aug')", 'f += 1'] },
  { name: 'walrus', run: true, module: true, pre: ["(f := mk('walrus'))"] },
  { name: 'for-target', run: true, module: true, wrap: (body) => inBlock("for f in [mk('for')]:", body) },
  { name: 'for-tuple-target', run: true, module: true, wrap: (body) => inBlock("for f, _g in [(mk('for'), 0)]:", body) },
  { name: 'with-target', run: true, module: true, wrap: (body) => inBlock("with _Mark('with') as f:", body) },
  { name: 'with-tuple-target', run: true, module: true, wrap: (body) => inBlock("with _Pair('with') as (f, _g):", body) },
  { name: 'except-target', run: true, module: true, pre: ['try:', '    raise Err()', 'except Err as f:', '    pass'] },
  { name: 'except-live', run: true, module: true, wrap: (body) => inBlock('try:\n    raise Err()\nexcept Err as f:', body) },
  { name: 'from-import', run: true, module: true, pre: ['from b import f'] },
  { name: 'from-import-alias', run: true, module: true, pre: ['from b import f as f'] },
  { name: 'import-module-alias', run: true, module: true, pre: ['import b as f'] },
  { name: 'star-import', run: true, module: true, outer: ['from b import *'] },
  { name: 'star-import-in-function', run: true, syntax: true, pre: ['from b import *'] },
  { name: 'global', run: true, pre: ['global f'] },
  { name: 'global-assign', run: true, pre: ['global f', "f = mk('global-assign')"] },
  { name: 'nonlocal', run: true, nest: 'nonlocal', pre: ['nonlocal f'] },
  { name: 'closure', run: true, nest: 'closure' },
  { name: 'nested-def', run: true, pre: ["def f():", "    LOG.append('run.f')", '    return object'] },
  { name: 'nested-class', run: true, pre: ['class f:', "    def __init__(self): LOG.append('run.f')"] },
  { name: 'comprehension-variable', run: true, pre: ['[0 for f in [0]]'] },
  { name: 'match-capture', run: true, wrap: (body) => inBlock('match 0:\n    case f:', body, 8) },
  { name: 'match-as', run: true, wrap: (body) => inBlock('match 0:\n    case 0 as f:', body, 8) },
  { name: 'match-sequence', run: true, wrap: (body) => inBlock('match [0]:\n    case [f]:', body, 8) },
  { name: 'match-mapping', run: true, wrap: (body) => inBlock("match {'k': 0}:\n    case {'k': f}:", body, 8) },
  { name: 'match-class', run: true, wrap: (body) => inBlock('match Box(0):\n    case Box(f):', body, 8) },
  { name: 'match-class-keyword', run: true, wrap: (body) => inBlock('match Box(0):\n    case Box(x=f):', body, 8) },
  { name: 'del', run: true, module: true, pre: ["f = mk('del')", 'del f'] },
  // Only the module-level class header site runs in the module block; a class body or method runs at the class
  // statement or later, so a module binding after it is not "after the site in the same block".
  { name: 'bind-after', run: true, module: true, modulePositions: ['module-class-base'], post: ["f = mk('after')"] },
  { name: 'type-params', run: true, typeParams: '[f]' },
  { name: 'type-alias', run: true, module: true, pre: ['type f = int'] },
  { name: 'class-body-before', run: true, module: true, classBinding: 'before' },
  { name: 'class-body-after', run: true, module: true, classBinding: 'after' },
  // The lambda wraps the site wherever it sits, so a lazy PEP 649 annotation sees its parameter shadow the name.
  { name: 'lambda-param', run: true, module: true, lambdaParam: true },
  // The gates: a class-body `class f`/`def f` a class-body call can resolve to, in the branches and loops that decide
  // whether it exists at the call and whether a later iteration reaches something else.
  ...(['class', 'def'] as const).flatMap((shape) =>
    (['before', 'after', 'if-false', 'try-raised', 'rebind-after', 'loop-rebind', 'while-del'] as const).map((placement) => ({
      name: `classbody-${shape}-${placement}`,
      run: true,
      classSiteOnly: true,
      classPlan: classSite(shape, placement),
    })),
  ),
  // Function-scope flow: a dead assignment still makes the name local; a loop rebinds or deletes it after the site.
  { name: 'flow-if-false', run: true, pre: ['if False:', "    f = mk('run.if-false')"] },
  { name: 'flow-try-raised', run: true, pre: ['try:', '    raise ValueError', "    f = mk('run.try-raised')", 'except ValueError:', '    pass'] },
  { name: 'flow-loop-rebind', run: true, pre: ["f = mk('run.first')"], wrap: (body) => `for _i in range(2):\n${indent(body)}\n    f = mk('run.loop')` },
  { name: 'flow-loop-del', run: true, pre: ["f = mk('run.first')", '_i = 0'], wrap: (body) => `while _i < 2:\n${indent(joined([body, 'del f', '_i += 1']))}` },
  // The reader's remaining binding constructs.
  { name: 'except-star-target', run: true, module: true, pre: ['try:', "    raise ExceptionGroup('e', [ValueError()])", 'except* ValueError as f:', '    pass'] },
  { name: 'match-star-sequence', run: true, wrap: (body) => inBlock('match (0,):\n    case [*f]:', body, 8) },
  { name: 'match-mapping-rest', run: true, wrap: (body) => inBlock("match {'k': 0}:\n    case {**f}:", body, 8) },
  { name: 'walrus-comprehension', run: true, pre: ["[(f := mk('walrus-comp')) for _x in [0]]"] },
  { name: 'annotation-only', run: true, pre: ['f: int'] },
  { name: 'class-type-params', run: true, module: true, classPlan: () => ({ typeParam: true }) },
  { name: 'class-global', run: true, module: true, classPlan: () => ({ pre: ['global f'] }) },
  { name: 'class-nonlocal', run: true, nest: 'nonlocal', classPlan: () => ({ pre: ['nonlocal f'] }) },
];

interface Wrapper {
  name: string;
  apply: Wrap;
}

const WRAPPERS: readonly Wrapper[] = [
  { name: 'none', apply: (statement) => statement },
  { name: 'if', apply: (statement) => inBlock('if True:', statement) },
  { name: 'try', apply: (statement) => `try:\n${indent(statement)}\nexcept Exception:\n    raise` },
  { name: 'for', apply: (statement) => inBlock('for _w in [0]:', statement) },
  { name: 'with', apply: (statement) => inBlock("with _Mark('w'):", statement) },
  { name: 'while', apply: (statement) => `while True:\n${indent(statement)}\n    break` },
  { name: 'match', apply: (statement) => `match 0:\n    case _:\n${indent(statement, 8)}` },
];

/** Whether a construct means anything at a position: documented skips, never a skip for an outcome core gets wrong. */
function applies(construct: Construct, position: Position): boolean {
  if (construct.syntax) return position.name === 'function';
  if (position.module) {
    if (construct.modulePositions) return construct.modulePositions.includes(position.name);
    if (!construct.module) return false;
  } else if (!construct.run) return false;
  if (construct.classPlan && !position.classBody) return false;
  if (construct.classSiteOnly && !position.classCandidates) return false;
  // A class-body binding needs a class body to sit in; a class header has none.
  return !construct.classBinding || position.classBody === true;
}

/** The one call site: a sentinel tuple whose second element is the call, so an error is told from a site never reached. */
function siteOf(construct: Construct): string {
  const call = construct.lambdaParam ? "(lambda f: f())(mk('param'))" : 'f()';
  return `(LOG.append('${SITE_TAG}'), ${call})[1]`;
}

function textOf(construct: Construct, position: Position, wrapper: Wrapper): string {
  const tag = position.module ? 'K' : 'run.K';
  const plan = construct.classPlan?.(tag);
  const classPre = [...(construct.classBinding === 'before' ? ["f = mk('K.body')"] : []), ...(plan?.pre ?? [])];
  const classPost = [...(construct.classBinding === 'after' ? ["f = mk('K.body')"] : []), ...(plan?.post ?? [])];
  const classHead = plan?.typeParam ? 'class K[f]:' : 'class K:';
  const code = position.build({ site: siteOf(construct), wrap: wrapper.apply, classPre, classPost, classHead, classWrap: plan?.wrap });
  const positioned = construct.wrap ? construct.wrap(code) : code;
  const body = joined([...(construct.pre ?? []), positioned, ...(construct.post ?? [])]);
  if (position.module) return `${joined([PRELUDE, ...(construct.outer ?? []), body])}\n`;
  const signature = `def run${construct.typeParams ?? ''}(${construct.params ?? ''}):`;
  if (construct.nest) {
    const binding = construct.nest === 'nonlocal' ? "f = mk('nonlocal')" : "f = mk('closure')";
    return `${joined([PRELUDE, ...(construct.outer ?? []), 'def outside():', indent(joined([binding, signature, indent(body), 'run()'])), 'outside()'])}\n`;
  }
  return `${joined([PRELUDE, ...(construct.outer ?? []), signature, indent(body), construct.call ?? 'run()'])}\n`;
}

/** Every program, in construct × position × wrapper order; deterministic, so ids and hashes are stable. */
export function programs(): Program[] {
  const out: Program[] = [];
  for (const construct of CONSTRUCTS) {
    for (const position of POSITIONS) {
      if (!applies(construct, position)) continue;
      for (const wrapper of WRAPPERS) {
        // The in-function star import is one compile error wherever the site sits; one program proves the exclusion.
        if (construct.syntax && wrapper.name !== 'none') continue;
        out.push({
          id: `${construct.name}.${position.name}.${wrapper.name}`,
          text: textOf(construct, position, wrapper),
          b: B,
          construct: construct.name,
          position: position.name,
          wrapper: wrapper.name,
        });
      }
    }
  }
  return out;
}

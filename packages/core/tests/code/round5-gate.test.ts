import { describe, expect, it } from 'vitest';
import { linkFiles } from './scope-helpers.js';

/**
 * COD-59 round 5, the owner's decision on unannotated locals: a computed write on a local bound once to a fresh
 * `{}`, `[]`, `new Map()`/`Set`/`WeakMap`/`WeakSet`, `Object.create(null)` or `Object.assign({} | [], …)`, and never
 * reassigned, writes that object's own elements and rebinds no class method. A computed key can be `"__proto__"`, so
 * the write stays exempt only when its key cannot be `"__proto__"` or its value cannot carry a class prototype.
 * Every expectation is name-only (`to` undefined) unless the runtime reaches the symbol core names.
 * Oracle: node 25.3 (`node a.js`); the printed result is in the comment above each.
 */

/** Every call named `name` in `path`, as its resolved target or undefined for name-only. */
const targets = async (tree: Record<string, string>, path: string, name = 'f'): Promise<(string | undefined)[]> => {
  const files = await linkFiles(tree);
  return (files.get(path)?.calls ?? []).filter((call) => call.name === name).map((call) => call.to);
};

const K = 'class K {\n  f() { return "K.f"; }\n  m() { return this.f(); }\n}\n';

/** A local bound to `init`, written through a computed key with a primitive value; the driver never touches a K. */
const local = (decl: string, init: string): string => `${K}${decl} o = ${init};\nfunction put(k) { o[k] = 1; }\nput("f");\nconsole.log(new K().m());\n`;

describe('round 5: a computed write on a fresh local rebinds no class method', () => {
  it.each([
    // Precision: sound refinement, COD-59 round 5 (owner's decision: infer from the initializer)
    // Each form: node 25 prints "K.f".
    ['const {}', local('const', '{}')],
    ['const []', local('const', '[]')],
    ['const new Map()', local('const', 'new Map()')],
    ['const new Set()', local('const', 'new Set()')],
    ['const new WeakMap()', local('const', 'new WeakMap()')],
    ['const new WeakSet()', local('const', 'new WeakSet()')],
    ['const Object.create(null)', local('const', 'Object.create(null)')],
    ['const Object.assign({}, …)', local('const', 'Object.assign({}, { a: 1 })')],
    ['const Object.assign([], …)', local('const', 'Object.assign([], [1])')],
    ['let never reassigned', local('let', '{}')],
    ['var never reassigned', local('var', '{}')],
    ['any value under a numeric key', `${K}const o = [];\nfunction put(v) { o[0] = v; }\nput(new K());\nconsole.log(new K().m());\n`],
    ['any value under a key with a constant prefix', `${K}const o = {};\nfunction put(id, v) { o[\`k_\${id}\`] = v; }\nput(1, new K());\nconsole.log(new K().m());\n`],
    ['a function value under any key', `${K}const o = new Map();\nfunction put(k) { o[k] = () => "g"; }\nput("f");\nconsole.log(new K().m());\n`],
  ])('exempt: %s', async (_form, src) => {
    expect(await targets({ 'a.js': src }, 'a.js')).toEqual(['a.js::K.f::method']);
  });

  it.each([
    // Each form: node 25 prints "g".
    ['a reassigned let', `${K}let o = {};\no = new K();\nfunction put(k) { o[k] = () => "g"; }\nput("f");\nconsole.log(o.m());\n`],
    ['a var declared twice', `${K}var o = {};\nvar o = new K();\nfunction put(k) { o[k] = () => "g"; }\nput("f");\nconsole.log(o.m());\n`],
    ['a literal with a __proto__ key', `${K}const o = { __proto__: K.prototype };\nfunction put(k) { o[k] = () => "g"; }\nput("f");\nconsole.log(o.m());\n`],
    ['a non-literal Object.assign target', `${K}const t = new K();\nconst o = Object.assign(t, {});\nfunction put(k) { o[k] = () => "g"; }\nput("f");\nconsole.log(o.m());\n`],
    ['a local Map that is a class', `${K}const Map = K;\nconst o = new Map();\nfunction put(k) { o[k] = () => "g"; }\nput("f");\nconsole.log(o.m());\n`],
    ['a const {} given a K prototype through a computed key', `${K}const o = {};\nfunction put(k, v) { o[k] = v; }\nput("__proto__", new K());\nput("f", () => "g");\nconsole.log(o.m());\n`],
    ['a new Map() given a K prototype through a computed key', `${K}const o = new Map();\nfunction put(k, v) { o[k] = v; }\nput("__proto__", new K());\nput("f", () => "g");\nconsole.log(o.m());\n`],
    // Object.assign sets the target's prototype from a source's own "__proto__" property.
    ['Object.assign onto {} from a source with an own __proto__ key', `${K}function merge(a, b) { return Object.assign({}, a, b); }\nconst o = merge({ ["__proto__"]: new K() }, { f: () => "g" });\nconsole.log(o.m());\n`],
    ['a local from Object.assign({}, …) whose source comes from Object.fromEntries', `${K}const src = Object.fromEntries([["__proto__", new K()]]);\nconst o = Object.assign({}, src);\nfunction put(k) { o[k] = () => "g"; }\nput("f");\nconsole.log(o.m());\n`],
  ])('not exempt: %s', async (_form, src) => {
    expect(await targets({ 'a.js': src }, 'a.js')).toEqual([undefined]);
  });
});

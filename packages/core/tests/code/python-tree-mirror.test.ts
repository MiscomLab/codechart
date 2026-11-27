import { describe, expect, it } from 'vitest';
import { loadGrammar } from '../../src/code/grammars.js';
import { mirrorTree } from '../../src/code/python/py-tree.js';

/** The spec is web-tree-sitter itself: the mirror must equal its tree, node by node, anonymous nodes included. */

const SOURCES: Record<string, string> = {
  'broken under not in': 'import importlib\ny = importlib.import_module("m", a not 1 in b)\n',
  'missing in under not in': 'import importlib\ny = importlib.import_module("m", a is 1 not b)\n',
  'is not beside errors': 'y = f("m", a is not 1 not 2 b)\nz = f(a is is not b)\n',
  'broken defs': 'def f(:\n  pass\nclass (\n x = [1, 2\n',
  'bad indent': 'if x:\npass\n',
  'py2 print': 'print "hi"\nexec "x"\n',
  'valid not in / is not': 'x = a not in b\ny = a is not b\nz = not a\n',
  crlf: 'x = "é"\r\nclass K:\r\n    def f(self): return 1\r\n',
  'lone cr and form feed': 'a = 1\rb = 2\n\fdef g(): pass\n',
  bom: '\uFEFFdef f(): pass\n',
  'non-BMP text': 'x = "é😀"; y = f(x)\ns = """\n😀é\n"""\n',
  nul: 'x = 1\0\ny = 2\n',
  match: 'match x:\n    case 1: pass\n    case [a, *b] if a: pass\n    case {"k": v}: pass\n    case _: pass\n',
  'f-strings': 's = f"{a!r:>{w}} 😀 {b:{c}.{d}}"\nt = f"{x=}"\n',
  'decorators and type params': '@d\nclass K[T](B, metaclass=M): pass\n@e(1)\ndef g[**P, *Ts](a, /, b, *, c): ...\ntype X[T] = list[T]\nlambda: (yield)\n',
  // The MISSING token is a hidden newline the cursor never visits, so only the real flags of `block` and `module` show it.
  'error in a hidden token': 'match x\n  case 1: pass\nfrom m import f\n',
  // An ERROR node whose children carry fields (`subscript`, `operators`): tree-sitter still finds none of them by field.
  'fields under an ERROR': 'x[ = a,[1]\n',
  'operators under an ERROR': 'x == a[1]in\n',
  'deep nesting': `x = ${'['.repeat(3000)}${']'.repeat(3000)}\n`,
  'deep nesting with an error at the bottom': `x = ${'['.repeat(3000)}1 2${']'.repeat(3000)}\ny = 1\n`,
};

describe('mirrorTree equals the web-tree-sitter tree', () => {
  for (const [name, text] of Object.entries(SOURCES)) {
    it(name, async () => {
      const { parser } = await loadGrammar('python');
      const lang = parser.language!;
      const fields: string[] = [];
      for (let i = 1; i <= lang.fieldCount; i++) {
        const field = lang.fieldNameForId(i);
        if (field) fields.push(field);
      }
      const tree = parser.parse(text)!;
      try {
        const { root, byId } = mirrorTree(tree, text);
        expect(root.id).toBe(tree.rootNode.id);
        const diffs: string[] = [];
        const stack = [tree.rootNode];
        let count = 0;
        while (stack.length) {
          const real = stack.pop()!;
          count++;
          const where = `${real.type}@${real.startPosition.row}:${real.startPosition.column}`;
          const mirror = byId.get(real.id);
          if (!mirror) {
            diffs.push(`${where} is not mirrored`);
          } else {
            const check = (what: string, expected: unknown, actual: unknown) => {
              if (JSON.stringify(expected) !== JSON.stringify(actual)) diffs.push(`${where} ${what}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
            };
            check('type', real.type, mirror.type);
            check('text', real.text, mirror.text);
            check('start', real.startPosition, mirror.startPosition);
            check('end', real.endPosition, mirror.endPosition);
            check('parent', real.parent?.id ?? null, mirror.parent?.id ?? null);
            check('namedChildren', real.namedChildren.map((c) => c!.id), mirror.namedChildren.map((c) => c.id));
            check('hasError', real.hasError, mirror.hasError);
            for (const field of fields) {
              // Documented difference in py-tree.ts: the mirror's single-child lookup for this one field.
              if (real.type === 'match_statement' && field === 'alternative') continue;
              check(`field ${field}`, real.childForFieldName(field)?.id ?? null, mirror.childForFieldName(field)?.id ?? null);
              check(`fields ${field}`, real.childrenForFieldName(field).map((c) => c!.id), mirror.childrenForFieldName(field).map((c) => c.id));
            }
          }
          for (const child of real.children) stack.push(child!);
        }
        expect(count).toBeGreaterThan(1);
        expect(diffs.slice(0, 20)).toEqual([]);
      } finally {
        tree.delete();
      }
    });
  }
});

import { describe, expect, it } from 'vitest';
import { withoutComments } from '../../src/render/comments.js';

// Each comment becomes one space plus the line breaks it spanned, so line numbers and word gaps survive.
describe('withoutComments: C-style languages', () => {
  it.each([
    ['a line comment', 'a.ts', 'a // b\nc', 'a  \nc'],
    ['a block comment across lines', 'a.ts', 'a /* b\nb */ c', 'a  \n c'],
    ['markers inside strings', 'a.ts', 'const u = "http://x"; const s = \'// y\';', 'const u = "http://x"; const s = \'// y\';'],
    ['a URL in JSX text', 'a.tsx', '<p>See https://x/order</p>', '<p>See https://x/order</p>'],
    ['a template literal across lines', 'a.ts', 'const q = `a\n// b`;', 'const q = `a\n// b`;'],
    ['a regex quote ends at its line', 'a.ts', 's.replace(/\'/g, "")\n// c\nimport x from "./order"', 's.replace(/\'/g, "")\n \nimport x from "./order"'],
    ['an unterminated block comment', 'a.ts', 'a /* b\nc', 'a /* b\nc'],
    ['CRLF line ends', 'a.ts', '// c\r\nimport "./order"', ' \nimport "./order"'],
    ['Go', 'a.go', 'import "x/order" // y\nvar r = \'/\'\n/* z */', 'import "x/order"  \nvar r = \'/\'\n '],
    ['a Rust lifetime next to a string', 'a.rs', 'fn f<\'a>(x: &\'a str) { g("src/*") }\nlet order = 1;', 'fn f<\'a>(x: &\'a str) { g("src/*") }\nlet order = 1;'],
    ['C++ digit separators and #include', 'a.cpp', 'int n = 1\'000; // order\n#include "order.h"', 'int n = 1\'000;  \n#include "order.h"'],
    ['a C# verbatim string', 'a.cs', 'var p = @"C:\\dir\\"; // order', 'var p = @"C:\\dir\\";  '],
    ['a doubled quote inside a C# verbatim string', 'a.cs', 'var s = @"x"" \\" // c";', 'var s = @"x"" \\"  '],
    ['an escaped slash then * in a regex', 'a.ts', 's.replace(/\\/*$/, "");\nfetchOrder();\n/** doc */\nexport const z = 1;', 's.replace(/\\/*$/, "");\nfetchOrder();\n \nexport const z = 1;'],
    ['escaped slashes in a URL regex', 'a.ts', 'const u = /^https?:\\/\\//.test(s) && fetchOrder(s);', 'const u = /^https?:\\/\\//.test(s) && fetchOrder(s);'],
    ['a Java char literal holding a quote', 'A.java', 'char c = \'"\'; // order\nx();', 'char c = \'"\';  \nx();'],
    ['a Go rune holding a quote', 'a.go', 'r := \'"\' // order', 'r := \'"\'  '],
    ['a Rust raw string', 'a.rs', 'let s = r#"a " // b"#; order(); // c', 'let s = r#"a " // b"#; order();  '],
  ])('%s', (_, path, text, expected) => {
    expect(withoutComments(path, text)).toBe(expected);
  });
});

describe('withoutComments: Python', () => {
  it('drops # comments, keeps # in strings', () => {
    expect(withoutComments('a.py', 'x = 1  # order\ny = "#fff"')).toBe('x = 1   \ny = "#fff"');
  });

  it('drops module, class and method docstrings, keeps a returned string', () => {
    const text = '#!/usr/bin/env python\n"""Module order."""\nclass A:\n    """Class order."""\n    def f(self):\n        """Method\n        order."""\n        return """kept"""\n';
    expect(withoutComments('a.py', text)).toBe(' \n \nclass A:\n     \n    def f(self):\n         \n\n        return """kept"""\n');
  });

  it('keeps a triple-quoted call argument on its own line', () => {
    const text = 'cur.execute(\n    """SELECT * FROM orders"""\n)';
    expect(withoutComments('a.py', text)).toBe(text);
  });

  it('reads string prefixes', () => {
    expect(withoutComments('a.py', 'q = f"""{a}\n# x"""\nr\'\'\'doc\'\'\'\nb = rb"#"')).toBe('q = f"""{a}\n# x"""\n \nb = rb"#"');
  });

  it.each([
    ['a string annotation', 'class A:\n    customer: "Customer" = None'],
    ['a lambda body', 'f = lambda: "orders_table"'],
    ['a dict value', 'd = {"a": "orders"}'],
  ])('keeps %s', (_, text) => {
    expect(withoutComments('a.py', text)).toBe(text);
  });

  it('drops a bare string after ;', () => {
    expect(withoutComments('a.py', 'x = 1; "order"')).toBe('x = 1;  ');
  });

  it('keeps a string after a line continuation', () => {
    const text = 'x = \\\n    """kept"""';
    expect(withoutComments('a.py', text)).toBe(text);
  });
});

describe('withoutComments: other languages', () => {
  it.each([
    ['shell: # only at a word start', 'a.sh', 'n=${#items[@]} a#b $#\necho hi # order', 'n=${#items[@]} a#b $#\necho hi  '],
    ['Ruby', 'a.rb', 'x = "#{order}" # order\n', 'x = "#{order}"  \n'],
    ['PHP: an attribute is code', 'a.php', '#[ORM\\Entity(repositoryClass: OrderRepository::class)]\n# order\n// order\n$u = "http://x";', '#[ORM\\Entity(repositoryClass: OrderRepository::class)]\n \n \n$u = "http://x";'],
    ['SQL', 'a.sql', "SELECT '--x' FROM t -- orders\n/* orders */", "SELECT '--x' FROM t  \n "],
    ['SQL: a doubled quote stays in the string', 'a.sql', "SELECT 'a'' -- x' FROM t", "SELECT 'a'' -- x' FROM t"],
    ['SQL: a doubled quote at a string end', 'a.sql', "SELECT 'a''' -- x", "SELECT 'a'''  "],
    ['Ruby =begin/=end', 'a.rb', '=begin\norder\n=end\nx = 1', ' \n\n\nx = 1'],
    ['Ruby: =endless does not end a block', 'a.rb', '=begin\na\n=endless\nb\n=end\nc', ' \n\n\n\n\nc'],
    ['Ruby: =begin only at a line start', 'a.rb', 'x = 1 =begin\norder\n=end\n', 'x = 1 =begin\norder\n=end\n'],
    ['SCSS // comments, not a url()', 'a.scss', 'a { color: red; // order\n  b: url(http://x/order.png); }', 'a { color: red;  \n  b: url(http://x/order.png); }'],
    ['Terraform', 'a.tf', 'a = "x#y" # order\nb = 1 // order\n/* order */', 'a = "x#y"  \nb = 1  \n '],
    ['Lua long brackets', 'a.lua', 'x = 1 --[==[ order\n]] still ]==] y -- order', 'x = 1  \n y  '],
    ['Haskell nested comments', 'a.hs', 'a {- x {- y -} order -} b', 'a   b'],
    ['Markdown: an apostrophe is prose', 'a.md', "Don't <!-- order --> go", "Don't   go"],
    ['Vue: HTML and script comments', 'a.vue', '<template><!-- order --></template>\n<script>\n// import x from "./order"\n</script>', '<template> </template>\n<script>\n \n</script>'],
    ['Dockerfile', 'Dockerfile', 'FROM node\n# order', 'FROM node\n '],
    ['an upper-case extension', 'A.PY', '# order', ' '],
    ['an unknown extension is left as it is', 'a.txt', '# order // x', '# order // x'],
  ])('%s', (_, path, text, expected) => {
    expect(withoutComments(path, text)).toBe(expected);
  });
});

describe('withoutComments: YAML and Helm templates', () => {
  it('drops # comments at a word start, outside quoted scalars', () => {
    const text = 'a: "#fff" # order\nb: a#b\nnote: don\'t # templates/_helpers.tpl\n# order\n';
    expect(withoutComments('a.yaml', text)).toBe('a: "#fff"  \nb: a#b\nnote: don\'t  \n \n');
  });

  it('keeps a block scalar as content', () => {
    expect(withoutComments('a.yml', 'run: |\n  # keep\n  ./deploy.sh\nname: x # order\n')).toBe('run: |\n  # keep\n  ./deploy.sh\nname: x  \n');
    expect(withoutComments('a.yml', '- run: |\n    # keep\n  name: x # drop')).toBe('- run: |\n    # keep\n  name: x  ');
  });

  it('keeps a double-quoted scalar across lines', () => {
    const text = 'a: "x\n  # kept"\n';
    expect(withoutComments('a.yaml', text)).toBe(text);
  });

  it('drops template comments, keeps a # inside an action', () => {
    const text = '{{/* order */}}\n{{- /* a\nb */ -}}\nx: {{ include "a#b" . }} # order\n';
    expect(withoutComments('templates/t.yaml', text)).toBe(' \n \n\nx: {{ include "a#b" . }}  \n');
  });

  it('keeps a quote and # inside an action whole', () => {
    expect(withoutComments('t.yaml', 'x: {{ .Values.a | default " #1" }} # order')).toBe('x: {{ .Values.a | default " #1" }}  ');
  });

  it('reads a .tpl file the same way', () => {
    expect(withoutComments('templates/_helpers.tpl', '{{/* order */}}\n# x\n{{- define "a" -}}')).toBe(' \n \n{{- define "a" -}}');
  });
});

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
    ['a regex holding /*', 'a.ts', 'const re = /[/*]/;\nimport { send } from "./mailer";\n/** note */', 'const re = /[/*]/;\nimport { send } from "./mailer";\n '],
    ['a regex after return', 'a.ts', 'return /[/*]/.test(s) && send();\n/* c */', 'return /[/*]/.test(s) && send();\n '],
    ['a regex holding a quote', 'a.ts', 'x = s.replace(/"/g, "") // c', 'x = s.replace(/"/g, "")  '],
    ['a slash inside a regex class', 'a.ts', 'const re = /[a/b/*]/;\nimport { x } from "./order";\n/** d */', 'const re = /[a/b/*]/;\nimport { x } from "./order";\n '],
    ['a regex after &&', 'a.ts', 'x && /[/*]/.test(s)\n/** d */', 'x && /[/*]/.test(s)\n '],
    ['a regex after :', 'a.ts', 'y = c ? a : /[/*]/\n/** d */', 'y = c ? a : /[/*]/\n '],
    ['a regex after !', 'a.ts', 'z = !/[/*]/.test(s)\n/** d */', 'z = !/[/*]/.test(s)\n '],
    ['a regex at the file start', 'a.ts', '/[/*]/.test(s)\n/** d */', '/[/*]/.test(s)\n '],
    ['a regex on the line after {', 'a.ts', 'if (x) {\n  /[/*]/.test(s)\n}\n/** d */', 'if (x) {\n  /[/*]/.test(s)\n}\n '],
    ['a / starting a line after an operand divides', 'a.ts', 'a = b\n/ c /* d */', 'a = b\n/ c  '],
    ['an escaped slash ends no regex', 'a.ts', 'const r = /\\/[/*]/;\n/** d */', 'const r = /\\/[/*]/;\n '],
    ['division after a postfix ++', 'a.ts', 'const ratio = count++ / total; /* mailer */', 'const ratio = count++ / total;  '],
    ['division after a postfix --', 'a.ts', 'x = i-- / 2 // c', 'x = i-- / 2  '],
    ['division is not a regex', 'a.ts', 'a = b / c /* x */ / d', 'a = b / c   / d'],
    ['a comment inside ${}', 'a.ts', 'const s = `${ /* mailer */ value }`;', 'const s = `${   value }`;'],
    ['template text after ${}', 'a.ts', 'x = `${a} // keep` + order()', 'x = `${a} // keep` + order()'],
    ['an object literal in ${}', 'a.ts', 'x = `${ {k: 1}.k } // keep`', 'x = `${ {k: 1}.k } // keep`'],
    ['a comment after an object literal in ${}', 'a.ts', 'x = `${ {k: 1}.k /* c */ }`', 'x = `${ {k: 1}.k   }`'],
    ['an escaped ${ opens no code', 'a.ts', 'x = `\\${ /* keep */ }`', 'x = `\\${ /* keep */ }`'],
    ['an escaped ${', 'a.ts', 'x = `\\${x} // keep`', 'x = `\\${x} // keep`'],
    ['a template literal nested in ${}', 'a.ts', 'x = `${`in ${x} // keep`}`', 'x = `${`in ${x} // keep`}`'],
    ['a template literal: braces, strings and nesting in ${}', 'a.ts', 'x = `a ${ f("}", `b ${c}`) } // lit`; // c', 'x = `a ${ f("}", `b ${c}`) } // lit`;  '],
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

  it.each([
    ['an f-string call', 'f"{mailer.send()}"'],
    ['an rf-string', 'rf"{mailer}"'],
  ])('keeps %s at a statement start: it runs', (_, text) => {
    expect(withoutComments('a.py', text)).toBe(text);
  });

  it('drops a docstring on the def or class line', () => {
    expect(withoutComments('a.py', 'def send(): "Uses mailer"\nclass A: \'doc\'')).toBe('def send():  \nclass A:  ');
  });

  it.each([
    ['match', 'match: "Order" = None'],
    ['case', 'case: "Order" = None'],
  ])('keeps an annotation on a variable named %s', (_, text) => {
    expect(withoutComments('a.py', text)).toBe(text);
  });

  it('drops a string on a case line', () => {
    expect(withoutComments('a.py', 'match x:\n    case 1: "order"')).toBe('match x:\n    case 1:  ');
  });

  it('drops a docstring after a match header', () => {
    expect(withoutComments('a.py', 'match x:\n    """doc"""')).toBe('match x:\n     ');
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
    ['Ruby: # right after code', 'a.rb', 'value = 1# mailer', 'value = 1 '],
    ['Ruby: # in a regex', 'a.rb', 'id = s[/#(\\d+)/, 1]; Order.find(id)\nx =~ /#{q}/ # c', 'id = s[/#(\\d+)/, 1]; Order.find(id)\nx =~ /#{q}/  '],
    ['Ruby: a regex after when', 'a.rb', 'case s\nwhen /#{pat}/ then Order.find(id)\nend', 'case s\nwhen /#{pat}/ then Order.find(id)\nend'],
    ['Ruby: a regex after if', 'a.rb', 'x = 1 if /#\\d/ =~ s; Order.new', 'x = 1 if /#\\d/ =~ s; Order.new'],
    ['Ruby: an escaped bracket in a %w[] literal', 'a.rb', 'w = %w[a\\] #b] # c', 'w = %w[a\\] #b]  '],
    ['JS: or is a name, so / after it divides', 'a.ts', 'y = or / 2; // c', 'y = or / 2;  '],
    ['Ruby: nested brackets in a %w[] literal', 'a.rb', 'w = %w[a[b]#mailer] # c', 'w = %w[a[b]#mailer]  '],
    ['Ruby: a ?# character', 'a.rb', 'c = ?#; Order.find(1)', 'c = ?#; Order.find(1)'],
    ['Ruby: # in a %w[] literal', 'a.rb', 'w = %w[a#b]; Order.new', 'w = %w[a#b]; Order.new'],
    ['TOML: # right after code, multi-line strings', 'a.toml', 'v = 1# c\na = """\n# mailer\n"""\nb = \'\'\'\n# x\n\'\'\' # c', 'v = 1 \na = """\n# mailer\n"""\nb = \'\'\'\n# x\n\'\'\'  '],
    ['GraphQL: block strings, # after }', 'a.graphql', '"""\n# mailer\n"""\ntype A { b: Int }# c', '"""\n# mailer\n"""\ntype A { b: Int } '],
    ['R', 'a.r', 'x <- 1# c', 'x <- 1 '],
    ['Makefile', 'Makefile', 'a: b# c', 'a: b '],
    ['Makefile: a space-indented line is not a recipe', 'Makefile', '  X := a#b', '  X := a '],
    ['Makefile: an escaped \\#', 'Makefile', 'SCRIPT := tools/\\#mailer.sh # c', 'SCRIPT := tools/\\#mailer.sh  '],
    ['Makefile: a recipe line is shell', 'Makefile', 'all:\n\tcurl http://x/#frag && ./order.sh # c', 'all:\n\tcurl http://x/#frag && ./order.sh  '],
    ['Lua long strings', 'a.lua', 'local t = [[-- mailer]] -- c\nlocal u = [==[ ]] -- x ]==]', 'local t = [[-- mailer]]  \nlocal u = [==[ ]] -- x ]==]'],
    ['PostgreSQL dollar quotes', 'a.sql', 'SELECT $$--mailer$$; -- c\nSELECT $fn$ /* x */ $fn$;', 'SELECT $$--mailer$$;  \nSELECT $fn$ /* x */ $fn$;'],
    ['Ruby =begin/=end', 'a.rb', '=begin\norder\n=end\nx = 1', ' \n\n\nx = 1'],
    ['Ruby: =endless does not end a block', 'a.rb', '=begin\na\n=endless\nb\n=end\nc', ' \n\n\n\n\nc'],
    ['Ruby: =begin only at a line start', 'a.rb', 'x = 1 =begin\norder\n=end\n', 'x = 1 =begin\norder\n=end\n'],
    ['SCSS // comments, not a url()', 'a.scss', 'a { color: red; // order\n  b: url(http://x/order.png); }', 'a { color: red;  \n  b: url(http://x/order.png); }'],
    ['Terraform', 'a.tf', 'a = "x#y" # order\nb = 1 // order\n/* order */', 'a = "x#y"  \nb = 1  \n '],
    ['Lua long brackets', 'a.lua', 'x = 1 --[==[ order\n]] still ]==] y -- order', 'x = 1  \n y  '],
    ['Haskell nested comments', 'a.hs', 'a {- x {- y -} order -} b', 'a   b'],
    ['Markdown: an apostrophe is prose', 'a.md', "Don't <!-- order --> go", "Don't   go"],
    ['Vue: template literal text', 'a.vue', '<script>\nconst s = `a // keep`\n</script>', '<script>\nconst s = `a // keep`\n</script>'],
    ['Vue: a comment inside ${}', 'a.vue', '<script>\nconst s = `${ /* c */ order }`\n</script>', '<script>\nconst s = `${   order }`\n</script>'],
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

  it('reads an explicit block indent', () => {
    expect(withoutComments('a.yaml', 'text: |2\n    first\n  # mailer\nnext: 1 # c')).toBe('text: |2\n    first\n  # mailer\nnext: 1  ');
    expect(withoutComments('a.yaml', '- run: |1\n   x\n  # c')).toBe('- run: |1\n   x\n   ');
  });

  it('keeps a quoted scalar after an anchor or tag', () => {
    const text = 'a: &shared "see # mailer"\nb: !!str "x # y"\n- &a \'z # w\'';
    expect(withoutComments('a.yaml', text)).toBe(text);
  });

  it('ends an action at }} outside its strings', () => {
    expect(withoutComments('templates/t.yaml', 'x: {{ list "}} #a" }} # c')).toBe('x: {{ list "}} #a" }}  ');
  });

  it('keeps {{/* */}} in plain YAML outside a chart\'s templates/', () => {
    const text = 'example: "{{/* mailer */}}"\n';
    expect(withoutComments('config/app.yaml', text)).toBe(text);
    expect(withoutComments('chart/templates/app.yaml', text)).toBe('example: " "\n');
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

  it('reads a .tpl file as a template outside templates/ too, and only a folder named templates', () => {
    expect(withoutComments('helpers/_x.tpl', '{{/* c */}}')).toBe(' ');
    expect(withoutComments('mytemplates/a.yaml', 'a: "{{/* c */}}"')).toBe('a: "{{/* c */}}"');
  });

  it('reads a .tpl file the same way', () => {
    expect(withoutComments('templates/_helpers.tpl', '{{/* order */}}\n# x\n{{- define "a" -}}')).toBe(' \n \n{{- define "a" -}}');
  });
});

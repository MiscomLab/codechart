import { describe, expect, it } from 'vitest';
import { linkFiles, results } from './scope-helpers.js';

/**
 * COD-59: `self.f()` in `class L(K)` where L binds no `f`. Oracle: CPython 3.14 (`PYTHONPATH=. python3 a.py` in a scratch dir, one file
 * per scenario; `python3 -m pkg.a` for the relative import); each output is in its test's comment. Core's `to` is exactly what
 * CPython ran when it proves that, otherwise name-only (`undefined`): an arrow to a method CPython does not run is wrong.
 */

const run = async (tree: Record<string, string>, path = 'a.py'): Promise<(string | undefined)[]> => results(await linkFiles(tree), 'f', path);

describe('Python: self.f() inherited from the local base K', () => {
  it("plain base: L().g() runs K.f", async () => {
    // CPython: prints `K.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual(['a.py::K.f::method']);
  });

  it("two levels, M(L) calling self.f() with f on K: stays name-only (one base hop only)", async () => {
    // CPython: prints `K.f` (core proves one hop only, so name-only is the safe answer).
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    pass\nclass M(L):\n    def g(self): return self.f()\nprint(M().g())\n"})).toEqual([undefined]);
  });

  it("a subclass M(L) overrides f: M().g() reaches M.f, not K.f (same rule as K.f called from K with an overriding subclass)", async () => {
    // CPython: prints `M.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nclass M(L):\n    def f(self): return \"M.f\"\nprint(M().g())\n"})).toEqual([undefined]);
  });

  it("L.__init__ writes self.f", async () => {
    // CPython: prints `inst`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def __init__(self): self.f = lambda: \"inst\"\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K.__init__ writes self.f", async () => {
    // CPython: prints `inst`.
    expect(await run({"a.py": "class K:\n    def __init__(self): self.f = lambda: \"inst\"\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("L.f = \u2026 after the class", async () => {
    // CPython: prints `L.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nL.f = lambda self: \"L.f\"\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("setattr(L, \"f\", \u2026)", async () => {
    // CPython: prints `set`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nsetattr(L, \"f\", lambda self: \"set\")\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("del K.f then K.f = other", async () => {
    // CPython: prints `x`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\ndel K.f\nK.f = lambda self: \"x\"\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K.f = other after the classes", async () => {
    // CPython: prints `other`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nK.f = lambda self: \"other\"\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("setattr(K, \"f\", \u2026) after the classes", async () => {
    // CPython: prints `setK`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nsetattr(K, \"f\", lambda self: \"setK\")\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("L.__bases__ = (Other,)", async () => {
    // CPython: prints `Other.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass Other:\n    def f(self): return \"Other.f\"\nclass L(K):\n    def g(self): return self.f()\nL.__bases__ = (Other,)\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("instance __class__ reassigned to a class built on Other", async () => {
    // CPython: prints `Other.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass Other:\n    def f(self): return \"Other.f\"\nclass L(K):\n    def g(self): return self.f()\nl = L()\nl.__class__ = type(\"Z\", (Other,), {\"g\": L.g})\nprint(l.g())\n"})).toEqual([undefined]);
  });

  it("class decorator returns another class (L.g never runs, Other.g does)", async () => {
    // CPython: prints `Other.f` (the call in L.g is never run; K.f would be a wrong arrow).
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass Other:\n    def f(self): return \"Other.f\"\ndef deco(c):\n    return Other\n@deco\nclass L(K):\n    def g(self): return self.f()\nprint(L)\n"})).toEqual([undefined]);
  });

  it("class decorator patches c.f", async () => {
    // CPython: prints `patched`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\ndef deco(c):\n    c.f = lambda self: \"patched\"\n    return c\n@deco\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("class decorator returns type(\"N\", (c,), {\"f\": \u2026})", async () => {
    // CPython: prints `N.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\ndef deco(c):\n    return type(\"N\", (c,), {\"f\": lambda self: \"N.f\"})\n@deco\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("@dataclass on L is still fine", async () => {
    // CPython: prints `K.f`.
    expect(await run({"a.py": "from dataclasses import dataclass\nclass K:\n    def f(self): return \"K.f\"\n@dataclass\nclass L(K):\n    a: int = 1\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual(['a.py::K.f::method']);
  });

  it("K has a metaclass that does not touch L", async () => {
    // CPython: prints `K.f` (type(L) is Meta).
    expect(await run({"a.py": "class Meta(type):\n    def __getattribute__(cls, n): return type.__getattribute__(cls, n)\nclass K(metaclass=Meta):\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual(['a.py::K.f::method']);
  });

  it("K's metaclass __new__ injects f into L's namespace", async () => {
    // CPython: prints `meta-injected`.
    expect(await run({"a.py": "class Meta(type):\n    def __new__(mcs, name, bases, ns):\n        if name == \"L\": ns[\"f\"] = lambda self: \"meta-injected\"\n        return super().__new__(mcs, name, bases, ns)\nclass K(metaclass=Meta):\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("L's own metaclass injects f", async () => {
    // CPython: prints `meta-injected`.
    expect(await run({"a.py": "class Meta(type):\n    def __new__(mcs, name, bases, ns):\n        if name == \"L\": ns[\"f\"] = lambda self: \"meta-injected\"\n        return super().__new__(mcs, name, bases, ns)\nclass K:\n    def f(self): return \"K.f\"\nclass L(K, metaclass=Meta):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K does not define f at all", async () => {
    // CPython: prints AttributeError: no f anywhere.
    expect(await run({"a.py": "class K:\n    pass\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K inherits f from an imported class and defines none", async () => {
    // CPython: prints `x.Foreign.f`.
    expect(await run({"a.py": "from x import Foreign\nclass K(Foreign):\n    pass\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n", "x.py": "class Foreign:\n    def f(self): return \"x.Foreign.f\"\n"})).toEqual([undefined]);
  });

  it("K(Foreign) defines f itself", async () => {
    // CPython: prints `K.f`.
    expect(await run({"a.py": "from x import Foreign\nclass K(Foreign):\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n", "x.py": "class Foreign:\n    def f(self): return \"x.Foreign.f\"\n"})).toEqual(['a.py::K.f::method']);
  });

  it("K(Foreign), Foreign (a library the repo does not hold) defines __getattribute__", async () => {
    // CPython: prints `ga`.
    expect(await run({"a.py": "from xg import Foreign\nclass K(Foreign):\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K(Foreign), Foreign (not held) has __init_subclass__ that setattr()s f on every subclass", async () => {
    // CPython: prints `foreign-init-subclass`.
    expect(await run({"a.py": "from xi import Foreign\nclass K(Foreign):\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K's own __init_subclass__ sets f on every subclass through a variable name", async () => {
    // CPython: prints `init_subclass`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\n    def __init_subclass__(cls, **kw):\n        for n in (\"f\",):\n            setattr(cls, n, lambda self: \"init_subclass\")\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("import pkg.mod as mod; class L(mod.K) next to a local K", async () => {
    // CPython: prints `pkg.K.f`: the base is pkg.mod.K, local K.f is not in the MRO.
    expect(await run({"a.py": "import pkg.mod as mod\nclass K:\n    def f(self): return \"local.K.f\"\nclass L(mod.K):\n    def g(self): return self.f()\nprint(L().g())\n", "pkg/__init__.py": "", "pkg/mod.py": "class K:\n    def f(self): return \"pkg.K.f\"\n"})).toEqual([undefined]);
  });

  it("from pkg import mod; class L(mod.K) next to a local K", async () => {
    // CPython: prints `pkg.K.f`.
    expect(await run({"a.py": "from pkg import mod\nclass K:\n    def f(self): return \"local.K.f\"\nclass L(mod.K):\n    def g(self): return self.f()\nprint(L().g())\n", "pkg/__init__.py": "", "pkg/mod.py": "class K:\n    def f(self): return \"pkg.K.f\"\n"})).toEqual([undefined]);
  });

  it("from . import mod (relative, run as `python3 -m pkg.a`); class L(mod.K) next to a local K", async () => {
    // CPython: prints `pkg.K.f`.
    expect(await run({"pkg/a.py": "from . import mod\nclass K:\n    def f(self): return \"local.K.f\"\nclass L(mod.K):\n    def g(self): return self.f()\nprint(L().g())\n", "pkg/__init__.py": "", "pkg/mod.py": "class K:\n    def f(self): return \"pkg.K.f\"\n"}, "pkg/a.py")).toEqual([undefined]);
  });

  it("K = K0 value binding before L", async () => {
    // CPython: prints `K0.f`.
    expect(await run({"a.py": "class K0:\n    def f(self): return \"K0.f\"\nclass K:\n    def f(self): return \"K.f\"\nK = K0\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K = make() value binding before L", async () => {
    // CPython: prints `Other.f`.
    expect(await run({"a.py": "class Other:\n    def f(self): return \"Other.f\"\nclass K:\n    def f(self): return \"K.f\"\ndef make(): return Other\nK = make()\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("base subscript whose __class_getitem__ returns another class", async () => {
    // CPython: prints `Other.f`.
    expect(await run({"a.py": "class Other:\n    def f(self): return \"Other.f\"\nclass K:\n    __class_getitem__ = classmethod(lambda cls, i: Other)\n    def f(self): return \"K.f\"\nclass L(K[int]):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("base is a call, make(K)", async () => {
    // CPython: prints `Other.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass Other:\n    def f(self): return \"Other.f\"\ndef make(c): return Other\nclass L(make(K)):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("L(K, Mixin) with f on both (K first in the MRO)", async () => {
    // CPython: prints `K.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass Mixin:\n    def f(self): return \"Mixin.f\"\nclass L(K, Mixin):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("L(Mixin, K) with f on both (Mixin first in the MRO)", async () => {
    // CPython: prints `Mixin.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass Mixin:\n    def f(self): return \"Mixin.f\"\nclass L(Mixin, K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("L defines __getattr__ (only a fallback; K.f still runs)", async () => {
    // CPython: prints `K.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def __getattr__(self, n): return lambda: \"ga\"\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual(['a.py::K.f::method']);
  });

  it("K defines __getattr__ and f (only a fallback; K.f still runs)", async () => {
    // CPython: prints `K.f`.
    expect(await run({"a.py": "class K:\n    def __getattr__(self, n): return lambda: \"ga\"\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual(['a.py::K.f::method']);
  });

  it("K.f is a staticmethod (core stays name-only on decorated bindings)", async () => {
    // CPython: prints `K.f static`: runs K.f, name-only is the documented safe answer.
    expect(await run({"a.py": "class K:\n    @staticmethod\n    def f(): return \"K.f static\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K.f is a classmethod (core stays name-only on decorated bindings)", async () => {
    // CPython: prints `K.f cm`.
    expect(await run({"a.py": "class K:\n    @classmethod\n    def f(cls): return \"K.f cm\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K.f is a property returning a lambda: self.f() calls the lambda, never K.f", async () => {
    // CPython: prints `prop`.
    expect(await run({"a.py": "class K:\n    @property\n    def f(self): return lambda: \"prop\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K defined in both branches of an if (the else one runs)", async () => {
    // CPython: prints `K2.f`.
    expect(await run({"a.py": "import sys\nif len(sys.argv) > 5:\n    class K:\n        def f(self): return \"K.f\"\nelse:\n    class K:\n        def f(self): return \"K2.f\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K defined inside try", async () => {
    // CPython: prints `K.f` (conditional binding: name-only).
    expect(await run({"a.py": "try:\n    class K:\n        def f(self): return \"K.f\"\nexcept Exception:\n    pass\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K defined twice before L: the second one wins", async () => {
    // CPython: prints `K2.f`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K1.f\"\nclass K:\n    def f(self): return \"K2.f\"\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("K defined after L", async () => {
    // CPython: prints NameError: name K is not defined.
    expect(await run({"a.py": "class L(K):\n    def g(self): return self.f()\nclass K:\n    def f(self): return \"K.f\"\ntry: print(L().g())\nexcept NameError as e: print(\"NameError\", e)\n"})).toEqual([undefined]);
  });

  it("global K rebound by a function called before L", async () => {
    // CPython: prints `K0.f`.
    expect(await run({"a.py": "class K0:\n    def f(self): return \"K0.f\"\nclass K:\n    def f(self): return \"K.f\"\ndef rebind():\n    global K\n    K = K0\nrebind()\nclass L(K):\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("L inside a function, K top level", async () => {
    // CPython: prints `K.f` (not top-level L: name-only).
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\ndef run():\n    class L(K):\n        def g(self): return self.f()\n    return L().g()\nprint(run())\n"})).toEqual([undefined]);
  });

  it("L and K both inside a function", async () => {
    // CPython: prints `K.f` (not top-level L: name-only).
    expect(await run({"a.py": "def run():\n    class K:\n        def f(self): return \"K.f\"\n    class L(K):\n        def g(self): return self.f()\n    return L().g()\nprint(run())\n"})).toEqual([undefined]);
  });

  it("M(L) assigns f = lambda in its body", async () => {
    // CPython: prints `M.f attr`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nclass M(L):\n    f = lambda self: \"M.f attr\"\nprint(M().g())\n"})).toEqual([undefined]);
  });

  it("an instance of L gets f assigned", async () => {
    // CPython: prints `linst`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    def g(self): return self.f()\nl = L(); l.f = lambda: \"linst\"\nprint(l.g())\n"})).toEqual([undefined]);
  });

  it("L binds f by assignment in its body", async () => {
    // CPython: prints `L attr`.
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    f = lambda self: \"L attr\"\n    def g(self): return self.f()\nprint(L().g())\n"})).toEqual([undefined]);
  });

  it("L binds f as a nested class: self.f() instantiates it, K.f never runs", async () => {
    // CPython: prints `f` (type name of the result).
    expect(await run({"a.py": "class K:\n    def f(self): return \"K.f\"\nclass L(K):\n    class f:\n        pass\n    def g(self): return type(self.f()).__name__\nprint(L().g())\n"})).toEqual([undefined]);
  });

});

import ts from 'typescript';

/**
 * The TypeScript compiler API used as the test oracle for call scoping: the checker decides what a callee name means
 * at its call site, and its declaration is compared with what core resolved. The oracle only observes TypeScript; it
 * shares no rule with core.
 */
export interface TsDeclaration {
  /** The `ts.SyntaxKind` name of the declaration node: `Parameter`, `BindingElement`, `VariableDeclaration`… */
  kind: string;
  /** The file holding the declaration: repo-relative for the in-memory tree, absolute for a lib file. */
  file: string;
  /** 1-based line of the declaration's name, where the name is written. */
  line: number;
  /** 0-based column of the declaration's name, where the name is written. */
  column: number;
  parentKind: string;
  name: string;
}

const ROOT = '/repo/';

const OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  // Strictness follows the file: an ES module or a `"use strict"` file is strict, a plain script is not.
  alwaysStrict: false,
  strict: false,
  noEmit: true,
  skipLibCheck: true,
};

const normalize = (path: string): string => path.replace(/\\/g, '/');

/** Lib files are parsed once per run: a program per test would otherwise hold a copy of every lib each. */
const libFiles = new Map<string, ts.SourceFile | undefined>();

function libFile(base: ts.CompilerHost, fileName: string, languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions): ts.SourceFile | undefined {
  const key = fileName;
  if (!libFiles.has(key)) libFiles.set(key, base.getSourceFile(fileName, languageVersion));
  return libFiles.get(key);
}

/** A CompilerHost serving the in-memory tree under `/repo/`, and the real host for lib files. */
function createHost(tree: Record<string, string>): ts.CompilerHost {
  const base = ts.createCompilerHost(OPTIONS);
  const textOf = (fileName: string): string | undefined => {
    const normalized = normalize(fileName);
    return normalized.startsWith(ROOT) ? tree[normalized.slice(ROOT.length)] : undefined;
  };
  return {
    ...base,
    getCurrentDirectory: () => ROOT.slice(0, -1),
    getCanonicalFileName: normalize,
    directoryExists: (dir) => (normalize(dir).startsWith(ROOT.slice(0, -1)) ? true : (base.directoryExists?.(dir) ?? false)),
    fileExists: (fileName) => textOf(fileName) !== undefined || base.fileExists(fileName),
    readFile: (fileName) => textOf(fileName) ?? base.readFile(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = textOf(fileName);
      return text === undefined ? libFile(base, fileName, languageVersion) : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    writeFile: () => {},
  };
}

const programs = new WeakMap<Record<string, string>, ts.Program>();

function programOf(tree: Record<string, string>): ts.Program {
  const cached = programs.get(tree);
  if (cached) return cached;
  const host = createHost(tree);
  const program = ts.createProgram(Object.keys(tree).map((path) => ROOT + path), OPTIONS, host);
  programs.set(tree, program);
  return program;
}

function sourceFileOf(program: ts.Program, file: string): ts.SourceFile | undefined {
  const wanted = ROOT + normalize(file);
  return program.getSourceFiles().find((sf) => normalize(sf.fileName) === wanted);
}

/** The innermost CallExpression starting where core's `CallRef.range.start` says (1-based line, 0-based column). */
function callAt(sourceFile: ts.SourceFile, line: number, column: number): ts.CallExpression | undefined {
  const starting: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      if (start.line + 1 === line && start.character === column) starting.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return starting.sort((a, b) => a.getEnd() - b.getEnd())[0];
}

/** The callee's name node: the identifier called, or the property name of `a.b()`. */
const calleeName = (call: ts.CallExpression): ts.Identifier | ts.PrivateIdentifier | undefined => {
  if (ts.isIdentifier(call.expression)) return call.expression;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name;
  return undefined;
};

/** The declaration the checker binds a symbol to, following an alias to the symbol it aliases. */
function declarationOf(checker: ts.TypeChecker, node: ts.Node): ts.Declaration | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return target?.declarations?.[0];
}

function describeDeclaration(declaration: ts.Declaration): TsDeclaration {
  const sourceFile = declaration.getSourceFile();
  const name = ts.getNameOfDeclaration(declaration);
  const nameNode = name ?? declaration;
  const position = sourceFile.getLineAndCharacterOfPosition(nameNode.getStart(sourceFile));
  // A module's symbol (the aliased target of a namespace import) declares at the SourceFile, which has no parent.
  const parentKind = declaration.parent ? (ts.SyntaxKind[declaration.parent.kind] ?? String(declaration.parent.kind)) : '';
  return {
    kind: ts.SyntaxKind[declaration.kind] ?? String(declaration.kind),
    file: normalize(sourceFile.fileName).startsWith(ROOT) ? normalize(sourceFile.fileName).slice(ROOT.length) : sourceFile.fileName,
    line: position.line + 1,
    column: position.character,
    parentKind,
    name: name ? name.getText(sourceFile) : '',
  };
}

/**
 * The declaration the checker gives the callee of the call at (`line`, `column`) whose written name is `name`:
 * the identifier of a bare call, or the property name of `a.b()`. Undefined when the call or its binding is absent.
 */
export function tsDeclarationAt(tree: Record<string, string>, file: string, line: number, column: number, name: string): TsDeclaration | undefined {
  const program = programOf(tree);
  const sourceFile = sourceFileOf(program, file);
  if (!sourceFile) return undefined;
  const call = callAt(sourceFile, line, column);
  const node = call && calleeName(call);
  if (!call || !node || node.text !== name) return undefined;
  const declaration = declarationOf(program.getTypeChecker(), node);
  return declaration && describeDeclaration(declaration);
}

/** The result of looking for a call: `found: false` means no call starts there, a harness bug, not a name with no binding. */
export type TsCallLookup = { found: false } | { found: true; declaration: TsDeclaration | undefined };

/**
 * The declaration the checker gives the callee of the call at (`line`, `column`) whose written name is `name`, with the
 * call itself reported separately. A name declared by several script files is one global symbol: the declaration in the
 * call's own file is the one that file writes, so it is preferred over whichever declaration the symbol lists first.
 */
export function tsCallAt(tree: Record<string, string>, file: string, line: number, column: number, name: string): TsCallLookup {
  const program = programOf(tree);
  const sourceFile = sourceFileOf(program, file);
  if (!sourceFile) return { found: false };
  const call = callAt(sourceFile, line, column);
  const node = call && calleeName(call);
  if (!call || !node || node.text !== name) return { found: false };
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(node);
  const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const wanted = ROOT + normalize(file);
  const declarations = target?.declarations ?? [];
  const declaration = declarations.find((d) => normalize(d.getSourceFile().fileName) === wanted) ?? declarations[0];
  return { found: true, declaration: declaration && describeDeclaration(declaration) };
}

/**
 * EVERY declaration the checker gives the callee of the call at (`line`, `column`) whose written name is `name` (aliases
 * followed): `[]` for a call with no symbol, `undefined` when no call starts there. A call with one declaration is the
 * only kind core may resolve; an overload set, a duplicate member or a merged declaration lists several.
 */
export function tsDeclarationsAt(tree: Record<string, string>, file: string, line: number, column: number, name: string): TsDeclaration[] | undefined {
  const program = programOf(tree);
  const sourceFile = sourceFileOf(program, file);
  if (!sourceFile) return undefined;
  const call = callAt(sourceFile, line, column);
  const node = call && calleeName(call);
  if (!call || !node || node.text !== name) return undefined;
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(node);
  const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return (target?.declarations ?? []).map(describeDeclaration);
}

/** The declaration the checker binds to the identifier written at (`line`, `column`): a receiver, for example. */
export function tsDeclarationOfIdentifier(tree: Record<string, string>, file: string, line: number, column: number, name: string): TsDeclaration | undefined {
  const program = programOf(tree);
  const sourceFile = sourceFileOf(program, file);
  if (!sourceFile) return undefined;
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      if (start.line + 1 === line && start.character === column) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const identifier = found[0];
  const declaration = identifier && declarationOf(program.getTypeChecker(), identifier);
  return declaration && describeDeclaration(declaration);
}

import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

test("native mobile wire type graph stays free of Node runtime with Expo's required NODE_ENV", () => {
  const wireFile = path.resolve("src/protocol/native/remote-wire.ts");
  const ambientFile = path.resolve("test/expo-environment.d.ts");
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    types: ["node"],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    path.resolve(fileName) === ambientFile
      ? ts.createSourceFile(
          fileName,
          // Match expo/types/global.d.ts without installing Expo in Core CI.
          `declare namespace NodeJS {
            interface ProcessEnv {
              readonly NODE_ENV: "development" | "production" | "test";
            }
          }`,
          languageVersion,
        )
      : getSourceFile(fileName, languageVersion, ...rest);
  const program = ts.createProgram([wireFile, ambientFile], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }),
  );

  // Type-only imports are erased at runtime but still enter this source graph.
  const sourceDirectory = path.resolve("src");
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/u, "")),
  );
  const runtimeImports: string[] = [];
  for (const source of program.getSourceFiles()) {
    const relativeFile = path.relative(sourceDirectory, source.fileName);
    if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile))
      continue;
    for (const statement of source.statements) {
      if (
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        (statement.moduleSpecifier.text.startsWith("node:") ||
          builtins.has(statement.moduleSpecifier.text))
      ) {
        runtimeImports.push(
          `${path.relative(process.cwd(), source.fileName)}: ${statement.moduleSpecifier.text}`,
        );
      }
    }
  }
  assert.deepEqual(
    runtimeImports,
    [],
    "wire types must not reach Node runtime",
  );
});

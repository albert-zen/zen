import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const observerName = "__zenxLaunchPathObserver";
const observerImport = `import * as ${observerName} from "./launch-path-observer.mjs";\n`;

function parse(source) {
  const file = ts.createSourceFile(
    "entry.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(
    file.parseDiagnostics.length,
    0,
    "Built entry must be valid JavaScript",
  );
  return file;
}

function matching(file, predicate) {
  const matches = [];
  const visit = (node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return matches;
}

function exactlyOne(nodes, label) {
  assert.equal(
    nodes.length,
    1,
    `Expected exactly one ${label}; found ${nodes.length}`,
  );
  return nodes[0];
}

function identifier(node, name) {
  return ts.isIdentifier(node) && node.text === name;
}

function call(node, name) {
  return ts.isCallExpression(node) && identifier(node.expression, name);
}

function property(node, object, name) {
  return (
    ts.isPropertyAccessExpression(node) &&
    identifier(node.expression, object) &&
    node.name.text === name
  );
}

function expressionStatement(node) {
  while (node.parent && !ts.isExpressionStatement(node)) node = node.parent;
  assert(ts.isExpressionStatement(node), "Expected a standalone statement");
  return node;
}

function applyInsertions(source, insertions) {
  for (const [offset, text] of insertions.sort((a, b) => b[0] - a[0]))
    source = source.slice(0, offset) + text + source.slice(offset);
  parse(source);
  return source;
}

/** Fail closed when built control flow changes; never replace product statements. */
export function instrumentLaunchPathEntry(source, entry) {
  const file = parse(source);
  assert.equal(
    matching(file, (node) => identifier(node, observerName)).length,
    0,
    "Entry already instrumented",
  );
  const imports = file.statements.filter(ts.isImportDeclaration);
  assert(imports.length > 0, "Expected an ESM build entry");
  const afterImports = imports.at(-1).end;
  if (entry === "main") {
    const electronImport = exactlyOne(
      imports.filter((node) => node.moduleSpecifier.text === "electron"),
      "Electron import",
    );
    const app = exactlyOne(
      electronImport.importClause?.namedBindings?.elements?.filter(
        (node) => (node.propertyName ?? node.name).text === "app",
      ) ?? [],
      "Electron app binding",
    );
    assert.equal(app.name.text, "app", "Electron app binding changed");
    const bootstrap = exactlyOne(
      matching(
        file,
        (node) =>
          ts.isFunctionDeclaration(node) && node.name?.text === "bootstrapZenX",
      ),
      "bootstrap function",
    );
    const capture = exactlyOne(
      matching(bootstrap, (node) => call(node, "restoreLoginShellPath")),
      "login-shell capture",
    );
    assert(ts.isAwaitExpression(capture.parent), "Capture must be awaited");
    const declaration = capture.parent.parent;
    assert(
      ts.isVariableDeclaration(declaration) &&
        identifier(declaration.name, "shellPath"),
      "Capture result binding changed",
    );
    const captureStatement = declaration.parent.parent;
    assert(
      ts.isVariableStatement(captureStatement) &&
        captureStatement.parent === bootstrap.body,
      "Capture must be in the bootstrap body",
    );
    const completed = exactlyOne(
      matching(
        file,
        (node) =>
          ts.isCallExpression(node) &&
          property(node.expression, "bootstrapFence", "run") &&
          node.arguments.length === 1 &&
          identifier(node.arguments[0], "bootstrapZenX"),
      ),
      "bootstrap fence invocation",
    );
    assert(
      ts.isAwaitExpression(completed.parent),
      "Bootstrap fence must be awaited",
    );
    const completedStatement = expressionStatement(completed);
    const lifecycle = exactlyOne(
      matching(
        file,
        (node) =>
          ts.isNewExpression(node) &&
          identifier(node.expression, "ZenXHostLifecycle"),
      ),
      "Host lifecycle construction",
    );
    const lifecycleOptions = lifecycle.arguments?.[0];
    assert(lifecycleOptions && ts.isObjectLiteralExpression(lifecycleOptions));
    const failure = exactlyOne(
      lifecycleOptions.properties.filter(
        (node) =>
          ts.isPropertyAssignment(node) &&
          identifier(node.name, "reportStopFailure"),
      ),
      "Host shutdown failure callback",
    ).initializer;
    assert(
      ts.isArrowFunction(failure) &&
        failure.parameters.length === 1 &&
        ts.isIdentifier(failure.parameters[0].name) &&
        !ts.isBlock(failure.body),
      "Host shutdown failure callback shape changed",
    );

    return applyInsertions(source, [
      [0, observerImport],
      [
        failure.body.getStart(file),
        `(${observerName}.observeShutdownFailure(${failure.parameters[0].name.text}), `,
      ],
      [failure.body.end, ")"],
      [afterImports, `\n${observerName}.observeMain(app);\n`],
      [captureStatement.end, `\n${observerName}.observeCapture(shellPath);\n`],
      [
        completedStatement.end,
        `\nawait ${observerName}.completeMain(app, appWindows);\n`,
      ],
    ]);
  }
  assert.equal(entry, "host", "Unknown observer entry");
  const composition = exactlyOne(
    matching(file, (node) => call(node, "createZenXHostToolEnvironment")),
    "Host tool composition",
  );
  assert(
    ts.isVariableDeclaration(composition.parent) &&
      identifier(composition.parent.name, "toolComposition"),
    "Host composition binding changed",
  );
  const hosted = exactlyOne(
    matching(file, (node) => call(node, "createHostedAppServer")),
    "hosted App Server construction",
  );
  const assignment = hosted.parent;
  assert(
    ts.isBinaryExpression(assignment) &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      identifier(assignment.left, "appServer"),
    "Host construction assignment changed",
  );
  assert.equal(hosted.arguments.length, 1);
  const argument = hosted.arguments[0];
  assert(ts.isObjectLiteralExpression(argument));
  const environment = exactlyOne(
    argument.properties.filter(
      (node) =>
        ts.isPropertyAssignment(node) &&
        identifier(node.name, "toolEnvironment"),
    ),
    "real Host tool environment",
  );
  assert(
    property(environment.initializer, "toolComposition", "toolEnvironment"),
    "Host tool environment changed",
  );
  const hostStatement = expressionStatement(hosted);
  const compositionStatement = composition.parent.parent.parent;
  assert(
    ts.isVariableStatement(compositionStatement) &&
      compositionStatement.parent === hostStatement.parent &&
      compositionStatement.end < hostStatement.pos,
    "Host composition must precede App Server in the same block",
  );
  return applyInsertions(source, [
    [0, observerImport],
    [
      hostStatement.getStart(file),
      `await ${observerName}.observeHost(toolComposition.toolEnvironment);\n`,
    ],
  ]);
}

export async function prepareLaunchPathApp(appDirectory) {
  const main = path.join(appDirectory, "out", "main");
  // Validate both entries before modifying either staged file.
  const entries = await Promise.all(
    ["index.js", "app-server-host.js"].map(async (name, index) => ({
      name,
      source: instrumentLaunchPathEntry(
        await readFile(path.join(main, name), "utf8"),
        index === 0 ? "main" : "host",
      ),
    })),
  );
  await copyFile(
    new URL("./macos-launch-path-observer.mjs", import.meta.url),
    path.join(main, "launch-path-observer.mjs"),
  );
  for (const name of [
    "macos-launch-path-host-observation.mjs",
    "macos-launch-path-control.mjs",
    "macos-launch-path-cleanup.mjs",
  ])
    await copyFile(
      new URL(`./${name}`, import.meta.url),
      path.join(main, name),
    );
  for (const { name, source } of entries)
    await writeFile(path.join(main, name), source);
}

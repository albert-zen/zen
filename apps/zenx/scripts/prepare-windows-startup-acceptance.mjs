import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Instrument only a disposable portable-package copy, never the shipping build. */
export function instrumentStartup(source) {
  if (source.includes("startupAcceptanceFixture"))
    throw new Error("Startup acceptance fixture already instrumented");
  const parsed = ts.createSourceFile(
    "index.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const seams = [];
  const trustSeams = [];
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "isTrustedImZenXSetupSender"
    )
      trustSeams.push(node);
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "bootstrapFence" &&
        call.expression.name.text === "run" &&
        call.arguments.length === 1 &&
        ts.isIdentifier(call.arguments[0]) &&
        call.arguments[0].text === "bootstrapZenX"
      )
        seams.push(call.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (seams.length !== 1)
    throw new Error(
      `Expected exactly one awaited bootstrap lifecycle seam, found ${seams.length}`,
    );
  if (
    trustSeams.length !== 1 ||
    !trustSeams[0].body ||
    trustSeams[0].parameters.length !== 2 ||
    !trustSeams[0].parameters.every(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        !parameter.initializer &&
        !parameter.dotDotDotToken,
    )
  )
    throw new Error(
      `Expected exactly one trusted sender diagnostic seam, found ${trustSeams.length}`,
    );
  const seam = seams[0];
  const trust = trustSeams[0];
  const edits = [
    {
      start: seam.getStart(parsed),
      end: seam.end,
      text: "async () => { await startupAcceptanceFixture.gate(); await bootstrapZenX(); startupAcceptanceFixture.completed(appServerManager?.status.type); }",
    },
    {
      start: trust.body.getStart(parsed) + 1,
      end: trust.body.getStart(parsed) + 1,
      // Observe the existing arguments without wrapping/replaying the guard.
      // A diagnostic failure must never alter its original admission result.
      text: `\ntry { startupAcceptanceFixture.trustedSenderObserved(${trust.parameters[0].name.text}, ${trust.parameters[1].name.text}); } catch {}\n`,
    },
  ].sort((a, b) => b.start - a.start);
  let instrumented = source;
  for (const edit of edits)
    instrumented =
      instrumented.slice(0, edit.start) +
      edit.text +
      instrumented.slice(edit.end);
  return (
    'import * as startupAcceptanceFixture from "./startup-acceptance-fixture.mjs";\n' +
    "startupAcceptanceFixture.observe();\n" +
    instrumented
  );
}

export async function prepareFixture(
  sourceDirectory,
  destination,
  evidenceDirectory,
  mode,
) {
  if (!["success", "failure"].includes(mode))
    throw new Error("Invalid startup fixture mode");
  // cp must not touch a previous run or the original package.
  await mkdir(destination, { recursive: false });
  const mainRelative = path.join("resources", "app", "out", "main");
  const source = await readFile(
    path.join(sourceDirectory, mainRelative, "index.js"),
    "utf8",
  );
  const instrumented = instrumentStartup(source);
  for (const entry of await readdir(sourceDirectory)) {
    await cp(path.join(sourceDirectory, entry), path.join(destination, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  const mainDirectory = path.join(destination, mainRelative);
  await cp(
    new URL("../test/fixtures/startup-acceptance/fixture.mjs", import.meta.url),
    path.join(mainDirectory, "startup-acceptance-fixture.mjs"),
  );
  await writeFile(
    path.join(mainDirectory, "startup-acceptance-config.json"),
    JSON.stringify({
      evidenceDirectory: path.resolve(evidenceDirectory),
      mode,
    }),
  );
  await writeFile(path.join(mainDirectory, "index.js"), instrumented);
  await writeFile(
    path.join(evidenceDirectory, "instrumentation.json"),
    JSON.stringify(
      {
        originalMainSha256: createHash("sha256").update(source).digest("hex"),
        instrumentedMainSha256: createHash("sha256")
          .update(instrumented)
          .digest("hex"),
        scope:
          "Private portable copy; observe windows and trusted sender arguments without changing admission; gate the existing awaited bootstrap fence only",
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [source, destination, evidence, mode] = process.argv.slice(2);
  if (!source || !destination || !evidence || !mode)
    throw new Error(
      "Expected package directory, new fixture directory, evidence directory and mode",
    );
  await prepareFixture(source, destination, evidence, mode);
}

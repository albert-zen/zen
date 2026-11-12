import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { targetedInputContractPage } from "../src/main/browser-parallel-input-smoke.js";

// Exercise the actual Windows stage declarations in source order, replacing only
// their native boundaries. This is orchestration evidence, not real Chrome acceptance.
test("Windows verifies the original page global before contract navigation replaces its document", async () => {
  const source = readFileSync(
    new URL("../src/main/user-browser-smoke.ts", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "smoke.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations: ts.VariableStatement[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          ["programmableExtensions", "targetedInputContracts"].includes(
            declaration.name.text,
          ),
      )
    )
      declarations.push(node);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(declarations.length, 2);
  const script = ts.transpileModule(
    `(async () => { ${declarations.map((node) => node.getText(parsed)).join("\n")} })()`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const backend = {};
  const calls: string[] = [];
  let currentPage = "/opened";
  let applicationGlobal: number | undefined = 42;
  assert.doesNotMatch(
    targetedInputContractPage("/input-contract?mode=ordinary-dom"),
    /__zenProgrammableSmoke/,
  );
  await runInNewContext(script, {
    backend,
    opened: { tabId: "same-owned-tab" },
    endpoint: "http://127.0.0.1:9222",
    port: 3456,
    verifyBrowserExtensions: async (
      selected: unknown,
      session: string,
      tabId: string,
      origin: string,
    ) => {
      assert.equal(selected, backend);
      assert.equal(session, "windows-smoke");
      assert.equal(tabId, "same-owned-tab");
      assert.equal(origin, "http://127.0.0.1:3456");
      assert.equal(
        currentPage,
        "/opened",
        "The application-global witness belongs only to the original fixture document",
      );
      assert.equal(
        applicationGlobal,
        42,
        "Keep the actual pinned-main-world acceptance assertion, not an injected replacement",
      );
      calls.push("extensions");
      return { passed: true };
    },
    runTargetedInputContractSmoke: async (options: {
      backend: unknown;
      sessionId: string;
      tabId: string;
    }) => {
      assert.equal(options.backend, backend);
      assert.equal(options.sessionId, "windows-smoke");
      assert.equal(options.tabId, "same-owned-tab");
      currentPage = "/input-contract?mode=ordinary-dom";
      applicationGlobal = undefined;
      calls.push("contracts");
      return [];
    },
  });
  assert.deepEqual(calls, ["extensions", "contracts"]);
  assert.equal(
    applicationGlobal,
    undefined,
    "The later contract document has its own globals",
  );
});

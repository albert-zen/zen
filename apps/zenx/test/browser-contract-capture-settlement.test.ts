import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

async function inspection(
  read: () => Promise<unknown>,
  inputs: unknown[] = [],
) {
  const source = await readFile(
    new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "smoke.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(parsed) === "inspect"
    )
      initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(initializer);
  const phases: string[] = [];
  const context = {
    assert,
    backend: { inspect: read },
    sessionId: "fixture",
    tabId: "owned",
    inputs,
    withheldCaptures: 0,
    guard: async () => undefined,
    options: { onPhase: (phase: string) => phases.push(phase) },
    poll: async (read: () => Promise<unknown>) => {
      for (let count = 0; count < 3; count++) {
        const result = await read();
        if (result !== undefined) return result;
      }
      throw new Error("bounded read-only settlement expired");
    },
  };
  const invoke = runInNewContext(
    `(${ts
      .transpileModule(initializer.getText(parsed), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      })
      .outputText.trim()
      .replace(/;$/, "")})`,
    context,
  ) as () => Promise<unknown>;
  return { invoke, context, phases };
}

test("contract capture waits only through withheld reads and stops at coherent evidence", async () => {
  let reads = 0;
  const coherent = {
    screenshot: { status: "captured" },
    inputViewport: { width: 100 },
  };
  const fixture = await inspection(async () =>
    ++reads < 3 ? { screenshot: { status: "captured" } } : coherent,
  );
  assert.equal(await fixture.invoke(), coherent);
  assert.equal(reads, 3);
  assert.equal(fixture.context.withheldCaptures, 2);
  assert.equal(fixture.phases.length, 2);
  assert.deepEqual(fixture.context.inputs, []);
});

test("contract capture fails boundedly and never retries an exception or fallback", async () => {
  const missing = await inspection(async () => ({
    screenshot: { status: "captured" },
  }));
  await assert.rejects(missing.invoke(), /bounded read-only/);
  assert.equal(missing.context.withheldCaptures, 3);
  let reads = 0;
  const broken = await inspection(async () => {
    reads++;
    throw new Error("provider failed");
  });
  await assert.rejects(broken.invoke(), /provider failed/);
  assert.equal(reads, 1);
  const fallback = await inspection(async () => ({
    screenshot: { status: "fallback" },
  }));
  await assert.rejects(fallback.invoke(), /fallback/);
});

test("hidden-page frame smoke never waits for suspended animation frames", async () => {
  const source = await readFile(
    new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "smoke.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const smoke = parsed.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "runTargetedInputContractSmoke",
  );
  assert.ok(smoke);
  assert.doesNotMatch(smoke.getText(parsed), /requestAnimationFrame/);
  assert.match(smoke.getText(parsed), /assert\.equal\(reopenedScroll, 20\)/);
});

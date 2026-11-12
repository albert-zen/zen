import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { UserBrowserCdpDiagnosticObserver } from "../src/main/capabilities/user-browser-cdp-diagnostics.ts";
import { finishCdpDiagnostic } from "../src/main/browser-parallel-input-smoke.ts";

const source = readFileSync(
  new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "fixture.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const main = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "main",
);
const cleanup = main.body.statements.find((node) =>
  ts.isTryStatement(node),
).finallyBlock;
assert.ok(cleanup);
const code = ts.transpileModule(
  `async function run(original) { try { if (original) throw original; } finally ${cleanup.getText(ast)} }; run`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

for (const failAt of [undefined, "native-close", "remove-directory"]) {
  for (const primary of [false, true]) {
    test(`actual cleanup preserves ${primary ? "primary failure" : "success"} with ${failAt ?? "successful cleanup"} and failed artifact`, async () => {
      const calls = [];
      const original = new Error("original primary failure");
      const cleanupError = new Error("original cleanup failure");
      const observer = new UserBrowserCdpDiagnosticObserver();
      const connection = observer.connect();
      const step = (name) => async () => {
        calls.push(name);
        if (name === failAt) throw cleanupError;
      };
      const run = runInNewContext(code, {
        cdpDiagnostics: observer,
        cleanupCompleted: false,
        diagnosticOutcome: primary ? "failed" : "passed",
        stopTransport: () => calls.push("stop-old-transport"),
        native: { call: step("native-clear"), close: step("native-close") },
        connection: {
          backend: {
            close: async () => {
              calls.push("backend-close");
              connection.event("client-close");
            },
          },
        },
        browserRpc: {
          send: step("browser-close"),
          close: () => calls.push("browser-rpc-close"),
        },
        userRpc: { close: () => calls.push("user-rpc-close") },
        agentRpc: { close: () => calls.push("agent-rpc-close") },
        browser: {},
        stopOwnedChild: step("child-stop"),
        server: { listening: false },
        directory: "owned-fixture",
        rm: step("remove-directory"),
        finishCdpDiagnostic: (obs, outcome, completed) =>
          finishCdpDiagnostic(obs, outcome, completed, {
            write: async () => {
              calls.push("artifact-write");
              throw new Error("artifact failure");
            },
            log: (report) => {
              calls.push("artifact-log");
              assert.equal(report.outcome, primary ? "failed" : "passed");
              assert.equal(report.cleanupCompleted, failAt === undefined);
              assert.equal(report.artifactErrors, 1);
              assert.equal(report.events.at(-1).kind, "cutoff");
              assert.ok(
                report.events.some((event) => event.kind === "client-close"),
              );
            },
          }),
      });
      if (failAt || primary)
        await assert.rejects(
          run(primary ? original : undefined),
          (error) => error === (failAt ? cleanupError : original),
        );
      else await run();
      const originalCleanup = [
        "stop-old-transport",
        "native-clear",
        "backend-close",
        "browser-close",
        "user-rpc-close",
        "agent-rpc-close",
        "browser-rpc-close",
        "child-stop",
        "native-close",
        "remove-directory",
      ];
      const expected = failAt
        ? originalCleanup.slice(0, originalCleanup.indexOf(failAt) + 1)
        : originalCleanup;
      assert.deepEqual(calls, [...expected, "artifact-write", "artifact-log"]);
      const snapshot = observer.stop();
      connection.event("socket-close");
      assert.deepEqual(
        observer.stop(),
        snapshot,
        "no extended close/late observation window",
      );
    });
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolResultFallback } from "../src/renderer/src/ToolResultRenderer.js";
import { i18n } from "../src/renderer/src/i18n.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type ToolExecutionResult,
} from "../../../src/tool.js";
import { projectCommandCompleted } from "../../../src/protocol/codex/mapper.js";
import {
  commandPhase,
  commandStatus,
  isShellNonzeroResult,
} from "../src/renderer/src/tool-presentation.js";

function project(result: ToolExecutionResult, toolName = "shell") {
  const common = {
    id: "test-item",
    threadId: "test-thread",
    turnId: "test-turn",
    createdAt: "2026-10-14T00:00:00Z",
    callId: "test-call",
  };
  return projectCommandCompleted(
    { ...common, type: "tool_call", name: toolName, arguments: {} },
    { ...common, type: "tool_result", ...result },
    process.cwd(),
  );
}
function invocation(command: string, cwd = process.cwd()) {
  return {
    callId: "test-call",
    name: "shell",
    arguments: { command },
    cwd,
    signal: new AbortController().signal,
    threadId: "test-thread",
  };
}
async function settle(env: ToolEnvironment, result: ToolExecutionResult) {
  let last = result;
  while (
    last.structuredContent &&
    typeof last.structuredContent === "object" &&
    !Array.isArray(last.structuredContent) &&
    "status" in last.structuredContent &&
    "task_id" in last.structuredContent &&
    ["running", "queued"].includes(String(last.structuredContent.status))
  ) {
    last = await env.waitRuntime.execute({
      ...invocation(""),
      name: "wait",
      arguments: {
        task_id: last.structuredContent.task_id,
        yield_time_ms: 1000,
      },
    });
  }
  return last;
}

test(
  "real shell results retain codes, errors and task state through the unchanged Codex projection",
  { skip: process.platform === "win32" },
  async () => {
    const cases = [
      ["printf 'present\\n' | grep present", 0],
      ["printf 'present\\n' | grep absent", 1],
      ["printf 'present\\n' | grep '['", 2],
      ["grep absent /definitely-missing-355", 2],
      [
        "grep absent /definitely-missing-355; printf 'present\\n' | grep absent",
        1,
      ],
      [
        "grep absent /definitely-missing-355 2>/dev/null; printf 'present\\n' | grep absent",
        1,
      ],
      ["exit 1", 1],
      ["grep() { return 1; }; grep absent", 1],
      ["cat /definitely-missing-355 | grep absent", 1],
      ["zen_nonexistent_command_355", 127],
    ] as const;
    for (const yielded of [false, true]) {
      const env = new ToolEnvironment({
        runtimes: [new ShellToolRuntime()],
        taskOptions: { yieldTimeMs: yielded ? 1 : 5000 },
      });
      try {
        for (const [command, code] of cases) {
          const result = await settle(
            env,
            await env.execute(
              env.prepare(
                invocation((yielded ? "sleep 0.03; " : "") + command),
              ),
            ),
          );
          const before = structuredClone(result);
          const item = project(result, yielded ? "wait" : "shell");
          assert.equal(result.exitCode, code, command);
          assert.equal(item.aggregatedOutput, result.output);
          assert.equal(item.exitCode, code);
          assert.equal(item.status, code === 0 ? "completed" : "failed");
          assert.equal(commandPhase(item), code === 0 ? "completed" : "failed");
          assert.equal(isShellNonzeroResult(item), code !== 0);
          if (code !== 0)
            assert.equal(
              commandStatus(item),
              "Shell returned a nonzero status",
            );
          assert.deepEqual(
            structuredClone(result),
            before,
            "presentation cannot rewrite model-visible results",
          );
        }
        const spawnFailure = await env.execute(
          env.prepare(invocation("pwd", "/definitely-missing-355")),
        );
        assert.equal(spawnFailure.exitCode, 1);
        assert.match(spawnFailure.output, /shell spawn failed/);
        assert.equal(
          commandStatus(project(spawnFailure)),
          "Shell returned a nonzero status",
          "no claim that a process spawned or exited",
        );
      } finally {
        await env.close();
      }
    }
  },
);

test(
  "real signal and timeout receipts retain their failure distinctions",
  { skip: process.platform === "win32" },
  async () => {
    for (const timeout of [false, true]) {
      const env = new ToolEnvironment({
        runtimes: [new ShellToolRuntime()],
        taskOptions: { yieldTimeMs: 1, timeoutMs: timeout ? 30 : 5000 },
      });
      try {
        const result = await settle(
          env,
          await env.execute(
            env.prepare(
              invocation(timeout ? "sleep 10" : "sleep 0.03; kill -TERM $$"),
            ),
          ),
        );
        const item = project(result, "wait");
        assert.equal(isShellNonzeroResult(item), false);
        assert.equal(commandPhase(item), timeout ? "timed_out" : "failed");
      } finally {
        await env.close();
      }
    }
  },
);

test("nonzero fallback visibly explains ambiguity and retains raw error/output and code in both languages", async () => {
  const item = project({ output: "grep: missing file", exitCode: 2 });
  try {
    for (const language of ["en", "zh-CN"]) {
      await i18n.changeLanguage(language);
      const html = renderToStaticMarkup(
        React.createElement(ToolResultFallback, { item }),
      );
      assert.ok(html.includes(i18n.t("shell:shellNonzeroHint")));
      assert.match(html, /grep: missing file/);
      assert.ok(html.includes(i18n.t("panels:exitCode") + " 2"));
      assert.match(html, /shell-nonzero-note/);
    }
  } finally {
    await i18n.changeLanguage("en");
  }
});

test(
  "real explicit cancellation remains cancelled rather than a shell nonzero result",
  { skip: process.platform === "win32" },
  async () => {
    const env = new ToolEnvironment({
      runtimes: [new ShellToolRuntime()],
      taskOptions: { yieldTimeMs: 1 },
    });
    try {
      const started = await env.execute(env.prepare(invocation("sleep 10")));
      const data = started.structuredContent as { task_id: string };
      const result = await env.waitRuntime.execute({
        ...invocation(""),
        name: "wait",
        arguments: {
          task_id: data.task_id,
          yield_time_ms: 1000,
          terminate: true,
        },
      });
      const item = project(result, "wait");
      assert.equal(isShellNonzeroResult(item), false);
      assert.equal(commandPhase(item), "cancelled");
      assert.equal(item.exitCode, 130);
    } finally {
      await env.close();
    }
  },
);

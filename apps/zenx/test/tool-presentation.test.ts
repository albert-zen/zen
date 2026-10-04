import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "../src/protocol-client/index.js";
import {
  commandSummary,
  commandTitle,
  toolPresentation,
} from "../src/renderer/src/tool-presentation.js";

test("known browser and computer operations have readable labels without inventing target content", () => {
  assert.deepEqual(toolPresentation("browser_inspect"), {
    category: "Browser",
    icon: "browser",
    action: "Inspect page",
  });
  assert.equal(toolPresentation("zenx_computer_press").action, "Press element");
  assert.equal(toolPresentation("my_browser_click").action, undefined);
  assert.equal(toolPresentation("browser_unknown").category, "Tool");
  assert.equal(toolPresentation("run_code").category, "Code");
});

test("shell and other built-in tools do not fall back to a generic Tool label", () => {
  assert.deepEqual(toolPresentation("shell"), {
    category: "Shell",
    icon: "terminal",
    action: "Run command",
  });
  assert.equal(toolPresentation("zenx_shell").category, "Shell");
  assert.equal(toolPresentation("wait").category, "Wait");
  assert.equal(toolPresentation("wait").icon, "clock");
  assert.equal(toolPresentation("view_image").category, "Image");
});

test("successful thread actions describe the completed operation without claiming the target work finished", () => {
  const cases = [
    ["zenx_threads_send", "Sent message", "send"],
    ["zenx_threads_create", "Created thread", "plus"],
    ["zenx_threads_rename", "Renamed thread", "compose"],
    ["zenx_threads_read", "Read thread", "thread"],
    ["zenx_threads_list", "Listed threads", "thread"],
    ["zenx_threads_status", "Checked thread status", "thread"],
    ["zenx_threads_configure", "Configured thread", "settings"],
    ["zenx_threads_archive", "Archived thread", "archive"],
    ["zenx_threads_unarchive", "Restored thread", "restore"],
  ] as const;
  for (const [name, title, icon] of cases) {
    const item = command(name);
    assert.equal(commandTitle(item), title);
    assert.equal(commandSummary(item), title);
    assert.equal(toolPresentation(name).category, "Thread");
    assert.equal(toolPresentation(name).icon, icon);
  }
});

test("generic successful tools retain their factual title without a redundant completed suffix", () => {
  assert.equal(commandSummary(command("unknown_tool")), "unknown tool");
  assert.equal(
    commandSummary({
      ...command("run_code"),
      toolArguments: { description: "Compare available models" },
    }),
    "Compare available models",
  );
  assert.equal(
    commandSummary({ ...command("shell"), toolArguments: { command: "pwd" } }),
    "Ran · pwd",
  );
});

test("thread failures and active phases remain visible without past-tense success labels", () => {
  const send = command("zenx_threads_send");
  assert.equal(
    commandSummary({ ...send, status: "inProgress" }),
    "Send message · started",
  );
  assert.equal(
    commandSummary({ ...send, status: "failed" }),
    "Send message · failed",
  );
  assert.equal(
    commandSummary({ ...send, status: "declined" }),
    "Send message · declined",
  );
  for (const [status, label] of [
    ["running", "running"],
    ["queued", "queued"],
    ["cancel_requested", "cancelling"],
    ["cancellation_unconfirmed", "cancellation unconfirmed"],
    ["cancelled", "cancelled"],
    ["timed_out", "timed out"],
    ["failed", "failed"],
  ] as const) {
    assert.equal(
      commandSummary({
        ...send,
        contentType: "application/vnd.zen.tool-task+json",
        structuredContent: { status },
      }),
      `Send message · ${label}`,
    );
  }
});

test("thread presentation uses the actual tool name rather than command text or a similar custom name", () => {
  assert.equal(
    commandSummary({
      ...command("my_zenx_threads_send"),
      command: "zenx_threads_send",
    }),
    "my zenx threads send",
  );
  assert.equal(toolPresentation("my_zenx_threads_send").category, "Tool");
  assert.equal(
    commandSummary({
      ...command("zenx_threads_send"),
      toolName: undefined,
      command: "zenx_threads_send target text",
    }),
    "zenx_threads_send target text",
  );
  assert.equal(
    commandSummary({
      ...command("shell"),
      command: "zenx_threads_send",
      toolArguments: { command: "zenx_threads_send" },
    }),
    "Ran · zenx_threads_send",
  );
});

function command(
  toolName: string,
): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id: "command",
    pluginId: null,
    scriptPath: null,
    command: toolName,
    toolName,
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "ok",
    exitCode: 0,
    durationMs: null,
  };
}

test("context compaction uses the same category/status presentation as other tools", () => {
  const compact = command("compact_context");
  assert.deepEqual(toolPresentation("compact_context"), {
    category: "Context",
    icon: "compress",
    action: "Compact context",
  });
  assert.equal(commandSummary(compact), "Context compacted");
  assert.equal(
    commandSummary({ ...compact, status: "inProgress" }),
    "Compact context · started",
  );
  assert.equal(
    commandSummary({ ...compact, status: "failed" }),
    "Compact context · failed",
  );
});

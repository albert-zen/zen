import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "../src/protocol-client/index.js";
import {
  commandPhase,
  commandStatus,
  isShellNonzeroResult,
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
  const requested = { ...send, status: "inProgress" as const };
  assert.equal(commandPhase(requested), "requested");
  assert.equal(
    commandPhase({
      ...requested,
      contentType: "application/vnd.zen.tool-task+json",
      structuredContent: { status: "running" },
    }),
    "requested",
    "a status without a native task identity is not execution evidence",
  );
  assert.equal(commandSummary(requested), "Send message · requested");
  assert.equal(
    commandSummary({ ...send, status: "failed" }),
    "Send message · failed",
  );
  assert.equal(
    commandSummary({ ...send, status: "declined" }),
    "Send message · declined",
  );
  for (const [status, label] of [
    ["admitting", "preparing"],
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
        structuredContent: { task_id: "thread-action-task", status },
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

test("concurrent browser tools use readable backend labels without execution aliases", () => {
  assert.deepEqual(toolPresentation("browser_workspace_inspect"), {
    category: "ZenX browser",
    icon: "browser",
    action: "Inspect page",
  });
  assert.deepEqual(toolPresentation("browser_connected_inspect"), {
    category: "External browser",
    icon: "browser",
    action: "Inspect page",
  });
  assert.equal(
    commandTitle(command("browser_connected_inspect")),
    "Inspected page",
  );
  assert.equal(toolPresentation("browser_connected_unknown").category, "Tool");
});

test("shell nonzero presentation never claims success or infers grep semantics", () => {
  for (const exitCode of [1, 2, 125, 127, 128, 130, 143]) {
    for (const output of [
      "",
      "grep: missing file",
      "spawn /bin/sh ENOENT",
      "[output truncated]",
    ]) {
      const item = {
        ...command("shell"),
        status: "failed" as const,
        exitCode,
        aggregatedOutput: output,
      };
      const before = structuredClone(item);
      assert.equal(isShellNonzeroResult(item), true);
      assert.equal(commandStatus(item), "Shell returned a nonzero status");
      assert.equal(commandPhase(item), "failed");
      assert.deepEqual(item, before);
    }
  }
  for (const toolName of [
    "unknown_tool",
    "run_code",
    "my_shell",
    "zenx_shell",
  ]) {
    assert.equal(
      isShellNonzeroResult({
        ...command(toolName),
        status: "failed",
        exitCode: 1,
        command: "grep absent file",
      }),
      false,
    );
  }
  for (const exitCode of [null, 0]) {
    assert.equal(
      isShellNonzeroResult({ ...command("shell"), status: "failed", exitCode }),
      false,
    );
  }
  for (const status of ["completed", "inProgress", "declined"] as const) {
    assert.equal(
      isShellNonzeroResult({ ...command("shell"), status, exitCode: 1 }),
      false,
    );
  }
});

test("shell receipts keep lifecycle failures distinct from nonzero results", () => {
  const base = {
    ...command("wait"),
    status: "failed" as const,
    exitCode: 1,
    contentType: "application/vnd.zen.tool-task+json",
    structuredContent: {
      task_id: "shell-task",
      tool_name: "shell",
      status: "failed",
      exit_code: 1,
      foreground: "exited",
      stdio: "eof",
      foreground_exit_code: 1,
      foreground_signal: null,
    },
  };
  assert.equal(isShellNonzeroResult(base), true);
  assert.equal(commandStatus(base), "Shell returned a nonzero status");
  assert.equal(commandPhase(base), "failed");
  for (const status of [
    "timed_out",
    "cancelled",
    "cancellation_unconfirmed",
    "running",
    "queued",
  ]) {
    assert.equal(
      isShellNonzeroResult({
        ...base,
        structuredContent: { ...base.structuredContent, status },
      }),
      false,
    );
  }
  for (const patch of [
    { foreground_signal: "SIGTERM" },
    { foreground_exit_code: null },
    { foreground_exit_code: 2 },
    { stdio: "open" },
    { foreground: "running" },
    { exit_code: 2 },
    { tool_name: "other" },
  ]) {
    assert.equal(
      isShellNonzeroResult({
        ...base,
        structuredContent: { ...base.structuredContent, ...patch },
      }),
      false,
    );
  }
  const remote = {
    ...base,
    structuredContent: {
      task_id: "remote-task",
      tool_name: "shell",
      status: "failed",
      exit_code: 1,
    },
  };
  assert.equal(
    isShellNonzeroResult(remote),
    true,
    "remote receipt cannot prove process lifecycle",
  );
  assert.equal(
    isShellNonzeroResult({
      ...remote,
      structuredContent: { status: "failed", tool_name: "shell", exit_code: 1 },
    }),
    false,
  );
  assert.equal(
    isShellNonzeroResult({
      ...command("shell"),
      status: "failed",
      exitCode: 1,
      contentType: "zen.imported-tool-result.v1",
    }),
    false,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { i18n } from "../src/renderer/src/i18n.js";
import {
  traceSummary,
  traceGroupIcon,
} from "../src/renderer/src/turn-projection.js";
import {
  runtimeCommand,
  runtimeTask,
  runtimeWait,
} from "./fixtures/agent-runtime-data.js";

function call(id: string, name: string) {
  return { ...runtimeCommand(id, name), toolName: name };
}

test("settled groups lead with action sets, count calls rather than invented files, and retain unknown tool names", () => {
  const commands = ["a", "b", "c"].map((id) => ({
    ...call(id, "shell"),
    toolArguments: { command: "cat same-file.txt" },
  }));
  assert.equal(traceSummary(commands), "Run command ×3");
  assert.equal(traceGroupIcon(commands), "terminal");
  const mixed = [
    ...commands,
    call("page", "browser_inspect"),
    call("image", "view_image"),
  ];
  assert.equal(
    traceSummary(mixed),
    "Run command ×3 · Inspect page ×1 · 1 other action",
  );
  assert.equal(traceGroupIcon(mixed), "list-detail");
  assert.equal(
    traceSummary([...mixed, call("custom", "acme_read_record")]),
    "acme_read_record ×1 · Run command ×3 · Inspect page ×1 · 1 other action",
  );
  assert.equal(
    traceSummary([
      call("x", "acme_read_record"),
      call("y", "acme_read_record"),
    ]),
    "acme_read_record ×2",
  );
  assert.equal(
    traceSummary([call("x", "run_code"), call("y", "run_code")]),
    "Run code ×2",
  );
  assert.equal(
    traceSummary([
      call("x", "acme_read_record"),
      call("y", "zenx_acme_read_record"),
    ]),
    "acme_read_record ×1 · zenx_acme_read_record ×1",
    "normalization of known aliases must not merge different unknown capabilities",
  );
});

test("nested calls remain separate observations and the summary does not turn failed results into success claims", () => {
  const parent = { ...call("parent", "run_code"), callId: "parent-call" };
  const child = {
    ...call("child", "shell"),
    callId: "child-call",
    parentCallId: "parent-call",
    status: "failed" as const,
    exitCode: 1,
  };
  assert.equal(traceSummary([parent, child]), "Run code ×1 · Run command ×1");
  assert.equal(
    traceSummary([child, { ...child, id: "child-two" }]),
    "Run command ×2",
  );
});

test("explicit actions with the same label retain their different surfaces", () => {
  assert.equal(
    traceSummary([
      call("browser", "browser_type"),
      call("device", "computer_set_value"),
      call("page", "browser_inspect"),
    ]),
    "Browser: Fill field ×1 · Computer: Fill field ×1 · 1 other action",
  );
  assert.equal(
    traceSummary([
      call("workspace", "zenx_browser_workspace_type"),
      call("connected", "zenx_browser_connected_type"),
      call("device", "computer_set_value"),
    ]),
    "Browser: Fill field ×2 · Computer: Fill field ×1",
  );
});

test("live groups name the real current operation and retain waiting semantics", () => {
  const done = call("done", "browser_inspect");
  const running = runtimeTask("active", "task", "running");
  assert.equal(
    traceSummary([done, running]),
    "Running · npm run check --workspace @zen/zenx",
  );
  assert.equal(
    traceSummary([done, runtimeWait("wait", "task")]),
    "Waiting for task",
  );
});

test("action summary and omitted call count are localized", async () => {
  await i18n.changeLanguage("zh-CN");
  try {
    const items = [
      call("a", "shell"),
      call("b", "shell"),
      call("c", "browser_inspect"),
      call("d", "view_image"),
      call("e", "view_image"),
    ];
    assert.equal(
      traceSummary(items),
      "运行命令 ×2 · 检查页面 ×1 · 其他 2 次操作",
    );
  } finally {
    await i18n.changeLanguage("en");
  }
});

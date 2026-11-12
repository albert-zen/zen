import assert from "node:assert/strict";
import test from "node:test";
import { i18n } from "../src/renderer/src/i18n.js";
import {
  traceSummary,
  traceGroupIcons,
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
  assert.equal(traceSummary(commands), "Ran 3 commands");
  assert.deepEqual(traceGroupIcons(commands), ["terminal"]);
  const mixed = [
    ...commands,
    call("page", "browser_inspect"),
    call("image", "view_image"),
  ];
  assert.equal(
    traceSummary(mixed),
    "Viewed images and inspected page, plus 3 other actions",
  );
  assert.deepEqual(traceGroupIcons(mixed), ["terminal", "browser"]);
  assert.equal(
    traceSummary([...mixed, call("custom", "acme_read_record")]),
    "Called acme_read_record and viewed images, plus 4 other actions",
  );
  assert.equal(
    traceSummary([
      call("x", "acme_read_record"),
      call("y", "acme_read_record"),
    ]),
    "Called acme_read_record",
  );
  assert.equal(
    traceSummary([call("x", "run_code"), call("y", "run_code")]),
    "Ran code",
  );
  assert.equal(
    traceSummary([
      call("x", "acme_read_record"),
      call("y", "zenx_acme_read_record"),
    ]),
    "Called zenx_acme_read_record and called acme_read_record",
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
  assert.equal(
    traceSummary([parent, child]),
    "Attempted to run command and ran code",
  );
  assert.equal(
    traceSummary([child, { ...child, id: "child-two" }]),
    "Attempted to run command",
  );
});

test("explicit actions with the same label retain their different surfaces", () => {
  assert.equal(
    traceSummary([
      call("browser", "browser_type"),
      call("device", "computer_set_value"),
      call("page", "browser_inspect"),
    ]),
    "Inspected page and computer: filled field, plus 1 other action",
  );
  assert.equal(
    traceSummary([
      call("workspace", "zenx_browser_workspace_type"),
      call("connected", "zenx_browser_connected_type"),
      call("device", "computer_set_value"),
    ]),
    "Computer: filled field and browser: filled field",
  );
});

test("live groups name the real current operation and retain waiting semantics", () => {
  const done = call("done", "browser_inspect");
  const running = {
    ...runtimeTask("active", "task", "running"),
    status: "inProgress" as const,
  };
  assert.equal(
    traceSummary([done, running]),
    "npm run check --workspace @zen/zenx · requested",
  );
  assert.equal(
    traceSummary([
      done,
      { ...runtimeWait("wait", "task"), status: "inProgress" },
    ]),
    "Wait for task · requested",
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
    assert.equal(traceSummary(items), "查看了图片，并已检查页面；另有2次操作");
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("meaningful and recent actions win without losing counts or changing underlying order", () => {
  const items = [
    call("compact", "compact_context"),
    call("image", "view_image"),
    call("wait-a", "wait"),
    call("wait-b", "wait"),
  ];
  const before = JSON.stringify(items);
  assert.equal(
    traceSummary(items),
    "Compacted context and viewed images, plus 2 other actions",
  );
  assert.equal(JSON.stringify(items), before);
  const manyUnknown = Array.from({ length: 20 }, (_, i) =>
    call(String(i), `custom_tool_${i}`),
  );
  assert.equal(
    traceSummary(manyUnknown),
    "Called custom_tool_19 and called custom_tool_18, plus 18 other actions",
  );
});

test("declined, imported and unknown outcomes never acquire completed action language", () => {
  for (const status of ["declined", "unknown", "failed"] as const) {
    assert.equal(
      traceSummary([
        { ...call("a", "zenx_threads_send"), status },
        { ...call("b", "zenx_threads_send"), status },
      ]),
      "Attempted to send message",
    );
  }
});

test("Chinese templates combine context boundaries and recent observations without a count list", async () => {
  await i18n.changeLanguage("zh-CN");
  try {
    assert.equal(
      traceSummary([
        call("compact", "compact_context"),
        call("image", "view_image"),
      ]),
      "压缩了上下文，并查看了图片",
    );
    assert.equal(
      traceSummary([
        call("a", "shell"),
        call("b", "shell"),
        call("c", "shell"),
      ]),
      "运行了3次命令",
    );
    assert.equal(
      traceSummary([call("a", "threads_send"), call("b", "threads_send")]),
      "发送了2条消息",
    );
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("Object prototype names remain unknown capabilities in either summary position", () => {
  for (const key of Object.getOwnPropertyNames(Object.prototype)) {
    for (const name of [key, `zenx_${key}`]) {
      const unknown = call("unknown", name);
      const image = call("image", "view_image");
      assert.equal(
        traceSummary([unknown, image]),
        `Viewed images and called ${name}`,
        `${name} before a known capability`,
      );
      assert.equal(
        traceSummary([image, unknown]),
        `Called ${name} and viewed images`,
        `${name} after a known capability`,
      );
      assert.deepEqual(traceGroupIcons([unknown, image]), [
        "terminal",
        "image",
      ]);
    }
  }
});

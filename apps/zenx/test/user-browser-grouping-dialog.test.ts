import assert from "node:assert/strict";
import test from "node:test";
import { connectUserBrowserCdp } from "../src/main/capabilities/user-browser-provider.js";
import { createFakeCdpServer } from "./fixtures/user-browser-cdp.js";

for (const [label, grouping, expected] of [
  [
    "grouped",
    { status: "grouped", groupId: 7 },
    { status: "grouped", groupId: 7 },
  ],
  [
    "group title unavailable",
    {
      status: "grouped",
      groupId: 7,
      reason: "Group title could not be updated",
    },
    {
      status: "grouped",
      groupId: 7,
      reason: "Group title could not be updated",
    },
  ],
  [
    "group failed",
    { status: "failed", reason: "Grouping rejected" },
    { status: "failed", reason: "Grouping rejected" },
  ],
  [
    "API unavailable",
    { status: "unavailable", reason: "Tab groups API unavailable" },
    { status: "unavailable", reason: "Tab groups API unavailable" },
  ],
  [
    "group timeout",
    { status: "unknown", reason: "Grouping may still finish" },
    { status: "unknown", reason: "Grouping may still finish" },
  ],
  [
    "direct CDP",
    undefined,
    {
      status: "unavailable",
      reason: "Tab grouping is unavailable through this browser connection",
    },
  ],
  [
    "invalid group ID",
    { status: "grouped", groupId: -1 },
    {
      status: "unavailable",
      reason: "Tab grouping is unavailable through this browser connection",
    },
  ],
  [
    "invalid metadata",
    "not grouping",
    {
      status: "unavailable",
      reason: "Tab grouping is unavailable through this browser connection",
    },
  ],
  [
    "bounded error",
    { status: "failed", reason: "x".repeat(300), groupId: 55 },
    { status: "failed", reason: "x".repeat(160) },
  ],
] as const) {
  test(`created tab survives ${label} and exposes grouping as metadata`, async () => {
    const cdp = await createFakeCdpServer({ createGrouping: grouping });
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    try {
      const opened = await connection.backend.open(
        "work",
        "https://example.test/new",
      );
      assert.equal(opened.tabId, "target-2");
      assert.equal(opened.url, "https://example.test/new");
      assert.deepEqual(opened.grouping, expected);
      assert.equal(cdp.count("Target.createTarget"), 1);
      assert.equal(cdp.count("Page.navigate"), 1);
      assert.deepEqual(cdp.requests("Target.attachToTarget"), [
        { targetId: "target-2", flatten: true },
      ]);
      assert.equal(
        cdp.methods().some((method) => /activate|bringToFront/i.test(method)),
        false,
      );
      await assert.rejects(
        connection.backend.inspect("other-session", "target-2"),
        /Unknown user browser session/,
      );
    } finally {
      await connection.backend.close();
      await cdp.close();
    }
  });
}

for (const kind of ["pointer", "key"] as const) {
  test(`an exact-session native dialog blocks ${kind} before dispatch without auto-handling it`, async () => {
    const cdp = await createFakeCdpServer({ targetedInput: true });
    const connection = await connectUserBrowserCdp(cdp.endpoint);
    try {
      await connection.backend.listTabs("work");
      const observed = await connection.backend.inspect("work", "target-1");
      cdp.emitSessionEvent("Page.javascriptDialogOpening", {
        type: "alert",
        message: "fixture",
      });
      await connection.backend.listTabs("work"); // Drain the event ahead of the action.
      const before = cdp.commandRequests().length;
      await assert.rejects(
        kind === "pointer"
          ? connection.backend.pointerClick!(
              "work",
              "target-1",
              observed.observationId,
              1,
              1,
            )
          : connection.backend.keyPress!(
              "work",
              "target-1",
              observed.observationId,
              "Enter",
            ),
        /Native dialog requires human control/,
      );
      assert.equal(
        cdp.commandRequests().length,
        before,
        "known dialog rejects before even probing the document",
      );
      assert.equal(
        cdp.methods().includes("Page.handleJavaScriptDialog"),
        false,
      );
      // A close event from another session cannot clear the dialog guard.
      cdp.emitSessionEvent(
        "Page.javascriptDialogClosed",
        {},
        "unrelated-session",
      );
      await connection.backend.listTabs("work");
      await assert.rejects(
        connection.backend.pointerClick!(
          "work",
          "target-1",
          observed.observationId,
          1,
          1,
        ),
        /Native dialog requires human control/,
      );
      cdp.emitSessionEvent("Page.javascriptDialogClosed", { result: false });
      await connection.backend.listTabs("work");
      const refreshed = await connection.backend.inspect("work", "target-1");
      await connection.backend.pointerClick!(
        "work",
        "target-1",
        refreshed.observationId,
        1,
        1,
      );
      assert.equal(cdp.count("Input.dispatchMouseEvent"), 2);
    } finally {
      await connection.backend.close();
      await cdp.close();
    }
  });
}

test("a dialog after mouse press reports unknown and never releases or auto-accepts", async () => {
  const cdp = await createFakeCdpServer({ targetedInput: true });
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  try {
    await connection.backend.listTabs("work");
    const observed = await connection.backend.inspect("work", "target-1");
    cdp.interceptRequests((request, emit) => {
      if (request.params.type === "mousePressed")
        emit({
          method: "Page.javascriptDialogOpening",
          sessionId: request.sessionId,
          params: { type: "confirm", message: "fixture" },
        });
    });
    await assert.rejects(
      connection.backend.pointerClick!(
        "work",
        "target-1",
        observed.observationId,
        1,
        1,
      ),
      /outcome is unknown.*Native dialog requires human control/,
    );
    assert.equal(cdp.count("Input.dispatchMouseEvent"), 1);
    assert.equal(cdp.methods().includes("Page.handleJavaScriptDialog"), false);
    cdp.emitSessionEvent("Page.javascriptDialogClosed", { result: false });
    await assert.rejects(
      connection.backend.inspect("work", "target-1"),
      /tainted|outcome is unknown/,
    );
  } finally {
    await Promise.resolve(connection.backend.close()).catch(() => undefined);
    await cdp.close();
  }
});

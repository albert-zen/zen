import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  sidebarTriggerAdmissionId,
  useSidebarTriggers,
} from "../src/renderer/src/sidebar-thread-information.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

const facts = (id: string) => ({
  triggers: [{ id, threadId: "thread", kind: "timer", active: true }],
});
async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const reads: Array<(value: unknown) => void> = [];
  const commands: string[] = [];
  Object.assign(window, {
    zenx: {
      plugins: {
        executeCommand: (plugin: string, command: string) => {
          assert.equal(plugin, "zenx-triggers");
          commands.push(command);
          return new Promise((resolve) => reads.push(resolve));
        },
      },
    },
  });
  let latest: ReturnType<typeof useSidebarTriggers>;
  function Harness({
    admission,
    revision,
  }: {
    admission: string | null;
    revision: string;
  }) {
    latest = useSidebarTriggers(admission, revision);
    return React.createElement(
      "span",
      null,
      latest.state.status + ":" + latest.state.triggers.map((t) => t.id).join(),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  return {
    reads,
    commands,
    render: (admission: string | null, revision = "page:idle") =>
      act(async () =>
        root.render(React.createElement(Harness, { admission, revision })),
      ),
    refresh: (force = false) => {
      void latest!.refresh(force);
    },
    finish: (index: number, value: unknown) =>
      act(async () => reads[index]!(value)),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test("Trigger admission replacement serializes a new read and never republishes its old receipt", async () => {
  const f = await fixture();
  try {
    await f.render("admission-a");
    await act(async () => {
      f.refresh();
      f.refresh();
    });
    assert.equal(f.reads.length, 1);
    await f.render("admission-b");
    assert.equal(document.body.textContent, "loading:");
    assert.equal(
      f.reads.length,
      1,
      "old IPC drains without overlapping a new read",
    );
    await f.finish(0, facts("stale"));
    assert.equal(
      f.reads.length,
      2,
      "replacement still receives its own authoritative read",
    );
    assert.equal(document.body.textContent, "loading:");
    await f.finish(1, facts("current"));
    assert.equal(document.body.textContent, "ready:current");
    await f.render(null);
    assert.equal(document.body.textContent, "unavailable:");
    assert.deepEqual(
      f.commands,
      ["sidebar-facts", "sidebar-facts"],
      "never fall back to broad list",
    );
  } finally {
    await f.close();
  }
});

test("runtime revision during a pending Trigger read gets a trailing current-revision read", async () => {
  const f = await fixture();
  try {
    await f.render("same-admission", "page:idle");
    await f.render("same-admission", "page:active");
    await f.finish(0, facts("stale"));
    assert.equal(document.body.textContent, "loading:");
    assert.equal(f.reads.length, 2);
    await f.finish(1, facts("current"));
    assert.equal(document.body.textContent, "ready:current");
  } finally {
    await f.close();
  }
});

test("forced focus refresh coalesces one trailing read while ordinary inspection stays cached", async () => {
  const f = await fixture();
  try {
    await f.render("admission");
    await act(async () => {
      f.refresh(true);
      f.refresh(true);
      f.refresh();
    });
    await f.finish(0, facts("first"));
    assert.equal(
      f.reads.length,
      2,
      "forced events during a read are not silently lost",
    );
    await f.finish(1, facts("latest"));
    await act(async () => {
      f.refresh();
      f.refresh();
    });
    assert.equal(
      f.reads.length,
      2,
      "repeated hover does not bypass the one-second cache",
    );
    assert.equal(document.body.textContent, "ready:latest");
  } finally {
    await f.close();
  }
});

function snapshot(
  admissionId: string,
  supportsFacts = true,
): ZenXPluginSnapshot {
  return {
    plugins: [
      {
        id: "zenx-triggers",
        version: "1.0.0",
        enabled: true,
        available: true,
        admissionId,
      },
    ],
    commands: supportsFacts
      ? [{ pluginId: "zenx-triggers", id: "sidebar-facts" }]
      : [],
  } as unknown as ZenXPluginSnapshot;
}
test("Trigger facts require declared command and actual admission identity, not version or unrelated catalog notifications", async () => {
  assert.equal(sidebarTriggerAdmissionId(snapshot("one", false)), null);
  assert.equal(sidebarTriggerAdmissionId(snapshot("")), null);
  const f = await fixture();
  try {
    const first = snapshot("one");
    await f.render(sidebarTriggerAdmissionId(first));
    await f.finish(0, facts("old"));
    const unrelated = {
      ...first,
      plugins: [...first.plugins, { id: "other", version: "9" } as any],
    };
    await f.render(sidebarTriggerAdmissionId(unrelated));
    assert.equal(
      f.reads.length,
      1,
      "unrelated catalog change does not restart Trigger reads",
    );
    await f.render(sidebarTriggerAdmissionId(snapshot("two")));
    assert.equal(
      document.body.textContent,
      "loading:",
      "same-version replacement immediately hides old facts",
    );
    assert.equal(f.reads.length, 2);
    await f.finish(1, facts("new"));
    assert.equal(document.body.textContent, "ready:new");
  } finally {
    await f.close();
  }
});

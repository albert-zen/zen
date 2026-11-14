import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EditableInformationPanel } from "../src/renderer/src/EditableInformationPanel.js";
import { NativeInformationService } from "../src/main/native-information-service.js";
import { ThreadSidebarStore } from "../src/main/thread-sidebar-store.js";
import { createPluginUiRegistry } from "../src/renderer/src/plugin-ui-host.js";
import { registerSubagentsUi } from "../src/renderer/src/subagents-ui.js";
import { workspaceLauncherSnapshot } from "./workspace-launcher-snapshot.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { SidebarOwner } from "../src/thread-sidebar-state.js";
import type { InformationCommunications } from "../src/renderer/src/information-communications.js";
import {
  MessageSourceNavigationContext,
  type MessageSourceNavigator,
} from "../src/renderer/src/message-source-navigation.js";

const PRIVATE = "PRIVATE-THREAD-ONLY excerpt";
const projection = (
  ownerThreadId: string,
  excerpt = PRIVATE,
): InformationCommunications => ({
  ownerThreadId,
  messages: [
    {
      id: `message-${ownerThreadId}`,
      senderThreadId: "sender-distinct-id",
      senderName: "Same display name",
      sourceTool: {
        itemId: `tool-${ownerThreadId}`,
        callId: `call-${ownerThreadId}`,
      },
      excerpt,
    },
  ],
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function waitFor(check: () => unknown, label: string) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  assert.ok(check(), label);
}
async function fixture() {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const directory = await mkdtemp(
    path.join(tmpdir(), "information-owner-boundary-"),
  );
  const store = new ThreadSidebarStore(directory);
  const members = [{ threadId: "private-owner", name: "Same display name" }];
  const service = new NativeInformationService({
    sidebar: store,
    assertThreadExists: async () => {},
    rooms: () =>
      ["room", "paw-room"].map((id) => ({
        id,
        assistant: { threadId: "private-owner" },
        members,
      })),
  });
  const calls: string[] = [];
  const reads: string[] = [];
  let held: { id: string; gate: ReturnType<typeof deferred> } | undefined;
  const navigation = deferred();
  let sourceRequest: Parameters<MessageSourceNavigator> | undefined;
  const navigate: MessageSourceNavigator = async (...args) => {
    sourceRequest = args;
    await navigation.promise;
  };
  Object.assign(dom.window, {
    zenx: {
      information: {
        read: async (owner: SidebarOwner) => {
          reads.push(`${owner.kind}:${owner.id}`);
          // This synthetic callback stands in for the separately tested native owned-document lease.
          const value = await service.read(owner, () => {});
          const pending = held?.id === owner.id ? held : undefined;
          if (pending) {
            held = undefined;
            await pending.gate.promise;
          }
          return {
            ...value,
            layout: {
              ...value.layout,
              widgets: value.layout.widgets.filter(
                (w) => w.type === "lineage" || w.type === "room-members",
              ),
            },
          };
        },
        update: async () => {
          throw Error("Unexpected information mutation");
        },
      },
      threadSidebar: { onChanged: () => () => {} },
      plugins: {
        executeCommand: async (plugin: string, command: string) => {
          calls.push(`${plugin}:${command}`);
          assert.equal(plugin, "zenx-subagents");
          assert.equal(command, "list");
          return { threads: [] };
        },
        readHandle: async () => {
          calls.push("unexpected-read-handle");
          throw Error("Unexpected handle read");
        },
      },
      protocol: {
        request: async () => {
          calls.push("unexpected-transcript-read");
          throw Error("Unexpected transcript read");
        },
      },
    },
  });
  const registry = createPluginUiRegistry();
  registerSubagentsUi(registry);
  const root = createRoot(document.getElementById("root")!);
  const render = (
    owner: SidebarOwner,
    communications?: InformationCommunications,
  ) =>
    act(async () => {
      root.render(
        React.createElement(
          MessageSourceNavigationContext.Provider,
          { value: navigate },
          React.createElement(EditableInformationPanel, {
            owner:
              owner.kind === "thread"
                ? { kind: "thread", threadId: owner.id }
                : { kind: "room", roomId: owner.id },
            communications,
            threads: [],
            snapshot: workspaceLauncherSnapshot,
            registry,
            theme: "light",
            navigate() {},
            roomMembers: owner.kind === "room" ? members : undefined,
          }),
        ),
      );
    });
  const noPrivate = () => {
    assert.equal(document.querySelector(".information-communications"), null);
    assert.ok(!document.body.textContent?.includes(PRIVATE));
    assert.equal(
      document.querySelector(
        ".information-communications .message-source-link",
      ),
      null,
    );
  };
  return {
    render,
    noPrivate,
    calls,
    reads,
    sourceRequest: () => sourceRequest,
    holdRead(id: string) {
      const gate = deferred();
      held = { id, gate };
      return gate;
    },
    async roomReady(id: string) {
      await waitFor(
        () =>
          document.querySelector(
            `[data-owner="room:${id}"] .information-members`,
          ),
        "real Room members remain visible",
      );
      assert.match(
        document.querySelector(".information-members")!.textContent!,
        /Same display name/,
      );
    },
    async privateReady() {
      await waitFor(
        () =>
          document.querySelector(
            ".information-communications .message-source-link",
          ),
        "private Thread communication is visible",
      );
    },
    async close() {
      navigation.resolve();
      held?.gate.resolve();
      await act(async () => root.unmount());
      await store.close();
      await rm(directory, { recursive: true, force: true });
      dom.window.close();
      Object.assign(globalThis, prior);
    },
  };
}

test("real Information panel excludes private matching-member projection from Room/PAW and retires source links", async () => {
  const f = await fixture();
  try {
    const privateProjection = projection("private-owner");
    await f.render({ kind: "thread", id: "private-owner" }, privateProjection);
    await f.privateReady();
    const button = document.querySelector<HTMLButtonElement>(
      ".information-communications .message-source-link",
    )!;
    await act(async () => button.click());
    assert.deepEqual(f.sourceRequest()?.[0], {
      kind: "thread",
      id: "sender-distinct-id",
      sourceTool: {
        itemId: "tool-private-owner",
        callId: "call-private-owner",
      },
    });
    assert.equal(f.sourceRequest()?.[1].threadId, "private-owner");
    assert.equal(f.sourceRequest()?.[1].isCurrent(), true);
    for (const id of ["room", "paw-room"]) {
      // Deliberately supply the SAME private projection, whose owner matches the Room's actual resource member.
      await f.render({ kind: "room", id }, privateProjection);
      f.noPrivate();
      await f.roomReady(id);
      f.noPrivate();
      assert.equal(f.sourceRequest()?.[1].isCurrent(), false);
    }
    await f.render({ kind: "thread", id: "other-owner" }, privateProjection);
    f.noPrivate();
    await f.render(
      { kind: "thread", id: "other-owner" },
      projection("other-owner", "OTHER-OWNER excerpt"),
    );
    await f.privateReady();
    assert.match(
      document.querySelector(".information-communications")!.textContent!,
      /OTHER-OWNER excerpt/,
    );
    assert.ok(!document.body.textContent?.includes(PRIVATE));
    await f.render({ kind: "thread", id: "other-owner" }, undefined);
    f.noPrivate();
    assert.ok(f.calls.length > 0);
    assert.deepEqual([...new Set(f.calls)], ["zenx-subagents:list"]);
  } finally {
    await f.close();
  }
});

test("late private Thread layout receipt cannot restore private communications after switching to Room", async () => {
  const f = await fixture();
  const held = f.holdRead("private-owner");
  try {
    const privateProjection = projection("private-owner");
    await f.render({ kind: "thread", id: "private-owner" }, privateProjection);
    await waitFor(
      () => f.reads.includes("thread:private-owner"),
      "old owner read started",
    );
    await f.render({ kind: "room", id: "room" }, privateProjection);
    await f.roomReady("room");
    f.noPrivate();
    await act(async () => {
      held.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    f.noPrivate();
    assert.ok(
      document.querySelector('[data-owner="room:room"] .information-members'),
    );
    await f.render({ kind: "thread", id: "private-owner" }, privateProjection);
    await f.privateReady();
    assert.match(
      document.querySelector(".information-communications")!.textContent!,
      /PRIVATE-THREAD-ONLY/,
    );
    assert.deepEqual([...new Set(f.calls)], ["zenx-subagents:list"]);
  } finally {
    held.resolve();
    await f.close();
  }
});

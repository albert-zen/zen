import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  RoomsPage,
  TriggersPage,
  roomReplySetupEditor,
  roomReplySetupRoute,
  triggerEditorInput,
} from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import type { ThreadCandidate } from "../src/main/thread-target.js";
import type { ZenXRoom, ZenXTrigger } from "../src/main/trigger-types.js";

const intent = { roomId: "room ?中", member: "Helper", threadId: "target" };
const room: ZenXRoom = {
  id: intent.roomId,
  name: "Work",
  members: [{ name: intent.member, threadId: intent.threadId }],
  messages: [],
  createdAt: 1,
};
const threads = [
  {
    threadId: "target",
    shortId: "target",
    name: "Member conversation",
    cwd: "/work",
    status: "idle",
    archived: false,
  },
] as ThreadCandidate[];

test("Room setup validates exact live membership, target availability and existing definitions", () => {
  const draft = roomReplySetupEditor(intent, [room], threads, []);
  assert("editor" in draft);
  assert.equal(draft.editor.kind, "roomMention");
  assert.equal(draft.editor.condition, `${room.id}|Helper`);
  assert.equal(draft.editor.threadId, "target");
  assert.equal(
    draft.editor.prompt,
    "",
    "instructions must be reviewed explicitly",
  );
  const archived = roomReplySetupEditor(
    intent,
    [room],
    [{ ...threads[0]!, archived: true }],
    [],
  );
  assert("error" in archived);
  assert.match(archived.error, /archived.*Unarchive/);
  for (const [rooms, targets] of [
    [[], threads],
    [
      [{ ...room, members: [{ name: "Helper", threadId: "replacement" }] }],
      threads,
    ],
    [[room], []],
  ] as Array<[ZenXRoom[], ThreadCandidate[]]>) {
    assert("error" in roomReplySetupEditor(intent, rooms, targets, []));
  }
  const existing = {
    id: "existing",
    threadId: "target",
    kind: "roomMention",
    label: "Already here",
    prompt: "Reply",
    createdAt: 1,
    active: false,
    room: { roomId: room.id, mention: "helper" },
  } as ZenXTrigger;
  const paused = roomReplySetupEditor(intent, [room], threads, [existing]);
  assert("notice" in paused);
  assert.match(paused.notice, /paused.*Resume/);
  const active = roomReplySetupEditor(intent, [room], threads, [
    { ...existing, active: true },
  ]);
  assert("notice" in active);
  assert.match(active.notice, /already have a trigger/);
  const query = new URL(
    roomReplySetupRoute(intent.roomId, intent.member, intent.threadId),
    "https://zenx.local",
  ).searchParams;
  assert.equal(query.get("roomId"), room.id);
  assert.equal(query.get("member"), "Helper");
});

async function mountSetup(
  options: {
    facts?: ZenXRoom[];
    route?: string;
    gateList?: Promise<void>;
    gateSaveValidation?: Promise<void>;
  } = {},
) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const calls: Array<{ id: string; input: any }> = [];
  const routes: string[] = [];
  let facts = options.facts ?? [room];
  let listReads = 0;
  const sdk = {
    context: {
      route:
        options.route ??
        roomReplySetupRoute(intent.roomId, intent.member, intent.threadId),
    },
    navigation: { navigate: (route: string) => routes.push(route) },
    commands: {
      execute: async (id: string, input: unknown) => {
        calls.push({ id, input });
        if (id === "list") {
          listReads += 1;
          await options.gateList;
          if (listReads > 1) await options.gateSaveValidation;
          return { rooms: structuredClone(facts), triggers: [], history: [] };
        }
        if (id === "threads") return { threads };
        if (id === "workspaces") return { workspaces: ["/work"] };
        if (id === "create") return { id: "created" };
        throw new Error(`Unexpected ${id}`);
      },
    },
  } as unknown as PluginUiSdkV1;
  await act(async () =>
    root.render(React.createElement(TriggersPage, { sdk })),
  );
  return {
    dom,
    calls,
    routes,
    setFacts: (next: ZenXRoom[]) => {
      facts = next;
    },
    click: async (text: string) =>
      act(async () => {
        const button = [...document.querySelectorAll("button")].find(
          (entry) => entry.textContent?.trim() === text,
        );
        assert(button, text);
        button.click();
      }),
    fillPrompt: async () =>
      act(async () => {
        const input = document.querySelector<HTMLTextAreaElement>(
          "form.trigger-editor textarea",
        )!;
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(input, "Reply to the mentioned message");
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      }),
    submit: async () =>
      act(async () =>
        document
          .querySelector("form.trigger-editor")!
          .dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          ),
      ),
    unmount: async () => {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous);
      dom.window.close();
    },
  };
}

test("setup opens only after Host facts arrive, and Cancel/Back never creates or grants permissions", async () => {
  for (const close of ["Cancel", "Back to Room"]) {
    let release!: () => void;
    const gateList = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await mountSetup({ gateList });
    try {
      assert.equal(document.querySelector("form.trigger-editor"), null);
      await act(async () => {
        release();
        await gateList;
      });
      assert(document.querySelector("form.trigger-editor"));
      assert.equal(
        document.querySelector<HTMLTextAreaElement>(
          "form.trigger-editor textarea",
        )!.value,
        "",
      );
      assert.equal(
        document.activeElement,
        document.querySelector("form.trigger-editor input"),
      );
      const context = document.querySelector(
        '[aria-label="Room reply context"]',
      );
      assert(context);
      assert.match(context.textContent!, /@Helper/);
      assert.match(context.textContent!, /#Work/);
      assert.equal(
        document.querySelectorAll("form.trigger-editor select").length,
        0,
      );
      assert(
        ![...document.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "New trigger",
        ),
      );
      await h.click(close);
      assert.equal(
        new URL(h.routes[0]!, "https://zenx.local").searchParams.get("roomId"),
        room.id,
      );
      assert(
        h.calls.every((call) =>
          ["list", "threads", "workspaces"].includes(call.id),
        ),
      );
    } finally {
      await h.unmount();
    }
  }
});

test("explicit setup Save writes the exact existing-member binding; stale membership blocks the write", async () => {
  for (const stale of [false, true]) {
    const h = await mountSetup();
    try {
      await h.fillPrompt();
      if (stale)
        h.setFacts([
          { ...room, members: [{ name: "Helper", threadId: "replacement" }] },
        ]);
      await h.submit();
      const created = h.calls.filter((call) => call.id === "create");
      if (stale) {
        assert.equal(created.length, 0);
        assert.match(
          document.querySelector('[role="alert"]')!.textContent!,
          /member has changed/,
        );
        assert(document.querySelector("form.trigger-editor"));
      } else {
        assert.equal(created.length, 1);
        assert.deepEqual(created[0]!.input, {
          threadId: "target",
          kind: "roomMention",
          label: "Reply as @Helper",
          prompt: "Reply to the mentioned message",
          roomId: room.id,
          mention: "Helper",
        });
        assert.equal(document.querySelector("form.trigger-editor"), null);
      }
      assert.equal(
        h.calls.filter((call) => call.id === "create-target").length,
        0,
      );
    } finally {
      await h.unmount();
    }
  }
});

test("leaving during setup Save validation fences the not-yet-admitted write", async () => {
  let release!: () => void;
  const gateSaveValidation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await mountSetup({ gateSaveValidation });
  try {
    await h.fillPrompt();
    await h.submit();
    await h.click("Back to Room");
    await act(async () => {
      release();
      await gateSaveValidation;
    });
    assert.equal(h.calls.filter((call) => call.id === "create").length, 0);
    assert.equal(h.routes.length, 1);
  } finally {
    await h.unmount();
  }
});

test("stale or malformed setup intent has a friendly return path and never guesses a target", async () => {
  for (const route of [
    roomReplySetupRoute("missing", "Helper", "target"),
    roomReplySetupRoute(room.id, "missing", "target"),
    "/plugins/zenx-triggers/triggers?setup=room-reply",
  ]) {
    const h = await mountSetup({ route });
    try {
      assert.equal(document.querySelector("form.trigger-editor"), null);
      assert.match(
        document.querySelector('[role="alert"]')!.textContent!,
        /no longer available|has changed/,
      );
      assert(
        document
          .querySelector("button")
          ?.textContent?.includes("Back to Room") ||
          document.body.textContent?.includes("Back to Room"),
      );
      assert(
        h.calls.every((call) =>
          ["list", "threads", "workspaces"].includes(call.id),
        ),
      );
    } finally {
      await h.unmount();
    }
  }
});

test("Room setup CTAs select explicit members and returning restores the original non-first Room", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const root = createRoot(document.getElementById("root")!);
  const routes: string[] = [];
  const calls: string[] = [];
  const selectedRoom = {
    ...room,
    members: [...room.members, { name: "Second", threadId: "other" }],
    responders: [
      { name: "Helper", configured: false },
      { name: "Second", configured: false },
    ],
  };
  const sdk = {
    context: {
      route: `/plugins/zenx-rooms/rooms?${new URLSearchParams({ roomId: room.id })}`,
    },
    navigation: { navigate: (route: string) => routes.push(route) },
    commands: {
      execute: async (id: string) => {
        calls.push(id);
        if (id === "list")
          return {
            rooms: [{ ...room, id: "first", name: "First" }, selectedRoom],
          };
        throw new Error(id);
      },
    },
  } as unknown as PluginUiSdkV1;
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    assert.equal(
      document.querySelector(".rooms-chat-header h2")?.textContent,
      "#Work",
    );
    const buttons = [...document.querySelectorAll(".room-setup-note button")];
    assert.equal(buttons.length, 2);
    await act(async () => (buttons[1] as HTMLButtonElement).click());
    const query = new URL(routes[0]!, "https://zenx.local").searchParams;
    assert.equal(query.get("member"), "Second");
    assert.equal(query.get("threadId"), "other");
    assert(calls.length > 0 && calls.every((id) => id === "list"));
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("Room reply setup preserves a permitted vertical bar in the exact member name", () => {
  const member = "Ops|Bot";
  const result = roomReplySetupEditor(
    { ...intent, member },
    [{ ...room, members: [{ name: member, threadId: intent.threadId }] }],
    threads,
    [],
  );
  assert("editor" in result);
  const input = triggerEditorInput({
    ...result.editor,
    prompt: "Reply to the mentioned message",
  });
  assert.equal("mention" in input ? input.mention : null, member);
  assert.equal("roomId" in input ? input.roomId : null, room.id);
});

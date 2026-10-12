import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentProviderEvent,
  AgentProviderInstance,
  AgentProvidersApi,
  AgentSessionSnapshot,
} from "../src/main/agent-providers/types.js";
import type { ModelSummary } from "../src/protocol-client/types.js";
import { AgentProviderSettings } from "../src/renderer/src/AgentProviderSettings.js";
import {
  ExternalAgentSession,
  useAgentModels,
  useAgentProviders,
} from "../src/renderer/src/agent-providers-ui.js";
import {
  emptyComposerState,
  type ComposerState,
} from "../src/renderer/src/composer-state.js";
import { AgentSessionRow } from "../src/renderer/src/Sidebar.js";
import { subscribeAgentRefresh } from "../src/renderer/src/agent-provider-state.js";

const { act, createElement: h } = React;
Object.assign(globalThis, { React });
const codex: AgentProviderInstance = {
  id: "codex-one",
  kind: "codex",
  name: "Codex work",
  defaultModel: "one",
};
const other: AgentProviderInstance = {
  id: "codex-two",
  kind: "codex",
  name: "Codex personal",
};
function model(id: string): ModelSummary {
  return {
    id,
    model: id,
    displayName: id,
    description: "",
    hidden: false,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function snapshot(
  id = "binding-one",
  text = "Native answer",
  running = false,
): AgentSessionSnapshot {
  return {
    binding: {
      id,
      hostId: "host",
      providerInstanceId: codex.id,
      nativeSessionId: `native-${id}`,
      cwd: "/work/project",
    },
    model: "one",
    thread: {
      id,
      sessionId: `native-${id}`,
      name: "Native conversation",
      preview: "Native conversation",
      cwd: "/work/project",
      modelProvider: "codex",
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
      status: running ? { type: "active", activeFlags: [] } : { type: "idle" },
      turns: text
        ? [
            {
              id: "turn",
              itemsView: "full",
              startedAt: 1,
              completedAt: running ? null : 2,
              durationMs: running ? null : 1000,
              status: running ? "inProgress" : "completed",
              items: [
                {
                  id: "answer",
                  type: "agentMessage",
                  text,
                  phase: "final_answer",
                  memoryCitation: null,
                },
              ],
              error: null,
            },
          ]
        : [],
      parentThreadId: null,
      forkedFromId: null,
      ephemeral: false,
      isPinned: false,
      path: null,
      cliVersion: "test",
      source: "appServer",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
    },
  };
}
function api(overrides: Partial<AgentProvidersApi> = {}) {
  const listeners = new Set<(event: AgentProviderEvent) => void>();
  const result: AgentProvidersApi = {
    list: async () => [{ id: "zen", kind: "zen", name: "Zen" }, codex],
    save: async (instance) => instance,
    capabilities: async () => ({
      models: true,
      interrupt: true,
      resume: true,
      changeModel: true,
      approvals: true,
      permissionModes: ["read-only", "workspace-write", "danger-full-access"],
    }),
    models: async () => [model("one")],
    sessions: async () => [],
    approvals: async () => [],
    create: async () => snapshot("binding-one", ""),
    read: async () => snapshot(),
    send: async () => undefined,
    interrupt: async () => undefined,
    respondApproval: async () => undefined,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...overrides,
  };
  return {
    result,
    emit: (event: AgentProviderEvent) =>
      listeners.forEach((listener) => listener(event)),
  };
}
async function mounted(
  run: (ctx: {
    root: ReturnType<typeof createRoot>;
    dom: JSDOM;
    render(element: React.ReactNode): Promise<void>;
  }) => Promise<void>,
  service: AgentProvidersApi,
) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    MouseEvent: globalThis.MouseEvent,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window, "zenx", {
    value: { agentProviders: service },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await run({
      root,
      dom,
      render: async (element) => {
        await act(async () => root.render(element));
      },
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, saved);
    dom.window.close();
  }
}
function button(label: string) {
  const value = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (entry) =>
      entry.textContent?.trim() === label ||
      entry.getAttribute("aria-label") === label,
  );
  assert.ok(value, `Missing button ${label}`);
  return value;
}
async function input(dom: JSDOM, selector: string, text: string) {
  const target = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  assert.ok(target);
  const prototype =
    target.tagName === "TEXTAREA"
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, text);
  await act(async () =>
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true })),
  );
}
function Session({
  instance = codex,
  id = null,
  onCreated = () => undefined,
  composerReady,
}: {
  instance?: AgentProviderInstance;
  id?: string | null;
  onCreated?(snapshot: AgentSessionSnapshot): void;
  composerReady?(state: ComposerState): void;
}) {
  const [composer, setComposer] = React.useState(emptyComposerState());
  composerReady?.(composer);
  return h(ExternalAgentSession, {
    instance,
    sessionId: id,
    composer,
    onComposerChange: setComposer,
    onCreated,
    workspace: "/work/project",
    permissionMode: "workspace-write",
  });
}

test("background native completion must update sidebar status", async () => {
  const binding = snapshot().binding;
  let reads = 0;
  const service = api({
    sessions: async () => [binding],
    read: async () => {
      reads++;
      return snapshot();
    },
  });
  let state: ReturnType<typeof useAgentProviders>;
  function Harness() {
    state = useAgentProviders();
    return h("div");
  }
  await mounted(async ({ render }) => {
    await render(h(Harness));
    await act(async () =>
      state.rememberSnapshot(snapshot("binding-one", "working", true)),
    );
    assert.equal(state.navigationSessions[0]?.status, "active");
    await act(async () =>
      service.emit({ type: "changed", sessionId: "binding-one" }),
    );
    await act(async () => new Promise((r) => setTimeout(r, 200)));
    console.log("BACKGROUND_STATUS", {
      reads,
      status: state.navigationSessions[0]?.status,
    });
    assert.equal(state.navigationSessions[0]?.status, undefined);
    assert.equal(
      reads,
      0,
      "background events must not start every saved engine or poll full history",
    );
  }, service.result);
});
test("active native engine with no in-progress projected turn still offers Stop", async () => {
  const native = snapshot();
  native.thread.status = { type: "active", activeFlags: [] };
  let interrupts = 0;
  const service = api({
    read: async () => native,
    interrupt: async () => {
      interrupts++;
    },
  });
  await mounted(async ({ render }) => {
    await render(h(Session, { id: "binding-one" }));
    console.log(
      "ACTIVE_NATIVE_CONTROLS",
      [...document.querySelectorAll("button")].map(
        (x) => x.getAttribute("aria-label") || x.textContent,
      ),
    );
    await act(async () => button("Stop").click());
    assert.equal(interrupts, 1);
  }, service.result);
});

test("model discovery is scoped to Project and ignores a late previous Project catalog", async () => {
  const old = deferred<ModelSummary[]>();
  const calls: Array<[string, string | undefined]> = [];
  const service = api({
    models: async (id, cwd) => {
      calls.push([id, cwd]);
      return cwd === "/project/a" ? old.promise : [model("project-b")];
    },
  });
  let state: ReturnType<typeof useAgentModels>;
  function Harness({ cwd }: { cwd: string }) {
    state = useAgentModels(codex, cwd);
    return h("div");
  }
  await mounted(async ({ render }) => {
    await render(h(Harness, { cwd: "/project/a" }));
    await render(h(Harness, { cwd: "/project/b" }));
    assert.deepEqual(
      state.models.map((m) => m.id),
      ["project-b"],
    );
    await act(async () => old.resolve([model("project-a")]));
    assert.deepEqual(
      state.models.map((m) => m.id),
      ["project-b"],
    );
    assert.deepEqual(calls, [
      [codex.id, "/project/a"],
      [codex.id, "/project/b"],
    ]);
  }, service.result);
});

test("provider-wide failure marks hidden bound sessions without reading their history", async () => {
  const value = snapshot();
  const service = api({ sessions: async () => [value.binding] });
  let state: ReturnType<typeof useAgentProviders>;
  function Harness() {
    state = useAgentProviders();
    return h("div");
  }
  await mounted(async ({ render }) => {
    await render(h(Harness));
    await act(async () => state.rememberSnapshot(value));
    await act(async () =>
      service.emit({
        type: "error",
        providerInstanceId: codex.id,
        message: "engine stopped",
      }),
    );
    assert.equal(state.navigationSessions[0]?.status, "error");
    await act(async () => state.rememberSnapshot(value));
    assert.equal(
      state.navigationSessions[0]?.status,
      "error",
      "a read launched before process failure cannot clear it",
    );
  }, service.result);
});

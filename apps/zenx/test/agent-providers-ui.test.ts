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
      id: `native-${id}`,
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

test("instance-scoped model results and errors cannot cross provider selection", async () => {
  const first = deferred<ModelSummary[]>();
  const second = deferred<ModelSummary[]>();
  const service = api({
    models: (id) => (id === codex.id ? first.promise : second.promise),
  });
  function Catalog({ instance }: { instance: AgentProviderInstance }) {
    const value = useAgentModels(instance);
    return h(
      "p",
      null,
      `${value.loading ? "loading" : value.models.map((entry) => entry.id).join(",")} ${value.error ?? ""}`,
    );
  }
  await mounted(async ({ render }) => {
    await render(h(Catalog, { instance: codex }));
    await render(h(Catalog, { instance: other }));
    await act(async () => second.resolve([model("personal-model")]));
    await act(async () => first.reject(new Error("Old executable failed")));
    assert.match(document.body.textContent!, /personal-model/);
    assert.doesNotMatch(document.body.textContent!, /Old executable/);
  }, service.result);
});

test("external first Send creates in its exact instance, sends text, and preserves later edits", async () => {
  const send = deferred<void>();
  const calls: unknown[] = [];
  const service = api({
    create: async (request) => {
      calls.push(request);
      return snapshot("created", "");
    },
    send: async (id, request) => {
      calls.push({ id, ...request });
      await send.promise;
    },
  });
  await mounted(async ({ render, dom }) => {
    let state!: ComposerState;
    let created: AgentSessionSnapshot | null = null;
    await render(
      h(Session, {
        onCreated: (value) => {
          created = value;
        },
        composerReady: (value) => {
          state = value;
        },
      }),
    );
    await input(dom, "textarea", "/native-command literal");
    await act(async () => button("Send").click());
    assert.equal(created!.binding.id, "created");
    assert.deepEqual(calls, [
      {
        providerInstanceId: codex.id,
        cwd: "/work/project",
        model: "one",
        permissionMode: "workspace-write",
      },
      { id: "created", text: "/native-command literal", model: "one" },
    ]);
    // The shared composer allows editing independently from admission.
    await input(dom, "textarea", "Later edit");
    await act(async () => send.resolve());
    assert.equal(state.draft.text, "Later edit");
    assert.equal(document.querySelector('[aria-label="Add images"]'), null);
    assert.equal(document.querySelector('[aria-label="Send options"]'), null);
  }, service.result);
});

test("external send failure stays with its draft and can retry deliberately", async () => {
  let sends = 0;
  const service = api({
    send: async () => {
      if (++sends === 1) throw new Error("Native send failed");
    },
  });
  await mounted(async ({ render, dom }) => {
    await render(h(Session, { id: "binding-one" }));
    await input(dom, "textarea", "Keep this draft");
    await act(async () => button("Send").click());
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("textarea")!.value,
      "Keep this draft",
    );
    assert.match(document.body.textContent!, /Native send failed/);
    await act(async () => button("Send").click());
    assert.equal(sends, 2);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("textarea")!.value,
      "",
    );
  }, service.result);
});

test("native projection renders and active external turns expose only Stop", async () => {
  let interrupted = "";
  const service = api({
    read: async () => snapshot("binding-one", "Native streamed answer", true),
    interrupt: async (id) => {
      interrupted = id;
    },
  });
  await mounted(async ({ render, dom }) => {
    await render(h(Session, { id: "binding-one" }));
    assert.match(document.body.textContent!, /Native streamed answer/);
    await input(dom, "textarea", "Next request");
    assert.equal(document.querySelector('[aria-label="Send"]'), null);
    await act(async () => button("Stop").click());
    assert.equal(interrupted, "binding-one");
    assert.equal(
      document.querySelector('[aria-label="Default send mode"]'),
      null,
    );
  }, service.result);
});

test("approval snapshots survive navigation and resolved events remove actionable prompts", async () => {
  const approval: Extract<AgentProviderEvent, { type: "approval" }> = {
    type: "approval",
    sessionId: "binding-one",
    requestId: "approval",
    title: "Run command",
    detail: "echo hello",
  };
  const decisions: unknown[] = [];
  const service = api({
    approvals: async () => [approval],
    respondApproval: async (...args) => {
      decisions.push(args);
    },
  });
  await mounted(async ({ render }) => {
    await render(h(Session, { id: "binding-one" }));
    assert.match(document.body.textContent!, /echo hello/);
    await act(async () =>
      service.emit({
        type: "approvalResolved",
        sessionId: "binding-one",
        requestId: "approval",
      }),
    );
    assert.equal(document.querySelector(".agent-approval"), null);
    await act(async () => service.emit({ ...approval, requestId: "new" }));
    await act(async () => button("Decline").click());
    assert.deepEqual(decisions, [["binding-one", "new", "decline"]]);
  }, service.result);
});

test("OpenCode never silently widens workspace-write to full access", async () => {
  let creates = 0;
  const service = api({
    capabilities: async () => ({
      models: true,
      interrupt: true,
      resume: true,
      changeModel: true,
      approvals: true,
      permissionModes: ["danger-full-access"],
    }),
    create: async () => {
      creates++;
      return snapshot();
    },
  });
  await mounted(async ({ render, dom }) => {
    await render(h(Session, { instance: { ...codex, kind: "opencode" } }));
    await input(dom, "textarea", "Run");
    assert.equal(button("Send").disabled, true);
    assert.match(document.body.textContent!, /no filesystem sandbox/);
    assert.equal(creates, 0);
  }, service.result);
});

test("provider settings probe only on request and preserve edits made during save", async () => {
  let modelCalls = 0;
  const saving = deferred<AgentProviderInstance>();
  const service = api({
    models: async () => {
      modelCalls++;
      return [model("one")];
    },
    save: () => saving.promise,
  });
  await mounted(async ({ render, dom }) => {
    await render(
      h(AgentProviderSettings, { active: true, onOpenZen: () => undefined }),
    );
    assert.equal(modelCalls, 0);
    await act(async () => button("Load models").click());
    assert.equal(modelCalls, 1);
    assert.match(document.body.textContent!, /Connected · 1 model/);
    await input(dom, '[aria-label="codex instance name"]', "Saved name");
    await act(async () => button("Save").click());
    await input(dom, '[aria-label="codex instance name"]', "Newer edit");
    await act(async () => saving.resolve({ ...codex, name: "Saved name" }));
    assert.equal(
      document.querySelector<HTMLInputElement>(
        '[aria-label="codex instance name"]',
      )!.value,
      "Newer edit",
    );
    assert.equal(button("Save").disabled, false);
  }, service.result);
});

test("session navigation uses native labels with engine and workspace identity", async () => {
  const service = api();
  let opened = "";
  await mounted(async ({ render }) => {
    await render(
      h(AgentSessionRow, {
        session: {
          binding: snapshot().binding,
          title: "Fix workspace issue",
          providerLabel: "Codex work",
        },
        selected: true,
        onOpen: (id) => {
          opened = id;
        },
      }),
    );
    assert.match(document.body.textContent!, /Fix workspace issue/);
    assert.doesNotMatch(document.body.textContent!, /Codex work/);
    assert.match(
      document.querySelector(".thread-row")!.getAttribute("title")!,
      /Codex work.*\/work\/project/,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")!.click(),
    );
    assert.equal(opened, "binding-one");
  }, service.result);
});

test("event refresh coalesces bursts and allows only one trailing in-flight read", async () => {
  const pending = deferred<void>();
  let reads = 0;
  const service = api();
  const dispose = subscribeAgentRefresh(
    service.result,
    "binding-one",
    async () => {
      reads++;
      if (reads === 1) await pending.promise;
    },
    1,
  );
  try {
    for (let n = 0; n < 30; n++)
      service.emit({ type: "changed", sessionId: "binding-one" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(reads, 1);
    for (let n = 0; n < 30; n++)
      service.emit({ type: "changed", sessionId: "binding-one" });
    pending.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(reads, 2);
  } finally {
    dispose();
  }
});

test("disposing event refresh cancels pending timers and the in-flight trailing refresh", async () => {
  const pending = deferred<void>();
  let reads = 0;
  const service = api();
  const dispose = subscribeAgentRefresh(
    service.result,
    "binding-one",
    async () => {
      reads++;
      await pending.promise;
    },
    1,
  );
  service.emit({ type: "changed", sessionId: "binding-one" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  service.emit({ type: "changed", sessionId: "binding-one" });
  dispose();
  pending.resolve();
  service.emit({ type: "changed", sessionId: "binding-one" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reads, 1);
  const cancel = subscribeAgentRefresh(
    service.result,
    "binding-one",
    async () => {
      reads++;
    },
    10,
  );
  service.emit({ type: "changed", sessionId: "binding-one" });
  cancel();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(reads, 1);
});

test("an older native snapshot cannot replace a newer event refresh", async () => {
  const oldRead = deferred<AgentSessionSnapshot>();
  const newRead = deferred<AgentSessionSnapshot>();
  let reads = 0;
  const service = api({
    read: () => (++reads === 1 ? oldRead.promise : newRead.promise),
  });
  await mounted(async ({ render }) => {
    await render(h(Session, { id: "binding-one" }));
    await act(async () => {
      service.emit({ type: "changed", sessionId: "binding-one" });
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.equal(reads, 2);
    await act(async () =>
      newRead.resolve(snapshot("binding-one", "New native content")),
    );
    await act(async () =>
      oldRead.resolve(snapshot("binding-one", "Old native content")),
    );
    assert.match(document.body.textContent!, /New native content/);
    assert.doesNotMatch(document.body.textContent!, /Old native content/);
  }, service.result);
});

test("native event failures survive successful reads until an explicit retry", async () => {
  const service = api({
    read: async () =>
      snapshot("binding-one", "Native question still waiting", true),
  });
  await mounted(async ({ render }) => {
    await render(h(Session, { id: "binding-one" }));
    await act(async () => {
      service.emit({
        type: "error",
        sessionId: "binding-one",
        message: "Native question needs an unsupported response",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.match(
      document.body.textContent!,
      /Native question needs an unsupported response/,
    );
    await act(async () => {
      service.emit({ type: "changed", sessionId: "binding-one" });
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.match(
      document.body.textContent!,
      /Native question needs an unsupported response/,
    );
    assert.equal(button("Stop").disabled, false);
    await act(async () => button("Retry conversation").click());
    assert.doesNotMatch(
      document.body.textContent!,
      /Native question needs an unsupported response/,
    );
  }, service.result);
});

test("instance-wide errors reach only the selected engine instance", async () => {
  const service = api();
  await mounted(async ({ render }) => {
    await render(h(Session, { id: "binding-one" }));
    await act(async () =>
      service.emit({
        type: "error",
        providerInstanceId: other.id,
        message: "Unrelated engine failed",
      }),
    );
    assert.doesNotMatch(document.body.textContent!, /Unrelated engine failed/);
    await act(async () =>
      service.emit({
        type: "error",
        providerInstanceId: codex.id,
        message: "Selected engine exited",
      }),
    );
    assert.match(document.body.textContent!, /Selected engine exited/);
    await act(async () =>
      service.emit({ type: "error", message: "Unscoped engine failed" }),
    );
    assert.doesNotMatch(document.body.textContent!, /Unscoped engine failed/);
    assert.match(document.body.textContent!, /Selected engine exited/);
  }, service.result);
});

for (const pending of [false, true])
  test(`native Stop remains supported when the model catalog ${pending ? "hangs" : "fails"}`, async () => {
    let interrupts = 0;
    const catalog = deferred<ModelSummary[]>();
    const service = api({
      read: async () => snapshot("binding-one", "Native active answer", true),
      models: () =>
        pending
          ? catalog.promise
          : Promise.reject(new Error("Model catalog unavailable")),
      interrupt: async () => {
        interrupts++;
      },
    });
    await mounted(async ({ render }) => {
      await render(h(Session, { id: "binding-one" }));
      assert.equal(button("Stop").disabled, false);
      await act(async () => button("Stop").click());
      assert.equal(interrupts, 1);
      if (!pending)
        assert.match(document.body.textContent!, /Model catalog unavailable/);
    }, service.result);
  });
test("R3 a new unsupported-input error during an acknowledged send must survive the receipt", async () => {
  const receipt = deferred<void>();
  let active = false;
  const message =
    "OpenCode requested structured user input. This adapter does not support answering it; use OpenCode’s native UI or interrupt the turn.";
  const service = api({
    read: async () => snapshot("binding-one", "Native answer", active),
    send: async () => {
      active = true;
      service.emit({ type: "error", sessionId: "binding-one", message });
      await receipt.promise;
    },
  });
  await mounted(async ({ render, dom }) => {
    await render(h(Session, { id: "binding-one" }));
    await input(dom, "textarea", "Ask a question");
    await act(async () => button("Send").click());
    assert.ok(
      document.body.textContent!.includes(message),
      "native issue is visible during pending send",
    );
    await act(async () => receipt.resolve());
    await act(async () => new Promise((r) => setTimeout(r, 180)));
    assert.ok(
      document.body.textContent!.includes(message),
      "send admission receipt cannot clear a newly arrived semantic issue",
    );
  }, service.result);
});

test("R3 a new engine-wide error during acknowledged interruption must survive the receipt", async () => {
  const receipt = deferred<void>();
  const message =
    "OpenCode event stream closed. Restart ZenX to reconnect to OpenCode's native sessions.";
  const service = api({
    read: async () => snapshot("binding-one", "Native active answer", true),
    interrupt: async () => {
      service.emit({ type: "error", providerInstanceId: codex.id, message });
      await receipt.promise;
    },
  });
  await mounted(async ({ render }) => {
    await render(h(Session, { id: "binding-one" }));
    await act(async () => button("Stop").click());
    assert.ok(
      document.body.textContent!.includes(message),
      "new native issue is visible during pending interruption",
    );
    await act(async () => receipt.resolve());
    await act(async () => new Promise((r) => setTimeout(r, 180)));
    assert.ok(
      document.body.textContent!.includes(message),
      "interrupt receipt cannot clear a newly arrived native issue",
    );
  }, service.result);
});

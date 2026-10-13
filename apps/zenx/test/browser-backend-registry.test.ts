import { InMemoryToolPolicyStore, ToolEnvironment } from "../../../src/tool.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserBackendRegistry,
  concurrentBrowserManifest,
} from "../src/main/capabilities/browser-backend-registry.js";
import type {
  BrowserInspection,
  BrowserLiveObservationListener,
  BrowserTabSummary,
  ZenXBrowserBackend,
} from "../src/main/capabilities/browser-provider.js";
import type { BrowserThreadEvent } from "../src/main/capabilities/browser-thread-observation.js";
import {
  UserBrowserCdpBackend,
  type UserBrowserCdpClient,
} from "../src/main/capabilities/user-browser-provider.js";
import type { ToolInvocation } from "../../../src/tool.js";

function fixture(label: string) {
  const calls: string[] = [];
  const sessions: string[] = [];
  let observation = 0;
  const summary = (sessionId: string): BrowserTabSummary => ({
    sessionId,
    tabId: "same-tab",
    title: label,
    url: "https://example.test/",
    loading: false,
  });
  const backend: ZenXBrowserBackend = {
    bindThreadSession: (sessionId) => {
      sessions.push(sessionId);
    },
    listTabs: async (sessionId) => [summary(sessionId)],
    open: async (sessionId) => summary(sessionId),
    inspect: async (sessionId) => ({
      ...summary(sessionId),
      observationId: `same-observation-${++observation}`,
      documentVersion: 1,
      visibleText: label,
      targets: [
        {
          targetId: "same-target",
          role: "button",
          name: "Submit",
          actions: ["click"],
        },
      ],
      screenshot: {
        observationId: "screenshot",
        artifactPath: "/missing-fixture.png",
        status: "fallback",
        width: 1,
        height: 1,
        bytes: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
    navigate: async (sessionId) => {
      calls.push("navigate");
      return summary(sessionId);
    },
    click: async (sessionId) => {
      calls.push("click");
      return summary(sessionId);
    },
    type: async (sessionId) => summary(sessionId),
    closeTab: async () => {
      calls.push("closeTab");
    },
    closeSession: async () => {
      calls.push("closeSession");
      return 1;
    },
    close: async () => {
      calls.push("close");
    },
  };
  return { backend, calls, sessions };
}
function invocation(
  args: Record<string, unknown> = {},
  threadId = "thread",
): ToolInvocation {
  return {
    callId: "call",
    name: "unused",
    arguments: { sessionId: "same-session", ...args },
    cwd: "/tmp",
    threadId,
    signal: new AbortController().signal,
  };
}

test("Workspace and connected tabs coexist even when every native identity collides", async () => {
  const a = fixture("Workspace"),
    b = fixture("Connected");
  const registry = new BrowserBackendRegistry(a.backend, b.backend);
  try {
    const workspace = (await registry.invoke(
      "browser_workspace_list_tabs",
      invocation(),
    )) as BrowserTabSummary[];
    const connected = (await registry.invoke(
      "browser_connected_list_tabs",
      invocation(),
    )) as BrowserTabSummary[];
    assert.equal(workspace[0]?.tabId, "workspace:same-tab");
    assert.equal(connected[0]?.tabId, "connected:same-tab");
    assert.notEqual(a.sessions[0], b.sessions[0]);
    const inspect = (prefix: string) =>
      registry.invoke(
        `${prefix}inspect`,
        invocation({
          tabId:
            prefix === "browser_workspace_"
              ? workspace[0]!.tabId
              : connected[0]!.tabId,
        }),
      ) as Promise<BrowserInspection>;
    const wa = await inspect("browser_workspace_"),
      cb = await inspect("browser_connected_");
    await assert.rejects(
      registry.invoke(
        "browser_workspace_click",
        invocation({
          tabId: wa.tabId,
          observationId: cb.observationId,
          targetId: wa.targets[0]!.targetId,
        }),
      ),
      /different browser backend/,
    );
    await assert.rejects(
      registry.invoke(
        "browser_connected_inspect",
        invocation({ tabId: wa.tabId }),
      ),
      /different browser backend/,
    );
    assert.deepEqual(a.calls, []);
    await registry.invoke(
      "browser_workspace_click",
      invocation({
        tabId: wa.tabId,
        observationId: wa.observationId,
        targetId: wa.targets[0]!.targetId,
      }),
    );
    await registry.invoke(
      "browser_connected_click",
      invocation({
        tabId: cb.tabId,
        observationId: cb.observationId,
        targetId: cb.targets[0]!.targetId,
      }),
    );
    assert.deepEqual(a.calls, ["click"]);
    assert.deepEqual(b.calls, ["click"]);
    await assert.rejects(
      registry.invoke(
        "browser_connected_click",
        invocation({
          tabId: cb.tabId,
          observationId: cb.observationId,
          targetId: cb.targets[0]!.targetId,
        }),
      ),
      /stale|fresh|inspect|valid/iu,
    );
    await registry.invoke("browser_connected_close_session", invocation());
    assert.deepEqual(a.calls, ["click"]);
    assert.deepEqual(b.calls, ["click", "closeSession"]);
    assert.equal(
      (
        (await registry.invoke(
          "browser_workspace_list_tabs",
          invocation(),
        )) as unknown[]
      ).length,
      1,
    );
  } finally {
    await registry.close();
  }
});

test("a missing external connection never falls back to the Workspace backend", async () => {
  const a = fixture("Workspace");
  const registry = new BrowserBackendRegistry(a.backend);
  try {
    await assert.rejects(
      registry.invoke(
        "browser_connected_open",
        invocation({ url: "https://example.test" }),
      ),
      /Connected browser unavailable/,
    );
    assert.deepEqual(a.calls, []);
    await assert.rejects(
      registry.invoke("browser_list_tabs", invocation()),
      /Unsupported/,
    );
    assert.equal(
      (
        (await registry.invoke(
          "browser_workspace_list_tabs",
          invocation(),
        )) as unknown[]
      ).length,
      1,
    );
    await assert.rejects(
      registry.invoke("browser_workspace_unknown", invocation()),
      /Unsupported/,
    );
  } finally {
    await registry.close();
  }
});

test("registry tools retain separate approval names and generated permission scopes", () => {
  const manifest = concurrentBrowserManifest();
  assert.equal(manifest.tools.length, 20);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /browser_(?!workspace_|connected_)/u,
  );
  assert.equal(new Set(manifest.tools.map((tool) => tool.name)).size, 20);
  for (const tool of manifest.tools) {
    assert.ok(
      tool.permissions.every((permission) =>
        tool.name.startsWith("browser_connected_")
          ? permission.startsWith("browser.connected.")
          : !permission.startsWith("browser.connected."),
      ),
    );
  }
});

test("the observation panel retains both backend identities and explicit selection", async () => {
  const a = fixture("Workspace"),
    b = fixture("Connected");
  const registry = new BrowserBackendRegistry(a.backend, b.backend);
  const events: BrowserThreadEvent[] = [];
  try {
    await registry.invoke("browser_workspace_list_tabs", invocation());
    await registry.invoke("browser_connected_list_tabs", invocation());
    const stop = registry.observeThread(
      { threadId: "thread", frames: false },
      (event) => events.push(event),
    );
    const event = events.filter((event) => event.type === "targets").at(-1)!;
    assert.deepEqual(
      event.targets.map((target) => target.backendId),
      ["workspace", "connected"],
    );
    assert.notEqual(event.targets[0]!.id, event.targets[1]!.id);
    stop();
    const selection: BrowserThreadEvent[] = [];
    const stopSelected = registry.observeThread(
      { threadId: "thread", frames: false, targetId: event.targets[1]!.id },
      (value) => selection.push(value),
    );
    assert.equal(
      selection.filter((value) => value.type === "targets").at(-1)?.selectedId,
      event.targets[1]!.id,
    );
    stopSelected();
  } finally {
    await registry.close();
  }
});

for (const rememberedTool of [
  "browser_list_tabs",
  "browser_workspace_list_tabs",
]) {
  test(`a remembered ${rememberedTool} approval only admits its exact namespace`, async () => {
    const manifest = concurrentBrowserManifest();
    const environment = new ToolEnvironment({
      policyStore: new InMemoryToolPolicyStore({
        [rememberedTool]: "approved",
      }),
      bundles: [
        {
          identity: { kind: "plugin", id: "browser" },
          tools: manifest.tools.map((specification) => ({
            name: specification.name,
            specification,
            execute: async () => ({ output: "", exitCode: 0 }),
          })),
        },
      ],
    });
    let requested = 0;
    const admit = async (name: string) => {
      const call = { ...invocation(), name };
      const prepared = environment.prepare(call);
      return environment.admit(prepared, {
        policy: "ask_unknown",
        approvalRequest: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          callId: call.callId,
          command: name,
          cwd: call.cwd,
          signal: call.signal,
        },
        requestApproval: async () => {
          requested++;
          return "decline";
        },
      });
    };
    const workspaceApproved = rememberedTool === "browser_workspace_list_tabs";
    assert.equal(
      await admit("browser_workspace_list_tabs"),
      workspaceApproved ? "accept" : "decline",
    );
    assert.equal(requested, workspaceApproved ? 0 : 1);
    assert.equal(await admit("browser_connected_list_tabs"), "decline");
    assert.equal(requested, workspaceApproved ? 1 : 2);
  });
}

test("continuation and diff references remain scoped to the connected capture", async () => {
  const a = fixture("Workspace"),
    b = fixture("Connected");
  const inspect = b.backend.inspect.bind(b.backend);
  b.backend.inspect = async (...args) => ({
    ...(await inspect(...args)),
    targets: Array.from({ length: 100 }, (_, index) => ({
      targetId: `target-${index}`,
      role: "button",
      name: `Button ${index}`,
      actions: ["click" as const],
    })),
  });
  const registry = new BrowserBackendRegistry(a.backend, b.backend);
  const args = { tabId: "connected:same-tab" };
  try {
    const first = (await registry.invoke(
      "browser_connected_inspect",
      invocation(args),
    )) as {
      observationId: string;
      nextCursor: string;
      targets: Array<{ targetId: string }>;
    };
    assert.match(first.nextCursor, /^connected:/);
    assert.ok(
      first.targets.every((target) => target.targetId.startsWith("connected:")),
    );
    const tail = (await registry.invoke(
      "browser_connected_inspect",
      invocation({ ...args, cursor: first.nextCursor }),
    )) as { observationId: string; targets: unknown[] };
    assert.equal(tail.observationId, first.observationId);
    assert.equal(tail.targets.length, 20);
    await assert.rejects(
      registry.invoke(
        "browser_workspace_inspect",
        invocation({ tabId: "workspace:same-tab", cursor: first.nextCursor }),
      ),
      /different browser backend/,
    );
    const fresh = (await registry.invoke(
      "browser_connected_inspect",
      invocation({ ...args, baseObservationId: first.observationId }),
    )) as {
      observationId: string;
      observation: {
        format: string;
        actionObservationId: string;
        baseObservationId: string;
      };
    };
    assert.equal(fresh.observation.format, "diff");
    assert.equal(fresh.observation.actionObservationId, fresh.observationId);
    assert.equal(fresh.observation.baseObservationId, first.observationId);
    assert.notEqual(fresh.observationId, first.observationId);
    await assert.rejects(
      registry.invoke(
        "browser_connected_click",
        invocation({
          ...args,
          observationId: first.observationId,
          targetId: first.targets[0]!.targetId,
        }),
      ),
      /observation|stale/iu,
    );
    assert.deepEqual(b.calls, []);
    await assert.rejects(
      registry.invoke(
        "browser_workspace_click",
        invocation({
          tabId: "workspace:same-tab",
          observationId: fresh.observation.actionObservationId,
          targetId: first.targets[0]!.targetId,
        }),
      ),
      /different browser backend/,
    );
    const action = invocation({
      ...args,
      observationId: fresh.observation.actionObservationId,
      targetId: first.targets[0]!.targetId,
    });
    await registry.invoke("browser_connected_click", action);
    assert.deepEqual(b.calls, ["click"]);
    await assert.rejects(
      registry.invoke("browser_connected_click", action),
      /stale|fresh|inspect|valid/iu,
    );
    assert.deepEqual(b.calls, ["click"]);
  } finally {
    await registry.close();
  }
});

function tabFixture(label: string) {
  const value = fixture(label);
  const tabs: BrowserTabSummary[] = [];
  value.backend.open = async (sessionId, url) => {
    const tab = {
      sessionId,
      tabId: `tab-${tabs.length + 1}`,
      title: label,
      url,
      loading: false,
    };
    tabs.push(tab);
    return tab;
  };
  value.backend.listTabs = async (sessionId) =>
    tabs.filter((tab) => tab.sessionId === sessionId);
  value.backend.navigate = async (sessionId, tabId, url) => ({
    sessionId,
    tabId,
    url,
    title: label,
    loading: false,
  });
  return value;
}
function selectedTab(events: BrowserThreadEvent[]): string | undefined {
  const event = events.filter((event) => event.type === "targets").at(-1);
  return event?.targets.find((target) => target.id === event.selectedId)?.tabId;
}

test("Follow Agent follows each child's latest selection and the last active backend, while explicit selection stays pinned", async () => {
  const workspace = tabFixture("Workspace"),
    connected = tabFixture("Connected");
  const registry = new BrowserBackendRegistry(
    workspace.backend,
    connected.backend,
  );
  const events: BrowserThreadEvent[] = [],
    pinned: BrowserThreadEvent[] = [];
  const stop = registry.observeThread(
    { threadId: "thread", frames: false },
    (event) => events.push(event),
  );
  let stopPinned = () => {};
  try {
    await registry.invoke(
      "browser_workspace_open",
      invocation({ url: "https://example.test/a" }),
    );
    const targetId = events
      .filter((event) => event.type === "targets")
      .at(-1)!.selectedId!;
    stopPinned = registry.observeThread(
      { threadId: "thread", frames: false, targetId },
      (event) => pinned.push(event),
    );
    await registry.invoke(
      "browser_workspace_open",
      invocation({ url: "https://example.test/b" }),
    );
    assert.equal(selectedTab(events), "workspace:tab-2");
    await registry.invoke(
      "browser_connected_open",
      invocation({ url: "https://example.test/c" }),
    );
    assert.equal(selectedTab(events), "connected:tab-1");
    await registry.invoke("browser_workspace_list_tabs", invocation());
    assert.equal(
      selectedTab(events),
      "connected:tab-1",
      "listing the other backend must not move Follow Agent",
    );
    await registry.invoke(
      "browser_connected_open",
      invocation({ url: "https://example.test/d" }),
    );
    assert.equal(selectedTab(events), "connected:tab-2");
    await registry.invoke(
      "browser_workspace_navigate",
      invocation({ tabId: "workspace:tab-1", url: "https://example.test/e" }),
    );
    assert.equal(
      selectedTab(events),
      "workspace:tab-1",
      "follow must use the child's selectedId, not the last target in its list",
    );
    await registry.invoke("browser_connected_list_tabs", invocation());
    assert.equal(selectedTab(events), "workspace:tab-1");
    assert.equal(selectedTab(pinned), "workspace:tab-1");
    const reopened: BrowserThreadEvent[] = [];
    const stopReopened = registry.observeThread(
      { threadId: "thread", frames: false },
      (event) => reopened.push(event),
    );
    assert.equal(
      selectedTab(reopened),
      "workspace:tab-1",
      "last activity survives closing and reopening the panel",
    );
    stopReopened();
  } finally {
    stopPinned();
    stop();
    await registry.close();
  }
});

test("production external backend's synchronous metadata replay subscribes once and delivers live frames", async () => {
  const target = {
    targetId: "native",
    type: "page",
    title: "External",
    url: "https://example.test/",
  };
  let subscriptions = 0,
    screencasts = 0,
    metadataStops = 0,
    frameStops = 0;
  let sendFrame: BrowserLiveObservationListener | undefined;
  const client = {
    closureProblem: () => undefined,
    listTargets: async () => [target],
    observeTargetMetadata: (
      _targetId: string,
      listener: (value: typeof target) => void,
    ) => {
      subscriptions++;
      // JsonRpcUserBrowserCdpClient replays its cached target synchronously.
      listener(target);
      return () => {
        metadataStops++;
      };
    },
    observeScreencast: async (
      _targetId: string,
      _owner: unknown,
      listener: BrowserLiveObservationListener,
    ) => {
      screencasts++;
      sendFrame = listener;
      return async () => {
        frameStops++;
      };
    },
    detachTarget: async () => {},
    close: async () => {},
  } as unknown as UserBrowserCdpClient;
  const registry = new BrowserBackendRegistry(
    fixture("Workspace").backend,
    new UserBrowserCdpBackend(client),
  );
  const events: BrowserThreadEvent[] = [];
  let stop = () => {};
  try {
    await registry.invoke("browser_connected_list_tabs", invocation());
    stop = registry.observeThread(
      { threadId: "thread", frames: true },
      (event) => events.push(event),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(subscriptions, 1);
    assert.equal(screencasts, 1);
    const frame = {
      type: "frame" as const,
      frame: {
        sequence: 1,
        mimeType: "image/jpeg" as const,
        data: "YQ==",
        width: 1,
        height: 1,
      },
    };
    sendFrame!(frame);
    assert.deepEqual(events.at(-1), frame);
    stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(metadataStops, 1);
    assert.equal(frameStops, 1);
    const count = events.length;
    sendFrame!(frame);
    assert.equal(events.length, count);
  } finally {
    stop();
    await registry.close();
  }
});

test("backend switches fence late frames, and registry retirement releases every subscription", async () => {
  const workspace = tabFixture("Workspace"),
    connected = tabFixture("Connected");
  const sources: Array<{
    backend: string;
    send: BrowserLiveObservationListener;
    stopped: boolean;
  }> = [];
  for (const [name, value] of [
    ["workspace", workspace],
    ["connected", connected],
  ] as const) {
    value.backend.observeTab = (_session, _tab, send) => {
      const source = { backend: name, send, stopped: false };
      sources.push(source);
      return () => {
        source.stopped = true;
      };
    };
  }
  const registry = new BrowserBackendRegistry(
    workspace.backend,
    connected.backend,
  );
  const events: BrowserThreadEvent[] = [];
  const stop = registry.observeThread(
    { threadId: "thread", frames: true },
    (event) => events.push(event),
  );
  try {
    await registry.invoke(
      "browser_workspace_open",
      invocation({ url: "https://example.test/a" }),
    );
    const first = sources.at(-1)!;
    await registry.invoke(
      "browser_connected_open",
      invocation({ url: "https://example.test/b" }),
    );
    assert.equal(sources.at(-1)?.backend, "connected");
    assert.equal(first.stopped, true);
    const count = events.length;
    first.send({ type: "status", status: "live", message: "old backend" });
    assert.equal(events.length, count);
    sources
      .at(-1)!
      .send({ type: "status", status: "live", message: "current backend" });
    assert.equal(events.length, count + 1);
    await registry.close();
    assert.ok(sources.every((source) => source.stopped));
    assert.deepEqual(events.at(-1), {
      type: "status",
      status: "unavailable",
      message: "The Browser provider is no longer available.",
    });
    const afterClose = events.length;
    for (const source of sources)
      source.send({
        type: "status",
        status: "live",
        message: "after retirement",
      });
    assert.equal(events.length, afterClose);
    await assert.rejects(
      registry.invoke("browser_workspace_list_tabs", invocation()),
      /closed/,
    );
    const retired: BrowserThreadEvent[] = [];
    registry.observeThread({ threadId: "thread", frames: true }, (event) =>
      retired.push(event),
    )();
    assert.deepEqual(retired, [
      { type: "targets", targets: [] },
      {
        type: "status",
        status: "unavailable",
        message: "The Browser provider is no longer available.",
      },
    ]);
  } finally {
    stop();
    await registry.close();
  }
});

test("successful session closure clears its last activity without changing other threads or admitting list activity", async () => {
  const workspace = tabFixture("Workspace"),
    connected = tabFixture("Connected");
  const registry = new BrowserBackendRegistry(
    workspace.backend,
    connected.backend,
  );
  const events: BrowserThreadEvent[] = [];
  const stop = registry.observeThread(
    { threadId: "thread", frames: false },
    (event) => events.push(event),
  );
  try {
    await registry.invoke(
      "browser_workspace_open",
      invocation({ url: "https://example.test/a" }),
    );
    await registry.invoke(
      "browser_connected_open",
      invocation({ url: "https://example.test/b" }),
    );
    await registry.invoke(
      "browser_workspace_open",
      invocation({ url: "https://example.test/c" }, "other-thread"),
    );
    assert.equal(selectedTab(events), "connected:tab-1");
    workspace.backend.navigate = async () => {
      throw new Error("navigation failed");
    };
    await assert.rejects(
      registry.invoke(
        "browser_workspace_navigate",
        invocation({
          tabId: "workspace:tab-1",
          url: "https://example.test/fail",
        }),
      ),
      /navigation failed/,
    );
    assert.equal(selectedTab(events), "connected:tab-1");
    await registry.invoke("browser_connected_close_session", invocation());
    assert.equal(selectedTab(events), "workspace:tab-1");
    // A different connected session can expose targets without inheriting the
    // closed session's last-action preference.
    connected.backend.listTabs = async (sessionId) => [
      {
        sessionId,
        tabId: "listed",
        title: "Listed page",
        url: "https://example.test/",
        loading: false,
      },
    ];
    await registry.invoke(
      "browser_connected_list_tabs",
      invocation({ sessionId: "new-session" }),
    );
    const reopened: BrowserThreadEvent[] = [];
    registry.observeThread({ threadId: "thread", frames: false }, (event) =>
      reopened.push(event),
    )();
    assert.equal(selectedTab(reopened), "workspace:tab-1");
  } finally {
    stop();
    await registry.close();
  }
});

test("a renderer failure during the post-action selection refresh cannot reject the completed action", async () => {
  const registry = new BrowserBackendRegistry(
    fixture("Workspace").backend,
    fixture("Connected").backend,
  );
  registry.observeThread({ threadId: "thread", frames: false }, (event) => {
    if (event.type === "targets" && event.selectedId?.startsWith("connected:"))
      throw new Error("renderer destroyed");
  });
  try {
    await registry.invoke(
      "browser_workspace_open",
      invocation({ url: "https://example.test/a" }),
    );
    const result = (await registry.invoke(
      "browser_connected_open",
      invocation({ url: "https://example.test/b" }),
    )) as { backendId: string };
    assert.equal(result.backendId, "connected");
  } finally {
    await registry.close();
  }
});

test("synchronous retirement during subscription creation disposes its late handle and fences frames", async () => {
  const value = fixture("Workspace");
  let subscriptionStops = 0;
  let sendLate: BrowserLiveObservationListener | undefined;
  value.backend.observeTab = (_session, _tab, listener) => {
    sendLate = listener;
    listener({ type: "status", status: "live", message: "subscribing" });
    return () => {
      subscriptionStops++;
    };
  };
  const registry = new BrowserBackendRegistry(value.backend);
  await registry.invoke("browser_workspace_list_tabs", invocation());
  const events: BrowserThreadEvent[] = [];
  let retiring: Promise<void> | undefined;
  const stop = registry.observeThread(
    { threadId: "thread", frames: true },
    (event) => {
      events.push(event);
      if (event.type === "status" && event.status === "live")
        retiring = registry.close();
    },
  );
  await retiring;
  assert.equal(subscriptionStops, 1);
  assert.equal(events.at(-1)?.type, "status");
  const count = events.length;
  sendLate!({ type: "status", status: "live", message: "late" });
  assert.equal(events.length, count);
  stop();
  await registry.close();
  assert.equal(subscriptionStops, 1);
});

test("follow-up observation hints name only tools in the action's current namespace", async () => {
  const a = fixture("Workspace"),
    b = fixture("Connected");
  for (const value of [a, b])
    value.backend.inspect = async () => {
      throw new Error("capture failed");
    };
  const registry = new BrowserBackendRegistry(a.backend, b.backend);
  try {
    for (const prefix of ["browser_workspace_", "browser_connected_"]) {
      const result = (await registry.invoke(
        `${prefix}open`,
        invocation({ url: "https://example.test/", observe: true }),
      )) as { actionCompleted: boolean; nextAction: string };
      assert.equal(result.actionCompleted, true);
      assert.ok(result.nextAction.includes(`${prefix}inspect`));
      assert.doesNotMatch(
        result.nextAction,
        /browser_(?!workspace_|connected_)/u,
      );
    }
  } finally {
    await registry.close();
  }
});

test("multiple connected instances require exact scope and keep colliding references isolated", async () => {
  const a = fixture("Workspace"),
    b = fixture("Chrome"),
    c = fixture("Edge");
  const connections = [
    {
      connectionId: "11111111-1111-4111-8111-111111111111",
      generation: "one",
      browser: "chrome" as const,
      label: "Chrome · 11111111",
      state: "connected" as const,
    },
    {
      connectionId: "22222222-2222-4222-8222-222222222222",
      generation: "two",
      browser: "edge" as const,
      label: "Edge · 22222222",
      state: "connected" as const,
    },
  ];
  let connected = 0;
  const source = {
    connections: () => connections,
    connectInstance: async (id: string) => {
      connected++;
      return {
        backend: id === connections[0]!.connectionId ? b.backend : c.backend,
        product: "fixture",
      };
    },
    onConnectionsChanged: () => () => {},
  };
  const registry = new BrowserBackendRegistry(
    a.backend,
    undefined,
    undefined,
    source,
  );
  const scoped = (index: number, args = {}) => ({
    ...invocation({ connectionId: connections[index]!.connectionId, ...args }),
    approvalScope: {
      key: `browser-instance:${connections[index]!.connectionId}`,
      label: connections[index]!.label,
      generation: connections[index]!.generation,
    },
  });
  const events: BrowserThreadEvent[] = [];
  const stop = registry.observeThread(
    { threadId: "thread", frames: false },
    (event) => events.push(event),
  );
  try {
    const discovery = await registry.invoke(
      "browser_connections",
      invocation(),
    );
    assert.doesNotMatch(
      JSON.stringify(discovery),
      /https:|same-tab|generation|one|two/,
    );
    assert.equal(connected, 0);
    await assert.rejects(
      registry.invoke(
        "browser_connected_list_tabs",
        invocation({ connectionId: connections[0]!.connectionId }),
      ),
      /scope|approval/i,
    );
    await assert.rejects(
      registry.invoke(
        "browser_connected_list_tabs",
        scoped(0, { connectionId: connections[1]!.connectionId }),
      ),
      /scope|approval/i,
    );
    const tabsA = (await registry.invoke(
      "browser_connected_list_tabs",
      scoped(0),
    )) as BrowserTabSummary[];
    const tabsB = (await registry.invoke(
      "browser_connected_list_tabs",
      scoped(1),
    )) as BrowserTabSummary[];
    assert.notEqual(tabsA[0]!.tabId, tabsB[0]!.tabId);
    await registry.invoke("browser_workspace_list_tabs", invocation());
    const targets = events.filter((event) => event.type === "targets").at(-1);
    assert.equal(targets?.targets.length, 3);
    await assert.rejects(
      registry.invoke(
        "browser_connected_inspect",
        scoped(1, { tabId: tabsA[0]!.tabId }),
      ),
      /different browser/,
    );
    const old = scoped(0);
    connections[0]!.generation = "new";
    await assert.rejects(
      registry.invoke("browser_connected_list_tabs", old),
      /generation|changed/,
    );
    assert.equal(connected, 2);
  } finally {
    stop();
    await registry.close();
  }
});

test("human current-URL reads keep exact connection generation and Thread identity", async () => {
  const workspace = fixture("Workspace"),
    connected = fixture("Chrome");
  let resolve!: (value: string) => void;
  connected.backend.readCurrentUrl = async () =>
    new Promise<string>((done) => {
      resolve = done;
    });
  const connection = {
    connectionId: "11111111-1111-4111-8111-111111111111",
    generation: "one",
    browser: "chrome" as const,
    label: "Chrome",
    state: "connected" as const,
  };
  const registry = new BrowserBackendRegistry(
    workspace.backend,
    undefined,
    undefined,
    {
      connections: () => [connection],
      connectInstance: async () => ({
        backend: connected.backend,
        product: "fixture",
      }),
      onConnectionsChanged: () => () => {},
    },
  );
  const events: BrowserThreadEvent[] = [];
  const stop = registry.observeThread(
    { threadId: "thread", frames: false },
    (event) => events.push(event),
  );
  try {
    await registry.invoke("browser_connected_list_tabs", {
      ...invocation({ connectionId: connection.connectionId }),
      approvalScope: {
        key: `browser-instance:${connection.connectionId}`,
        label: connection.label,
        generation: connection.generation,
      },
    });
    const snapshot = events.findLast((event) => event.type === "targets")!;
    assert.equal(snapshot.type, "targets");
    if (snapshot.type !== "targets") return;
    const targetId = snapshot.selectedId!;
    await assert.rejects(
      registry.readTargetUrl("foreign-thread", targetId),
      /unavailable/,
    );
    const first = registry.readTargetUrl("thread", targetId);
    resolve("https://example.test/current?q=1#hash");
    assert.equal(await first, "https://example.test/current?q=1#hash");
    const late = registry.readTargetUrl("thread", targetId);
    connection.generation = "reconnected";
    resolve("https://example.test/old?q=private#route");
    await assert.rejects(late, /no longer current/);
    await assert.rejects(
      registry.readTargetUrl("thread", targetId),
      /unavailable/,
    );
  } finally {
    stop();
    await registry.close();
  }
});

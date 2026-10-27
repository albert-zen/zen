import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelReferenceRegistry,
  trustedModelReferenceBindings,
} from "../../../src/model-references.js";
import {
  workspaceFixture,
  browserBackend,
  browserBridge,
  LITERAL,
} from "./model-browser-fixture.js";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import {
  browserModelDefinition,
  decodeBrowserArguments,
  browserSidebarDescriptor,
} from "../src/main/capabilities/model-browser-facade.js";
import { readBrowserModelRoute } from "../src/main/capabilities/model-browser-metadata.js";
import type { BrowserConnectionSnapshot } from "../src/main/chrome-extension-bridge.js";
import type { UserBrowserConnection } from "../src/main/capabilities/user-browser-provider.js";
import { isHostEvent, isHostCommand } from "../src/main/host-messages.js";
const ref = (value: unknown) => assert.match(String(value), /^r[1-9][0-9]*$/u);

test("Browser full projection keeps literal text, exact private targets, native Trace and immutable cursor pages", async () => {
  const f = await workspaceFixture();
  try {
    const list = await f.bridge.call("browser_workspace_list_tabs", {
      session: "main",
    });
    ref(list.session);
    ref(list.tabs[0].tab);
    assert.equal(JSON.stringify(list).includes("RAW-"), false);
    const first = await f.bridge.call("browser_workspace_inspect", {
      tab: list.tabs[0].tab,
    });
    assert.equal(first.targets.length, 80);
    ref(first.observation);
    ref(first.nextCursor);
    assert.equal(first.visibleText, LITERAL);
    assert.equal(first.targets[0].name, LITERAL);
    assert.equal(first.screenshot.artifactPath, "/literal/unchanged.png");
    assert.equal(JSON.stringify(first).includes("RAW-"), false);
    const next = await f.bridge.call("browser_workspace_inspect", {
      cursor: first.nextCursor,
    });
    assert.equal(next.targets.length, 10);
    assert.equal(next.observation, first.observation);
    assert.equal(f.calls.filter((c) => c.name === "inspect").length, 1);
    await f.bridge.call("browser_workspace_type", {
      target: first.targets[0].ref,
      text: LITERAL,
    });
    assert.equal(f.calls.find((c) => c.name === "type")!.args[3], "RAW-native-node-0");
    assert.equal(f.calls.find((c) => c.name === "type")!.args[4], LITERAL);
    await assert.rejects(
      f.bridge.call("browser_workspace_click", {
        target: first.targets[0].ref,
      }),
      /consumed|unavailable|stale/,
    );
    assert.equal(f.calls.filter((c) => c.name === "click").length, 0);
    assert.ok(JSON.stringify(f.bridge.trace).includes("RAW-native-tab"));
    assert.ok(
      f.bridge.trace.some(
        (v) => (v as any).layer === "capability-result-before-model-projection",
      ),
    );
    const route = readBrowserModelRoute(f.bridge.native[1])!;
    assert.notEqual(route.tabId, route.targetId);
    f.service.assertModelTarget(route, "RAW-owner");
  } finally {
    await f.bridge.close();
  }
});
test("Browser action observes by default and accepts an exact short baseline", async () => {
  const f = await workspaceFixture();
  try {
    const list = await f.bridge.call("browser_workspace_list_tabs", {});
    const first = await f.bridge.call("browser_workspace_inspect", { tab: list.tabs[0].tab });
    const next = await f.bridge.call("browser_workspace_click", {
      target: first.targets[0].ref,
      since: first.observation,
    });
    assert.equal(next.observation === undefined, false);
    assert.equal(next.page.format, "diff");
    assert.equal(next.page.base, first.observation);
    assert.ok(next.targetChanges);
    assert.equal(typeof next.page.unchanged, "boolean");
    assert.equal(f.calls.filter((c) => c.name === "inspect").length, 2);
  } finally {
    await f.bridge.close();
  }
});
test("Browser consecutive diffs replace exact action refs while preserving the first-page target tree", async () => {
  const f = await workspaceFixture();
  try {
    const tabs = await f.bridge.call("browser_workspace_list_tabs", {});
    const first = await f.bridge.call("browser_workspace_inspect", { tab: tabs.tabs[0].tab });
    let current = first.targets as Array<{ ref: string; name: string }>;
    let baseline = first.observation as string;
    for (let i = 0; i < 2; i++) {
      const result = await f.bridge.call("browser_workspace_click", { target: current[0]!.ref, since: baseline });
      assert.equal(result.page.format, "diff");
      const replacements = new Map<string, string>(result.targetChanges.replacements.map((pair: { beforeRef: string; ref: string }): [string, string] => [pair.beforeRef, pair.ref]));
      current = current.map((item) => ({ ...item, ref: replacements.get(item.ref)! }));
      assert.equal(current.every((item) => /^r[1-9][0-9]*$/u.test(item.ref)), true);
      assert.deepEqual(current.map((item) => item.name), first.targets.map((item: { name: string }) => item.name));
      baseline = result.observation;
    }
    await f.bridge.call("browser_workspace_click", { target: current[0]!.ref, observe: false });
    assert.equal(f.calls.filter((call) => call.name === "click").length, 3);
  } finally {
    await f.bridge.close();
  }
});
test("Browser action without a retained baseline returns a small self-contained focused capture", async () => {
  const f = await workspaceFixture();
  try {
    const tabs = await f.bridge.call("browser_workspace_list_tabs", {});
    const first = await f.bridge.call("browser_workspace_inspect", { tab: tabs.tabs[0].tab });
    const action = await f.bridge.call("browser_workspace_click", { target: first.targets[0].ref });
    assert.equal(action.page.format, "full");
    assert.equal(action.view.kind, "focused-capture");
    assert.ok(action.targets.length > 0 && action.targets.length <= 7);
    assert.equal(action.coverage.sourceComplete, false);
    assert.match(action.coverage.scope, /subset/);
    assert.match(action.nextAction, /inspect/i);
  } finally {
    await f.bridge.close();
  }
});
test("Browser query searches captured target metadata, keeps actionable refs and continuation", async () => {
  const f = await workspaceFixture();
  try {
    const list = await f.bridge.call("browser_workspace_list_tabs", {});
    const first = await f.bridge.call("browser_workspace_inspect", { tab: list.tabs[0].tab, query: "Save" });
    assert.equal(first.search.matchedCapturedTargets, 89);
    assert.equal(first.targets.length, 80);
    assert.match(first.coverage.scope, /query within/);
    ref(first.nextCursor);
    const tail = await f.bridge.call("browser_workspace_inspect", { cursor: first.nextCursor });
    assert.equal(tail.targets.length, 9);
    const action = await f.bridge.call("browser_workspace_click", { target: tail.targets[0].ref, observation: first.observation, observe: false });
    assert.equal(action.observation, undefined);
  } finally {
    await f.bridge.close();
  }
});
test("Browser reuses a retained target only with an exact newer observation and native revalidation", async () => {
  const f = await workspaceFixture();
  try {
    const tabs = await f.bridge.call("browser_workspace_list_tabs", {});
    const old = await f.bridge.call("browser_workspace_inspect", { tab: tabs.tabs[0].tab });
    const fresh = await f.bridge.call("browser_workspace_inspect", { tab: tabs.tabs[0].tab });
    await f.bridge.call("browser_workspace_click", { target: old.targets[0].ref, observation: fresh.observation, observe: false });
    assert.equal(f.calls.filter((c) => c.name === "click").length, 1);
    await assert.rejects(f.bridge.call("browser_workspace_click", { target: old.targets[0].ref, observation: old.observation }), /stale|unavailable|consumed/);
    assert.equal(f.calls.filter((c) => c.name === "click").length, 1);
  } finally {
    await f.bridge.close();
  }
});
test("Browser same native tab after close, stale session, fork and restart aliases cannot dispatch", async () => {
  const f = await workspaceFixture();
  try {
    const list = await f.bridge.call("browser_workspace_list_tabs", {}),
      tab = list.tabs[0].tab;
    await f.bridge.call("browser_workspace_close", { tab });
    await f.bridge.call("browser_workspace_list_tabs", {});
    await assert.rejects(
      f.bridge.call("browser_workspace_inspect", { tab }),
      /current/,
    );
    await f.bridge.call("browser_workspace_close_session", {
      session: list.session,
    });
    await f.bridge.call("browser_workspace_list_tabs", {});
    await assert.rejects(
      f.bridge.call("browser_workspace_list_tabs", { session: list.session }),
      /current/,
    );
    const freshBackend = browserBackend(),
      fresh = new BrowserBackendRegistry(freshBackend.backend);
    const restarted = await browserBridge(fresh, undefined, f.bridge.history);
    try {
      await assert.rejects(
        restarted.call("browser_workspace_inspect", { tab }),
        /retired|epoch|fresh/i,
      );
      assert.equal(restarted.native.length, 0);
    } finally {
      await restarted.close();
    }
    const fork = await browserBridge(
      new BrowserBackendRegistry(browserBackend().backend),
      undefined,
      f.bridge.history,
      "other",
    );
    try {
      await assert.rejects(
        fork.call("browser_workspace_inspect", { tab }),
        /unknown|owner|fresh|retired/i,
      );
      assert.equal(fork.native.length, 0);
    } finally {
      await fork.close();
    }
  } finally {
    await f.bridge.close();
  }
});
test("Browser preparation resolves the exact connection before approvals and resource claims; revoked/recycled connections never retarget", async () => {
  const workspace = browserBackend(),
    connected = browserBackend();
  let connections: BrowserConnectionSnapshot[] = [
    {
      connectionId: "RAW-connection",
      generation: "RAW-generation-1",
      browser: "chrome",
      label: "Chrome",
      state: "connected",
    },
  ];
  let notify = () => {};
  const service = new BrowserBackendRegistry(
    workspace.backend,
    undefined,
    "unavailable",
    {
      connections: () => connections,
      onConnectionsChanged: (fn) => {
        notify = fn;
        return () => {};
      },
      connectInstance: async () =>
        ({ backend: connected.backend }) as UserBrowserConnection,
    },
  );
  const bridge = await browserBridge(service, structuredClone(connections));
  try {
    const catalog = await bridge.call("browser_connections", {}),
      connection = catalog.connections[0].ref;
    assert.equal(JSON.stringify(catalog).includes("RAW-"), false);
    const tool = bridge.bundle.tools.find(
        (t) => t.name === "browser_connected_list_tabs",
      )!,
      input = bridge.invocation(tool.name, { connection });
    const approval = await tool.approvalScope!(input);
    assert.equal(approval!.key, "browser-instance:RAW-connection");
    assert.equal(approval!.generation, "RAW-generation-1");
    const approved = { ...input, approvalScope: approval };
    assert.ok(
      JSON.stringify(tool.resourceClaims!(approved)).includes(
        "RAW-generation-1",
      ),
    );
    assert.ok(JSON.stringify(tool.resourceClaims!(approved)).includes("main"));
    const tabs = await bridge.call(tool.name, { connection });
    const inspect = bridge.bundle.tools.find(
      (t) => t.name === "browser_connected_inspect",
    )!;
    const unprepared = bridge.invocation(inspect.name, {
      tab: tabs.tabs[0].tab,
    });
    const prepared = {
      ...unprepared,
      approvalScope: await inspect.approvalScope!(unprepared),
    };
    const claims = inspect.resourceClaims!(prepared);
    assert.ok(JSON.stringify(claims).includes("RAW-native-tab"));
    connections = [];
    notify();
    await assert.rejects(inspect.execute(prepared), /unavailable/);
    assert.equal(connected.calls.length, 0);
    connections = [
      {
        connectionId: "RAW-connection",
        generation: "RAW-generation-2",
        browser: "chrome",
        label: "Chrome",
        state: "connected",
      },
    ];
    notify();
    await assert.rejects(inspect.execute(prepared), /generation/);
    assert.equal(connected.calls.length, 0);
    const current = await browserBridge(
      service,
      structuredClone(connections),
      bridge.history,
    );
    try {
      const old = current.invocation(inspect.name, { tab: tabs.tabs[0].tab });
      const runtime = current.bundle.tools.find(
        (t) => t.name === inspect.name,
      )!;
      assert.throws(() => runtime.approvalScope!(old), /retired|fresh/i);
      assert.throws(() => runtime.resourceClaims!(old), /retired|fresh/i);
    } finally {
      await current.close();
    }
  } finally {
    await bridge.close();
  }
});
test("A successful native action with failed follow-up observation is retained without replay", async () => {
  const f = await workspaceFixture();
  try {
    const list = await f.bridge.call("browser_workspace_list_tabs", {});
    const inspection = await f.bridge.call("browser_workspace_inspect", {
      tab: list.tabs[0].tab,
    });
    f.failInspect();
    const result = await f.bridge.call("browser_workspace_click", {
      target: inspection.targets[0].ref,
      observe: true,
    });
    assert.equal(result.actionCompleted, true);
    assert.equal(result.observationError, LITERAL);
    assert.equal(f.calls.filter((c) => c.name === "click").length, 1);
    assert.equal(JSON.stringify(result).includes("RAW-"), false);
  } finally {
    await f.bridge.close();
  }
});
test("Browser model schemas hide native routing but native definitions and literal user fields remain unchanged", async () => {
  const f = await workspaceFixture();
  try {
    const definition = f.service.manifest.tools.find(
      (t) => t.name === "browser_workspace_click",
    )!;
    assert.ok(
      definition.inputSchema.properties &&
        (definition.inputSchema.properties as any).observationId,
    );
    const compact = browserModelDefinition(definition);
    assert.deepEqual(compact.inputSchema.required, ["target"]);
    assert.equal(JSON.stringify(compact).includes("sessionId"), false);
    await assert.rejects(
      f.bridge.call("browser_workspace_inspect", {
        sessionId: "main",
        tabId: "RAW-native-tab",
      }),
      /Unsupported/,
    );
    assert.equal(f.bridge.native.length, 0);
  } finally {
    await f.bridge.close();
  }
});
test("Browser sidebar new descriptor resolves exact product identity, not native tab ID", async () => {
  const f = await workspaceFixture();
  try {
    const list = await f.bridge.call("browser_workspace_list_tabs", {});
    const binding = f.bridge.history.find((b) => b.ref === list.tabs[0].tab)!;
    const refs = new ModelReferenceRegistry().scope(
      "RAW-owner",
      f.bridge.history,
    );
    const descriptor = browserSidebarDescriptor(
      binding.ref,
      "browser",
      refs,
      binding.epoch!,
    );
    assert.notEqual(descriptor.tab.id, descriptor.route.tabId);
    assert.equal(descriptor.tab.resourceThreadId, "RAW-owner");
    f.service.assertModelTarget(descriptor.route, "RAW-owner");
    assert.throws(
      () =>
        browserSidebarDescriptor(
          binding.ref,
          "external-browser",
          refs,
          binding.epoch!,
        ),
      /kind/,
    );
    await f.bridge.call("browser_workspace_close", { tab: list.tabs[0].tab });
    assert.throws(
      () => f.service.assertModelTarget(descriptor.route, "RAW-owner"),
      /current/,
    );
  } finally {
    await f.bridge.close();
  }
});
test("Browser IPC shape checks reject malformed sideband rather than accepting raw JSON authority", () => {
  assert.equal(
    isHostEvent({
      type: "capability/invoke",
      invocationId: "i",
      generationToken: "g",
      browserModelRoute: { ownerThreadId: "o" },
    }),
    false,
  );
  assert.equal(
    isHostCommand({
      type: "capability/result",
      invocationId: "i",
      generationToken: "g",
      browserModelTargets: { targets: [] },
    }),
    false,
  );
});

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ZenXSelfControlCapabilityPackage } from "../src/main/capabilities/self-control-package.js";
import { ThreadSidebarStore } from "../src/main/thread-sidebar-store.js";
import { invokeModelToolFacade } from "../src/main/capabilities/model-tool-facade.js";
import { attachBrowserModelTargets } from "../src/main/capabilities/model-browser-metadata.js";
import { invokeBrowserModelToolFacade } from "../src/main/capabilities/model-browser-facade.js";

test("New Browser sidebar descriptor passes native live admission and never creates a replacement for a closed tab", async () => {
  const f = await workspaceFixture(),
    directory = await mkdtemp(path.join(os.tmpdir(), "browser-sidebar-"));
  try {
    const list = await f.bridge.call("browser_workspace_list_tabs", {}),
      tab = list.tabs[0].tab;
    const binding = f.bridge.history.find((b) => b.ref === tab)!,
      epoch = binding.epoch!;
    const store = new ThreadSidebarStore(directory),
      refs = new ModelReferenceRegistry();
    let admissions = 0;
    const sidebar = new ZenXSelfControlCapabilityPackage({
      sidebar: store,
      appServer: {
        request: async () => ({ thread: { id: "RAW-owner" } }),
      } as never,
      browserTargetAdmission: (route, owner) => {
        admissions++;
        f.service.assertModelTarget(route, owner);
      },
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await invokeModelToolFacade({
        invocation: f.bridge.invocation(name, args),
        references: refs,
        epoch,
        dispatch: async (inv) => ({
          output: JSON.stringify(await sidebar.invoke(inv.name, inv)),
          exitCode: 0,
        }),
      });
      f.bridge.history.push(...trustedModelReferenceBindings(result)!);
      return JSON.parse(result.output);
    };
    const before = await call("zenx_self_control_sidebar_read", {
      scope: "self",
    });
    const result = await call("zenx_self_control_sidebar_update", {
      snapshot: before.snapshot,
      patch: { tabs: [{ kind: "browser", tab }] },
    });
    assert.equal(result.applied, true);
    assert.ok(admissions > 0);
    const state = await store.read("RAW-owner"),
      descriptor = browserSidebarDescriptor(
        tab,
        "browser",
        refs.scope("RAW-owner", f.bridge.history),
        epoch,
      );
    assert.equal((state.tabs[0] as any).id, descriptor.route.targetId);
    assert.notEqual((state.tabs[0] as any).id, descriptor.route.tabId);
    await f.bridge.call("browser_workspace_close", { tab });
    await assert.rejects(
      call("zenx_self_control_sidebar_update", {
        snapshot: result.snapshot,
        patch: { tabs: [{ kind: "browser", tab }] },
      }),
      /current/,
    );
    assert.deepEqual(await store.read("RAW-owner"), state);
  } finally {
    await f.bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("Browser producer budget preserves completed action and used refs after exact raw capture without partial aliases or replay", async () => {
  const refs = new ModelReferenceRegistry(),
    seed = refs.scope("owner"),
    route = {
      ownerThreadId: "owner",
      sessionId: "main",
      sessionEpoch: "RAW-epoch",
      backend: "workspace",
      tabId: "workspace:RAW-tab",
      targetId: "workspace:RAW-product",
    };
  const target = seed.bind(
    "browser",
    "target",
    { route, observationId: "RAW-old", targetId: "RAW-node" },
    "epoch",
  );
  const output = {
    sessionId: "main",
    tabId: route.tabId,
    observationId: "RAW-new",
    actionCompleted: true,
    targets: Array.from({ length: 5000 }, (_, i) => ({
      targetId: `RAW-${i}`,
      name: "Save",
    })),
  };
  const raw = attachBrowserModelTargets(
    {
      output: JSON.stringify(output),
      exitCode: 0,
      structuredContent: { secret: "RAW-sidechannel" },
    },
    {
      route: {
        ownerThreadId: "owner",
        sessionId: "main",
        sessionEpoch: "RAW-epoch",
        backend: "workspace",
      },
      targets: [{ tabId: route.tabId, targetId: route.targetId }],
    },
  );
  let dispatches = 0,
    captures = 0;
  const capture = {
    recordInvocation: async () => {},
    recordReferenceBindings: async () => {},
    recordResult: async (value: unknown) => {
      captures++;
      assert.equal(value, raw);
      return { durability: "degraded" as const, error: "synthetic" };
    },
    recordAcceptedResult: async () => {},
    write: async () => {},
    end: async () => {},
    flush: async () => {},
    hasObservedResult: () => true,
    hasAcceptedResult: () => false,
  };
  const result = await invokeBrowserModelToolFacade({
    invocation: {
      name: "browser_workspace_click",
      callId: "call",
      cwd: "/synthetic",
      threadId: "owner",
      arguments: { target, observe: true },
      modelReferences: seed.newBindings,
      signal: new AbortController().signal,
      traceOutput: capture,
    },
    epoch: "epoch",
    references: refs,
    dispatch: async () => {
      dispatches++;
      return raw;
    },
  });
  const projected = JSON.parse(result.output);
  assert.equal(projected.projection, "projection_unavailable");
  assert.equal(projected.outcome.actionCompleted, true);
  assert.equal(result.exitCode, 0);
  assert.equal(dispatches, 1);
  assert.equal(captures, 1);
  assert.deepEqual(trustedModelReferenceBindings(result), seed.newBindings);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.output.includes("RAW-"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import type { ZenXBrowserBackend } from "../src/main/capabilities/browser-provider.js";
import {
  attachBrowserModelRoute,
  readBrowserModelRoute,
  readBrowserModelTargets,
  copyBrowserModelTargets,
} from "../src/main/capabilities/model-browser-metadata.js";
import type { ToolInvocation } from "../../../src/tool.js";
function fixture() {
  let observations = 0;
  const calls: string[] = [];
  const summary = (sessionId: string) => ({
    sessionId,
    tabId: "RAW-tab",
    title: "Example",
    url: "https://example.test",
    loading: false,
  });
  const backend: ZenXBrowserBackend = {
    listTabs: async (s) => [summary(s)],
    open: async (s) => summary(s),
    navigate: async (s) => summary(s),
    type: async (s) => summary(s),
    click: async (s) => {
      calls.push("click");
      return summary(s);
    },
    inspect: async (s) => {
      calls.push("inspect");
      return {
        ...summary(s),
        observationId: `RAW-observation-${++observations}`,
        documentVersion: 1,
        visibleText: "literal",
        targets: [],
        screenshot: {
          observationId: "RAW-screenshot",
          artifactPath: "/literal.png",
          status: "fallback",
          width: 1,
          height: 1,
          bytes: 0,
          expiresAt: "2030-01-01",
        },
      };
    },
    closeTab: async () => {},
    closeSession: async () => 1,
    close: async () => {},
  };
  const registry = new BrowserBackendRegistry(backend);
  const invoke = (
    tool: string,
    args = {},
    route?: Parameters<typeof attachBrowserModelRoute>[1],
    owner = "owner",
  ) => {
    const invocation: ToolInvocation = {
      name: tool,
      callId: "call",
      arguments: { sessionId: "main", ...args },
      threadId: owner,
      cwd: "/tmp",
      signal: new AbortController().signal,
    };
    if (route) attachBrowserModelRoute(invocation, route);
    return registry.invoke(tool, invocation);
  };
  return { registry, invoke, calls };
}
test("Browser exact product target lookup is private, read-only, owner/session fenced and rejects recycled native tab IDs", async () => {
  const f = fixture();
  try {
    const raw = await f.invoke("browser_workspace_list_tabs");
    const metadata = readBrowserModelTargets(raw)!;
    assert.ok(metadata);
    assert.notEqual(metadata.targets[0]!.tabId, metadata.targets[0]!.targetId);
    assert.equal(
      JSON.stringify(raw).includes(metadata.route.sessionEpoch),
      false,
    );
    assert.equal(
      readBrowserModelTargets(JSON.parse(JSON.stringify(raw))),
      undefined,
    );
    assert.equal(readBrowserModelTargets(structuredClone(raw)), undefined);
    assert.deepEqual(
      readBrowserModelTargets(copyBrowserModelTargets(raw, {})),
      metadata,
    );
    const route = { ...metadata.route, ...metadata.targets[0]! };
    f.registry.assertModelTarget(route, "owner");
    assert.throws(
      () => f.registry.assertModelTarget(route, "other"),
      /current/,
    );
    await f.invoke("browser_workspace_inspect", { tabId: route.tabId }, route);
    await assert.rejects(
      f.invoke(
        "browser_workspace_inspect",
        { tabId: "workspace:wrong" },
        route,
      ),
      /exact/,
    );
    await f.invoke("browser_workspace_close", { tabId: route.tabId }, route);
    const fresh = readBrowserModelTargets(
      await f.invoke("browser_workspace_list_tabs"),
    )!;
    assert.equal(fresh.targets[0]!.tabId, route.tabId);
    assert.notEqual(fresh.targets[0]!.targetId, route.targetId);
    await assert.rejects(
      f.invoke("browser_workspace_inspect", { tabId: route.tabId }, route),
      /current/,
    );
    await f.invoke("browser_workspace_close_session");
    assert.throws(
      () => f.registry.assertModelTarget(fresh.route, "owner"),
      /current/,
    );
    const reopened = readBrowserModelTargets(
      await f.invoke("browser_workspace_list_tabs"),
    )!;
    assert.notEqual(reopened.route.sessionEpoch, fresh.route.sessionEpoch);
    assert.deepEqual(f.calls, ["inspect"]);
  } finally {
    await f.registry.close();
  }
});
test("Browser internal sideband survives trusted shallow copies, never JSON minting", () => {
  const route = {
    ownerThreadId: "owner",
    sessionId: "main",
    sessionEpoch: "epoch",
  };
  const value = attachBrowserModelRoute({}, route);
  assert.deepEqual(readBrowserModelRoute({ ...value }), route);
  assert.equal(readBrowserModelRoute({ browserModelRoute: route }), undefined);
  assert.equal(readBrowserModelRoute(structuredClone(value)), undefined);
  assert.throws(() => {
    readBrowserModelRoute(value)!.sessionEpoch = "changed";
  }, TypeError);
});

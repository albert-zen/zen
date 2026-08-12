import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBrowserTabCapacity,
  BrowserZenXCapabilityPackage,
  browserCapabilityManifest,
  browserPartitionName,
  MAX_BROWSER_TABS_GLOBAL,
  MAX_BROWSER_TABS_PER_SESSION,
  resolveBrowserObservedTarget,
  type BrowserInspection,
  type BrowserObservation,
  type BrowserTabSummary,
  type BrowserTargetFingerprint,
  type ZenXBrowserBackend,
} from "../src/main/capabilities/browser-provider.js";

test("browser vertical slice targets one session/tab through structured operations", async () => {
  const calls: string[] = [];
  const backend = browserBackend(calls);
  const capability = new BrowserZenXCapabilityPackage(backend);
  const opened = await capability.invoke(
    "browser_open",
    invocation({ sessionId: "research", url: "https://example.com/start" }),
  );
  assert.equal((opened as BrowserTabSummary).tabId, "tab-1");
  await capability.invoke(
    "browser_navigate",
    invocation({
      sessionId: "research",
      tabId: "tab-1",
      url: "https://example.com/next",
    }),
  );
  const inspection = (await capability.invoke(
    "browser_inspect",
    invocation({ sessionId: "research", tabId: "tab-1" }),
  )) as BrowserInspection;
  assert.equal(inspection.observationId, "observation-1");
  assert.deepEqual(
    inspection.targets.map(({ targetId }) => targetId),
    ["target-go", "target-query"],
  );
  await capability.invoke(
    "browser_click",
    invocation({
      sessionId: "research",
      tabId: "tab-1",
      observationId: inspection.observationId,
      targetId: "target-go",
    }),
  );
  const nextInspection = (await capability.invoke(
    "browser_inspect",
    invocation({ sessionId: "research", tabId: "tab-1" }),
  )) as BrowserInspection;
  await capability.invoke(
    "browser_type",
    invocation({
      sessionId: "research",
      tabId: "tab-1",
      observationId: nextInspection.observationId,
      targetId: "target-query",
      text: "Zen",
      submit: true,
    }),
  );
  await capability.invoke(
    "browser_close",
    invocation({ sessionId: "research", tabId: "tab-1" }),
  );
  await capability.invoke(
    "browser_close_session",
    invocation({ sessionId: "research" }),
  );
  assert.deepEqual(calls, [
    "open:research:https://example.com/start",
    "navigate:research:tab-1:https://example.com/next",
    "inspect:research:tab-1",
    "click:research:tab-1:observation-1:target-go",
    "inspect:research:tab-1",
    "type:research:tab-1:observation-1:target-query:3:true",
    "close:research:tab-1",
    "close-session:research",
  ]);
});

test("browser rejects stale and forged targets without classifying text sensitivity", () => {
  const editable = fingerprint({ actions: ["click", "type"] });
  const password = fingerprint({
    type: "password",
    secure: true,
    actions: ["click", "type"],
  });
  const observation: BrowserObservation = {
    id: "observation-1",
    documentVersion: 7,
    targets: new Map([
      ["editable", editable],
      ["password", password],
    ]),
  };
  assert.equal(
    resolveBrowserObservedTarget(
      observation,
      7,
      "observation-1",
      "editable",
      "type",
    ),
    editable,
  );
  assert.throws(
    () =>
      resolveBrowserObservedTarget(
        observation,
        8,
        "observation-1",
        "editable",
        "click",
      ),
    /stale or unknown/u,
  );
  assert.throws(
    () =>
      resolveBrowserObservedTarget(
        observation,
        7,
        "observation-1",
        "forged",
        "click",
      ),
    /forged/u,
  );
  assert.equal(
    resolveBrowserObservedTarget(
      observation,
      7,
      "observation-1",
      "password",
      "type",
    ),
    password,
  );
});

test("browser enforces per-session and global tab limits", () => {
  assert.doesNotThrow(() => assertBrowserTabCapacity(0, 0));
  assert.throws(
    () => assertBrowserTabCapacity(1, MAX_BROWSER_TABS_PER_SESSION),
    /session tab limit/u,
  );
  assert.throws(
    () => assertBrowserTabCapacity(MAX_BROWSER_TABS_GLOBAL, 0),
    /global tab limit/u,
  );
});

test("same logical session uses a fresh partition generation after close", () => {
  const first = browserPartitionName("research", 1);
  const reopened = browserPartitionName("research", 2);
  assert.notEqual(reopened, first);
  assert.match(first, /zenx-capability-research-1$/u);
  assert.match(reopened, /zenx-capability-research-2$/u);
});

test("browser refuses credential-bearing and sensitive URLs before provider use", async () => {
  const capability = new BrowserZenXCapabilityPackage(browserBackend([]));
  await assert.rejects(
    capability.invoke(
      "browser_open",
      invocation({
        sessionId: "research",
        url: "https://user:password@example.com/",
      }),
    ),
    /must not contain credentials/u,
  );
  await assert.rejects(
    capability.invoke(
      "browser_open",
      invocation({
        sessionId: "research",
        url: "https://example.com/?access_token=private",
      }),
    ),
    /sensitive query parameter/u,
  );
});

test("browser advertises a cross-platform dedicated background-safe provider", () => {
  assert.deepEqual(browserCapabilityManifest.provider.platforms, [
    "darwin",
    "win32",
    "linux",
  ]);
  assert.ok(
    browserCapabilityManifest.tools.every(
      (tool) => tool.interactionMode === "background_safe",
    ),
  );
  assert.ok(
    browserCapabilityManifest.tools.every((tool) =>
      tool.capabilities.includes("dedicated_profile"),
    ),
  );
});

function browserBackend(calls: string[]): ZenXBrowserBackend {
  const summary: BrowserTabSummary = {
    sessionId: "research",
    tabId: "tab-1",
    title: "Fixture",
    url: "https://example.com/",
    loading: false,
  };
  return {
    listTabs: async (sessionId) => {
      calls.push(`list:${sessionId}`);
      return [summary];
    },
    open: async (sessionId, url) => {
      calls.push(`open:${sessionId}:${url.replace(/\/$/u, "")}`);
      return summary;
    },
    navigate: async (sessionId, tabId, url) => {
      calls.push(`navigate:${sessionId}:${tabId}:${url.replace(/\/$/u, "")}`);
      return summary;
    },
    inspect: async (sessionId, tabId) => {
      calls.push(`inspect:${sessionId}:${tabId}`);
      return {
        ...summary,
        observationId: "observation-1",
        documentVersion: 1,
        visibleText: "Fixture page",
        targets: [
          {
            targetId: "target-go",
            role: "button",
            name: "Go",
            actions: ["click"],
          },
          {
            targetId: "target-query",
            role: "input",
            name: "Query",
            actions: ["click", "type"],
          },
        ],
      };
    },
    click: async (sessionId, tabId, observationId, targetId) => {
      calls.push(`click:${sessionId}:${tabId}:${observationId}:${targetId}`);
      return summary;
    },
    type: async (sessionId, tabId, observationId, targetId, text, submit) => {
      calls.push(
        `type:${sessionId}:${tabId}:${observationId}:${targetId}:${String(text.length)}:${String(submit)}`,
      );
      return summary;
    },
    closeTab: (sessionId, tabId) => {
      calls.push(`close:${sessionId}:${tabId}`);
    },
    closeSession: (sessionId) => {
      calls.push(`close-session:${sessionId}`);
      return 0;
    },
    close: () => undefined,
  };
}

function fingerprint(
  overrides: Partial<BrowserTargetFingerprint> = {},
): BrowserTargetFingerprint {
  return {
    selector: "#target",
    tag: "input",
    role: "input",
    name: "Target",
    type: "text",
    id: "target",
    fieldName: "target",
    autocomplete: "off",
    href: "",
    secure: false,
    actions: ["click"],
    ...overrides,
  };
}

function invocation(arguments_: Record<string, unknown>) {
  return {
    callId: "call-1",
    name: "test",
    arguments: arguments_,
    cwd: "/workspace",
    signal: new AbortController().signal,
  };
}

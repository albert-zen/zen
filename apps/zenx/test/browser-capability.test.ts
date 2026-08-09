import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserZenXCapabilityPackage,
  type BrowserInspection,
  type BrowserTabSummary,
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
  assert.equal(inspection.targets[0]?.selector, "#go");
  await capability.invoke(
    "browser_click",
    invocation({ sessionId: "research", tabId: "tab-1", selector: "#go" }),
  );
  await capability.invoke(
    "browser_type",
    invocation({
      sessionId: "research",
      tabId: "tab-1",
      selector: "#query",
      text: "Zen",
      submit: true,
    }),
  );
  assert.deepEqual(calls, [
    "open:research:https://example.com/start",
    "navigate:research:tab-1:https://example.com/next",
    "inspect:research:tab-1",
    "click:research:tab-1:#go",
    "type:research:tab-1:#query:3:true",
  ]);
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
        visibleText: "Fixture page",
        targets: [{ selector: "#go", role: "button", name: "Go" }],
      };
    },
    click: async (sessionId, tabId, selector) => {
      calls.push(`click:${sessionId}:${tabId}:${selector}`);
      return summary;
    },
    type: async (sessionId, tabId, selector, text, submit) => {
      calls.push(
        `type:${sessionId}:${tabId}:${selector}:${String(text.length)}:${String(submit)}`,
      );
      return summary;
    },
    close: () => undefined,
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

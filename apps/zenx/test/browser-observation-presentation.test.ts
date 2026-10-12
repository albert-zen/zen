import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserZenXCapabilityPackage,
  type BrowserInspection,
  type BrowserTabSummary,
  type ZenXBrowserBackend,
} from "../src/main/capabilities/browser-provider.js";
import { OBSERVATION_CAPTURE } from "../src/main/capabilities/observation-capture.js";
import type { ToolInvocation } from "../../../src/tool.js";

type Output = Record<string, any>;
function fixture() {
  let revision = 0,
    document = 0,
    inspectCount = 0;
  let value = "old",
    failInspect = false;
  const frames = new Map<string, string>();
  const actions: Array<{ observationId: string; targetId: string }> = [];
  const summary = (sessionId: string, tabId = "tab"): BrowserTabSummary => ({
    sessionId,
    tabId,
    title: "Fixture",
    url: "https://example.com/",
    loading: false,
  });
  const backend: ZenXBrowserBackend = {
    listTabs: async (sessionId) => [summary(sessionId)],
    open: async (sessionId) => summary(sessionId),
    navigate: async (sessionId, tabId) => {
      document++;
      frames.delete(sessionId);
      return summary(sessionId, tabId);
    },
    inspect: async (sessionId, tabId) => {
      inspectCount++;
      if (failInspect) throw new Error("fixture capture failed");
      const observationId = `observation-${++revision}`;
      frames.set(sessionId, observationId);
      const targets: BrowserInspection["targets"] = Array.from(
        { length: 160 },
        (_, i) => ({
          targetId: `raw-${revision}-${i}`,
          role: "input",
          name: `Field ${i} ${"context ".repeat(10)}`,
          actions: ["click", "type"],
          value,
        }),
      );
      const text = "read beyond the old text limit ".repeat(700);
      return {
        ...summary(sessionId, tabId),
        observationId,
        documentVersion: document,
        targets: targets.slice(0, 80),
        visibleText: text.slice(0, 8000),
        screenshot: {
          artifactPath: "/tmp/test-only.png",
          observationId,
          status: "captured",
          width: 1,
          height: 1,
          bytes: 100,
          expiresAt: "2030-01-01T00:00:00Z",
        },
        [OBSERVATION_CAPTURE]: {
          scopeKey: `${sessionId}/${document}`,
          entries: targets.map((target, i) => ({
            value: target,
            identity: `node-${i}`,
          })),
          text,
          coverage: {
            scope: "fixture document",
            sourceComplete: true,
            reasons: [],
            itemTotal: 160,
            textTotal: text.length,
          },
          assertCurrent: () => {
            if (frames.get(sessionId) !== observationId)
              throw new Error("native observation stale");
          },
        },
      };
    },
    click: async (sessionId, tabId, observationId, targetId) => {
      assert.equal(frames.get(sessionId), observationId);
      actions.push({ observationId, targetId });
      frames.delete(sessionId);
      return summary(sessionId, tabId);
    },
    type: async (sessionId, tabId, observationId, targetId, next) => {
      assert.equal(frames.get(sessionId), observationId);
      actions.push({ observationId, targetId });
      frames.delete(sessionId);
      value = next;
      return summary(sessionId, tabId);
    },
    scroll: async (sessionId, tabId, observationId) => {
      assert.equal(frames.get(sessionId), observationId);
      frames.delete(sessionId);
      return summary(sessionId, tabId);
    },
    closeTab: async (sessionId) => {
      frames.delete(sessionId);
    },
    closeSession: async (sessionId) => {
      frames.delete(sessionId);
      return 1;
    },
    close: async () => {
      frames.clear();
    },
  };
  return {
    capability: new BrowserZenXCapabilityPackage(backend),
    actions,
    get inspectCount() {
      return inspectCount;
    },
    failNextInspect: () => {
      failInspect = true;
    },
  };
}
function invocation(
  args: Record<string, unknown>,
  threadId = "owner-a",
): ToolInvocation {
  return {
    name: "test",
    callId: "call",
    cwd: "/tmp",
    threadId,
    arguments: { sessionId: "public-session", tabId: "tab", ...args },
    signal: new AbortController().signal,
  };
}
async function invoke(
  f: ReturnType<typeof fixture>,
  tool: string,
  args: Record<string, unknown> = {},
  threadId = "owner-a",
): Promise<Output> {
  return (await f.capability.invoke(
    tool,
    invocation(args, threadId),
  )) as Output;
}

test("Browser public cursor reaches actual captured text/targets with stable observation and session identity", async () => {
  const f = fixture();
  const first = await invoke(f, "browser_inspect");
  assert.equal(first.sessionId, "public-session");
  let out = first;
  let text = "";
  const targets: any[] = [];
  while (true) {
    text += out.visibleText;
    targets.push(...out.targets);
    assert.equal(out.observationId, first.observationId);
    assert.equal(out.sessionId, "public-session");
    if (out.nextCursor === undefined) break;
    out = await invoke(f, "browser_inspect", { cursor: out.nextCursor });
  }
  assert.equal(f.inspectCount, 1);
  assert.equal(targets.length, 160);
  assert.equal(text, "read beyond the old text limit ".repeat(700));
  await invoke(f, "browser_click", {
    observationId: first.observationId,
    targetId: targets[159].targetId,
  });
  assert.deepEqual(f.actions[0], {
    observationId: first.observationId,
    targetId: "raw-1-159",
  });
  await assert.rejects(
    invoke(f, "browser_inspect", { cursor: first.nextCursor }),
    /consumed/,
  );
});

test("Browser trusted ownership rejects foreign cursors, observation IDs and unreturned targets", async () => {
  const f = fixture();
  const first = await invoke(f, "browser_inspect");
  await assert.rejects(
    invoke(f, "browser_inspect", { cursor: first.nextCursor }, "owner-b"),
    /unavailable/,
  );
  await assert.rejects(
    invoke(
      f,
      "browser_click",
      {
        observationId: first.observationId,
        targetId: first.targets[0].targetId,
      },
      "owner-b",
    ),
    /unavailable/,
  );
  await assert.rejects(
    invoke(f, "browser_click", {
      observationId: first.observationId,
      targetId: "raw-1-159",
    }),
    /not returned/,
  );
  assert.equal(f.actions.length, 0);
});

test("Browser diffs retain presentation identity while actions translate to fresh private refs", async () => {
  const f = fixture();
  const first = await invoke(f, "browser_inspect");
  const second = await invoke(f, "browser_inspect", {
    baseObservationId: first.observationId,
  });
  assert.equal(second.observation.format, "diff");
  assert.equal(second.observation.unchanged, true);
  await assert.rejects(
    invoke(f, "browser_click", {
      observationId: first.observationId,
      targetId: first.targets[0].targetId,
    }),
    /stale/,
  );
  await invoke(f, "browser_click", {
    observationId: second.observationId,
    targetId: first.targets[0].targetId,
  });
  assert.deepEqual(f.actions[0], {
    observationId: second.observationId,
    targetId: "raw-2-0",
  });
});

test("Browser combined observation validates presentation inputs before mutation and preserves completed-action failures", async () => {
  const f = fixture();
  const first = await invoke(f, "browser_inspect");
  const action = {
    observationId: first.observationId,
    targetId: first.targets[0].targetId,
    observe: true,
  };
  await assert.rejects(
    invoke(f, "browser_click", { ...action, full: "yes" }),
    /boolean/,
  );
  await assert.rejects(
    invoke(f, "browser_click", { ...action, cursor: first.nextCursor }),
    /only supported/,
  );
  assert.equal(f.actions.length, 0);
  f.failNextInspect();
  const result = await invoke(f, "browser_click", {
    ...action,
    baseObservationId: first.observationId,
  });
  assert.equal(result.actionCompleted, true);
  assert.match(result.observationError, /capture failed/);
  assert.match(result.nextAction, /do not repeat/);
  assert.equal(f.actions.length, 1);
});

test("Browser navigation and close retire cursors while full/base omission resets lost model context", async () => {
  const f = fixture();
  const first = await invoke(f, "browser_inspect");
  const navigated = await invoke(f, "browser_navigate", {
    url: "https://example.com/next",
    observe: true,
    baseObservationId: first.observationId,
  });
  assert.equal(navigated.observation.format, "full");
  assert.equal(navigated.observation.resetReason, "scope-changed");
  await assert.rejects(
    invoke(f, "browser_inspect", { cursor: first.nextCursor }),
    /cursor.*unknown/,
  );
  const resync = await invoke(f, "browser_inspect");
  assert.equal(resync.observation.format, "full");
  assert.ok(resync.targets.length > 0);
  await invoke(f, "browser_close");
  await assert.rejects(
    invoke(f, "browser_inspect", { cursor: resync.nextCursor }),
    /unavailable/,
  );
});

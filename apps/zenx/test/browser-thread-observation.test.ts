import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserZenXCapabilityPackage,
  type ZenXBrowserBackend,
} from "../src/main/capabilities/browser-provider.js";

function fixture() {
  const calls: string[] = [];
  const backend = {
    async open(sessionId: string, url: string) {
      calls.push(sessionId);
      return {
        sessionId,
        tabId: `tab-${calls.length}`,
        url,
        title: url,
        loading: false,
      };
    },
    async close() {},
  } as unknown as ZenXBrowserBackend;
  return { calls, package_: new BrowserZenXCapabilityPackage(backend) };
}
function invocation(threadId: string) {
  return {
    callId: "call",
    name: "browser_open",
    arguments: { sessionId: "work", url: "https://example.test/" },
    cwd: "/workspace",
    threadId,
    signal: new AbortController().signal,
  };
}
test("threads using the same logical Browser session receive separate provider sessions", async () => {
  const { calls, package_ } = fixture();
  const first = (await package_.invoke(
    "browser_open",
    invocation("thread-a"),
  )) as { sessionId: string };
  await package_.invoke("browser_open", invocation("thread-b"));
  await package_.invoke("browser_open", invocation("thread-a"));
  assert.notEqual(calls[0], calls[1]);
  assert.equal(calls[0], calls[2]);
  assert.equal(first.sessionId, "work");
  await package_.close();
});

test("thread subscriptions, manual page selection, late frames and provider retirement stay scoped", async () => {
  const listeners: Array<{
    session: string;
    tab: string;
    send: (event: any) => void;
    stopped: boolean;
  }> = [];
  let counter = 0;
  const backend = {
    async open(sessionId: string, url: string) {
      return {
        sessionId,
        tabId: `tab-${++counter}`,
        url,
        title: url,
        loading: false,
      };
    },
    observeTab(session: string, tab: string, send: (event: any) => void) {
      const listener = { session, tab, send, stopped: false };
      listeners.push(listener);
      send({ type: "status", status: "live", message: "live" });
      return () => {
        listener.stopped = true;
      };
    },
    async closeTab() {},
    async closeSession() {
      return 1;
    },
    async close() {},
  } as unknown as ZenXBrowserBackend;
  const capability = new BrowserZenXCapabilityPackage(backend);
  const a: any[] = [];
  const b: any[] = [];
  let stopA = capability.observeThread(
    { threadId: "thread-a", frames: true },
    (event) => a.push(event),
  );
  const stopB = capability.observeThread(
    { threadId: "thread-b", frames: false },
    (event) => b.push(event),
  );
  await capability.invoke("browser_open", invocation("thread-a"));
  const firstA = listeners.at(-1)!;
  const frame = {
    type: "frame",
    frame: {
      sequence: 1,
      mimeType: "image/jpeg",
      data: "YQ==",
      width: 1,
      height: 1,
    },
  };
  firstA.send(frame);
  const aCount = a.length;
  await capability.invoke("browser_open", invocation("thread-b"));
  assert.equal(a.length, aCount);
  assert.equal(firstA.stopped, false);
  assert.equal(
    b.some((event) => event.type === "frame"),
    false,
  );
  const firstTarget = a.findLast(
    (event) => event.type === "targets",
  ).selectedId;
  stopA();
  stopA = capability.observeThread(
    { threadId: "thread-a", frames: true, targetId: firstTarget },
    (event) => a.push(event),
  );
  await capability.invoke("browser_open", invocation("thread-a"));
  assert.equal(listeners.at(-1)!.tab, firstA.tab);
  const beforeLate = a.length;
  firstA.send(frame);
  assert.equal(a.length, beforeLate);
  stopA();
  const priorCount = listeners.length;
  stopA = capability.observeThread(
    { threadId: "thread-b", frames: true, targetId: firstTarget },
    (event) => b.push(event),
  );
  assert.equal(
    listeners.length,
    priorCount,
    "A target must not be subscribable through B",
  );
  await capability.close();
  assert.equal(b.at(-1).status, "unavailable");
  stopA();
  stopB();
});

test("an unattributed tool call never becomes a selected thread's Browser resource", async () => {
  const { package_ } = fixture();
  const events: any[] = [];
  const stop = package_.observeThread(
    { threadId: "thread-a", frames: false },
    (event) => events.push(event),
  );
  const { threadId: _threadId, ...unattributed } = invocation("thread-a");
  await package_.invoke("browser_open", unattributed);
  assert.deepEqual(
    events.findLast((event) => event.type === "targets").targets,
    [],
  );
  stop();
  await package_.close();
});

test("an empty browser tab list retains the session needed for later cleanup", async () => {
  const sessions: string[] = [];
  const backend = {
    async listTabs(sessionId: string) {
      sessions.push(sessionId);
      return [];
    },
    async closeSession(sessionId: string) {
      sessions.push(sessionId);
      return 0;
    },
    async close() {},
  } as unknown as ZenXBrowserBackend;
  const capability = new BrowserZenXCapabilityPackage(backend);
  await capability.invoke("browser_list_tabs", invocation("thread-a"));
  await capability.invoke("browser_close_session", invocation("thread-a"));
  assert.equal(sessions[0], sessions[1]);
  await capability.close();
});

test("a renderer observer failure cannot turn a completed Browser action into a tool failure", async () => {
  const { package_ } = fixture();
  package_.observeThread({ threadId: "thread-a", frames: false }, (event) => {
    if (event.type === "targets" && event.targets.length > 0)
      throw new Error("renderer destroyed");
  });
  const result = (await package_.invoke(
    "browser_open",
    invocation("thread-a"),
  )) as { sessionId: string };
  assert.equal(result.sessionId, "work");
  await package_.close();
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

test("extension serializes rapid tab choices and ignores an old port disconnect", async () => {
  const clicked = event();
  const debuggerDetached = event();
  const tabUpdated = event();
  const tabRemoved = event();
  const ports = [];
  const attached = new Set();
  const attachCalls = [];
  const detachCalls = [];
  let activeAttaches = 0;
  let maximumActiveAttaches = 0;
  let releaseFirstAttach;
  const firstAttach = new Promise((resolve) => {
    releaseFirstAttach = resolve;
  });
  const chrome = {
    action: {
      onClicked: clicked,
      setBadgeBackgroundColor: async () => undefined,
      setBadgeText: async () => undefined,
      setTitle: async () => undefined,
    },
    debugger: {
      onEvent: event(),
      onDetach: debuggerDetached,
      attach: async ({ tabId }) => {
        attachCalls.push(tabId);
        activeAttaches += 1;
        maximumActiveAttaches = Math.max(maximumActiveAttaches, activeAttaches);
        if (tabId === 1) await firstAttach;
        attached.add(tabId);
        activeAttaches -= 1;
      },
      detach: async ({ tabId }) => {
        detachCalls.push(tabId);
        attached.delete(tabId);
        debuggerDetached.emit({ tabId }, "target_closed");
      },
      sendCommand: async () => ({}),
    },
    runtime: {
      connectNative: () => {
        const port = nativePort();
        ports.push(port);
        return port;
      },
      getManifest: () => ({ version: "1.0.0" }),
      lastError: undefined,
    },
    tabs: { onUpdated: tabUpdated, onRemoved: tabRemoved },
  };
  const source = await readFile(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../resources/chrome-extension/service-worker.js",
    ),
    "utf8",
  );
  vm.runInNewContext(source, {
    chrome,
    clearTimeout,
    setTimeout,
  });

  clicked.emit(tab(1));
  clicked.emit(tab(2));
  await waitFor(() => attachCalls.length === 1);
  assert.deepEqual(attachCalls, [1]);
  releaseFirstAttach();
  await waitFor(() => attached.has(2));
  assert.deepEqual(attachCalls, [1, 2]);
  assert.deepEqual(detachCalls, [1]);
  assert.equal(maximumActiveAttaches, 1);
  assert.deepEqual([...attached], [2]);

  clicked.emit(tab(2));
  await waitFor(() => attached.size === 0 && ports[0]?.disconnected === true);
  clicked.emit(tab(3));
  await waitFor(() => attached.has(3) && ports.length === 2);
  ports[0].onDisconnect.emit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([...attached], [3]);

  clicked.emit(tab(3));
  await waitFor(() => attached.size === 0);
  assert.deepEqual(detachCalls, [1, 2, 3]);
});

function event() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...arguments_) {
      for (const listener of [...listeners]) listener(...arguments_);
    },
  };
}

function nativePort() {
  const onMessage = event();
  const onDisconnect = event();
  return {
    onMessage,
    onDisconnect,
    disconnected: false,
    postMessage(message) {
      if (message?.type === "hello") {
        queueMicrotask(() =>
          onMessage.emit({ type: "ready", protocolVersion: 1 }),
        );
      }
    },
    disconnect() {
      this.disconnected = true;
    },
  };
}

function tab(id) {
  return { id, title: `Tab ${id}`, url: `https://tab-${id}.test/` };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for fixture");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

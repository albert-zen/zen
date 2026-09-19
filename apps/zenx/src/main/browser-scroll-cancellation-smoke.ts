import assert from "node:assert/strict";
import { BrowserWindow } from "electron";
import { ElectronBrowserBackend } from "./capabilities/browser-provider.js";

/** Real Electron backend regression; only the debugger acknowledgement is held. */
export async function verifyElectronScrollCancellation(
  url: string,
): Promise<void> {
  const existing = new Set(
    BrowserWindow.getAllWindows().map((window) => window.id),
  );
  const backend = new ElectronBrowserBackend();
  try {
    const opened = await backend.open("scroll-cancellation", url);
    const window = BrowserWindow.getAllWindows().find(
      (window) => !existing.has(window.id),
    );
    assert.ok(window);
    const debugger_ = window.webContents.debugger;
    const original = debugger_.sendCommand.bind(debugger_);
    let dispatched = 0;
    debugger_.sendCommand = async (...args) => {
      dispatched += 1;
      return await original(...args);
    };
    let observation = await backend.inspect(opened.sessionId, opened.tabId);
    dispatched = 0;
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      backend.scroll(
        opened.sessionId,
        opened.tabId,
        observation.observationId,
        "down",
        200,
        preAborted.signal,
      ),
      { name: "AbortError" },
    );
    assert.equal(dispatched, 0, "pre-abort must dispatch no page command");
    // Pre-abort has not consumed the observation.
    await backend.scroll(
      opened.sessionId,
      opened.tabId,
      observation.observationId,
      "down",
      200,
    );

    for (const fail of [false, true]) {
      debugger_.sendCommand = original;
      observation = await backend.inspect(opened.sessionId, opened.tabId);
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      debugger_.sendCommand = async (...args) => {
        const result = await original(...args);
        started.resolve();
        await gate.promise;
        if (fail) throw new Error("Simulated debugger acknowledgement failure");
        return result;
      };
      const controller = new AbortController();
      let settled = false;
      const scrolling = backend.scroll(
        opened.sessionId,
        opened.tabId,
        observation.observationId,
        "down",
        200,
        controller.signal,
      );
      const outcome = scrolling.then(
        () => {
          settled = true;
          return undefined;
        },
        (error) => {
          settled = true;
          return error as unknown;
        },
      );
      await started.promise;
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        settled,
        false,
        "abort must not release a still-pending debugger call",
      );
      gate.resolve();
      const error = await outcome;
      assert.ok(error instanceof Error);
      assert.match(error.message, /outcome unknown.*inspect again/i);
      await assert.rejects(
        backend.scroll(
          opened.sessionId,
          opened.tabId,
          observation.observationId,
          "up",
          200,
        ),
        /stale or unknown/,
      );
    }
    debugger_.sendCommand = original;
  } finally {
    await backend.close();
  }
}

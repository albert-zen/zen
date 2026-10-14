import assert from "node:assert/strict";
import test from "node:test";
import { createFakeCdpServer, waitUntil } from "./fixtures/user-browser-cdp.js";
import { connectUserBrowserCdp } from "../src/main/capabilities/user-browser-provider.js";

test("closing an observed target never acknowledges a frame queued behind its detach request", async () => {
  const cdp = await createFakeCdpServer();
  const { backend } = await connectUserBrowserCdp(cdp.endpoint, undefined, {
    liveFrameImageDecoder: async (encoded) => ({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      resize: () => {
        throw Error("unneeded");
      },
      toJPEG: () => encoded,
    }),
  });
  let detached = false;
  cdp.interceptRequests((request, emit) => {
    if (request.method === "Target.detachFromTarget") {
      detached = true;
      emit({
        method: "Page.screencastFrame",
        sessionId: request.params.sessionId,
        params: { sessionId: 99, data: "", metadata: {} },
      });
    }
    if (detached && request.method === "Page.screencastFrameAck") {
      emit({
        id: request.id,
        sessionId: undefined,
        error: { code: -32001, message: "Session with given id not found." },
      });
    }
  });
  try {
    await backend.listTabs("work");
    const stop = backend.observeTab!("work", "target-1", () => {});
    await waitUntil(() => cdp.count("Page.startScreencast") === 1);
    await backend.closeSession("work");
    await new Promise((r) => setTimeout(r, 20));
    stop();
    await backend.close();
    assert.equal(cdp.count("Page.screencastFrameAck"), 0);
  } finally {
    await Promise.resolve(backend.close()).catch(() => {});
    await cdp.close();
  }
});

test("a late screencast start acknowledgement never sends stop to an already detached route", async () => {
  const cdp = await createFakeCdpServer();
  const { backend } = await connectUserBrowserCdp(cdp.endpoint);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let detached = false;
  cdp.interceptRequests(async (request, emit) => {
    if (request.method === "Page.startScreencast") await held;
    if (request.method === "Target.detachFromTarget") detached = true;
    if (detached && request.method === "Page.stopScreencast") {
      emit({
        id: request.id,
        sessionId: undefined,
        error: { code: -32001, message: "Session with given id not found." },
      });
    }
  });
  try {
    await backend.listTabs("work");
    backend.observeTab!("work", "target-1", () => {});
    await waitUntil(() => cdp.count("Page.startScreencast") === 1);
    await backend.closeSession("work");
    release();
    await new Promise((r) => setTimeout(r, 20));
    await backend.close();
    assert.equal(cdp.count("Page.stopScreencast"), 0);
  } finally {
    release();
    await Promise.resolve(backend.close()).catch(() => {});
    await cdp.close();
  }
});

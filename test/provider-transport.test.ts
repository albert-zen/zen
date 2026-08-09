import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";

import { createProviderFetch, safeProxyUrl } from "../apps/cli/src/host.js";

test("validates a credential-free explicit provider proxy", () => {
  assert.equal(safeProxyUrl("http://127.0.0.1:7897"), "http://127.0.0.1:7897/");
  for (const invalid of [
    "socks5://127.0.0.1:7897",
    "http://127.0.0.1:7897/path",
    "http://127.0.0.1:7897/?token=value",
  ]) {
    assert.throws(() => safeProxyUrl(invalid), /Provider proxy URL/u);
  }
});

test("rejects proxy credentials without echoing them", () => {
  const secret = "proxy-secret-value";
  let error: unknown;
  try {
    safeProxyUrl(`http://proxy-user:${secret}@127.0.0.1:7897`);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error);
  assert.doesNotMatch(error.message, /proxy-user/u);
  assert.doesNotMatch(error.message, new RegExp(secret, "u"));
});

test("an aborted proxied provider fetch terminates without leaking proxy state", async () => {
  const connected = deferred<void>();
  const sockets = new Set<Socket>();
  const server = createServer((_request, _response) => connected.resolve());
  server.on("connect", (_request, socket) => {
    connected.resolve();
    socket.once("error", () => undefined);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(typeof address === "object" && address !== null);
    const fetch = createProviderFetch({
      proxyUrl: `http://127.0.0.1:${String(address.port)}`,
    });
    const controller = new AbortController();
    const request = fetch("http://provider.test/", {
      signal: controller.signal,
    });
    await Promise.race([
      connected.promise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("Proxy was not contacted")), 2_000),
      ),
    ]);
    controller.abort(new DOMException("Cancelled by test", "AbortError"));
    for (const socket of sockets) socket.destroy();
    await Promise.race([
      assert.rejects(request, (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "AbortError");
        return true;
      }),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Aborted proxy request hung")),
          2_000,
        ),
      ),
    ]);
    await fetch.close?.();
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

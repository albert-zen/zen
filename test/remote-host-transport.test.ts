import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { RemoteHostAccess } from "../src/protocol/native/remote-host.js";
import {
  REMOTE_UNAUTHENTICATED_MS,
  serveRemoteHost,
} from "../src/protocol/native/remote-transport.js";

// Generated for this test invocation only; never reused as a production identity.
test("TLS pairing + two authenticated clients, rejected origin, revoke closes active socket", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-remote-tls-"));
  try {
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          path.join(dir, "key.pem"),
          "-out",
          path.join(dir, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "ignore" },
      );
    } catch {
      t.skip("OpenSSL unavailable for ephemeral TLS fixture");
      return;
    }
    const cert = await readFile(path.join(dir, "cert.pem"));
    const key = await readFile(path.join(dir, "key.pem"));
    const host = createHostedAppServer({
      cwd: dir,
      dataDirectory: path.join(dir, "data"),
      model: "fake",
      provider: { type: "fake" },
      journal: new InMemoryThreadJournal(),
      approvalPolicy: "never",
    });
    const access = new RemoteHostAccess({
      appServer: host,
      hostId: "desktop",
      workspaces: () => [{ id: "workspace", cwd: dir, label: "Work" }],
    });
    const server = await serveRemoteHost({
      enabled: true,
      listen: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      access,
    });
    try {
      const code = access.createPairingCode();
      const paired = await postPair(server.url, cert, {
        hostId: "desktop",
        deviceId: "phone",
        code,
      });
      assert.equal(paired.status, 200);
      const token = (paired.body as { token: string }).token;
      assert.equal(
        (
          await postPair(server.url, cert, {
            hostId: "desktop",
            deviceId: "copy",
            code,
          })
        ).status,
        401,
      );
      assert.equal(await rejected(server.url, cert, "phone", "wrong"), 401);
      assert.equal(
        await rejected(
          server.url,
          cert,
          "phone",
          token,
          "https://unknown.test",
        ),
        403,
      );
      const socket = await connect(server.url, cert, "phone", token);
      const second = await connect(server.url, cert, "phone", token);
      try {
        const hello = await rpc(socket, 1, "zen/remote/hello", {
          hostId: "desktop",
          version: 1,
        });
        assert.equal((hello.result as { hostId: string }).hostId, "desktop");
        await new Promise((resolve) =>
          setTimeout(resolve, REMOTE_UNAUTHENTICATED_MS + 100),
        );
        assert.equal(
          socket.readyState,
          WebSocket.OPEN,
          "upgraded authenticated sockets do not inherit the unauthenticated deadline",
        );
        assert.equal(
          (
            await rpc(socket, 2, "zen/remote/hello", {
              hostId: "wrong",
              version: 1,
            })
          ).error?.data?.code,
          "wrong_host",
        );
        const created = await rpc(socket, 3, "zen/remote/create", {
          workspaceId: "workspace",
        });
        const threadId = (created.result as { id: string }).id;
        await rpc(second, 1, "zen/remote/hello", {
          hostId: "desktop",
          version: 1,
        });
        const sent = await rpc(socket, 4, "zen/remote/send", {
          workspaceId: "workspace",
          threadId,
          clientId: "same",
          text: "hello",
        });
        const duplicated = await rpc(second, 2, "zen/remote/send", {
          workspaceId: "workspace",
          threadId,
          clientId: "same",
          text: "hello",
        });
        assert.deepEqual(duplicated.result, sent.result);
        const snapshot = await rpc(second, 3, "zen/remote/resume", {
          workspaceId: "workspace",
          threadId,
        });
        assert.equal(
          (
            snapshot.result as {
              entries: { kind: string; item: { type: string } }[];
            }
          ).entries.filter(
            (entry) =>
              entry.kind === "item" && entry.item.type === "user_message",
          ).length,
          1,
        );
        const other = await rpc(socket, 5, "zen/remote/create", {
          workspaceId: "workspace",
        });
        const oldId = (other.result as { id: string }).id;
        const realRead = host.readThread.bind(host);
        let notifyEntered = () => {};
        const entered = new Promise<void>((resolve) => {
          notifyEntered = resolve;
        });
        let releaseRead = () => {};
        const release = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        let delayed = false;
        host.readThread = async (id) => {
          if (id === oldId && !delayed) {
            delayed = true;
            notifyEntered();
            await release;
          }
          return await realRead(id);
        };
        const stale = rpc(socket, 6, "zen/remote/resume", {
          workspaceId: "workspace",
          threadId: oldId,
        });
        await entered;
        const current = await rpc(socket, 7, "zen/remote/resume", {
          workspaceId: "workspace",
          threadId,
        });
        assert.equal(
          (current.result as { thread: { id: string } }).thread.id,
          threadId,
        );
        releaseRead();
        assert.equal((await stale).error?.data?.code, "stale_cursor");
        const closed = once(socket, "close");
        access.revoke("phone");
        await closed;
        assert.equal(await rejected(server.url, cert, "phone", token), 401);
      } finally {
        socket.terminate();
        second.terminate();
      }
    } finally {
      await server.close();
      access.close();
      await host.closeHostResources();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

type Response = {
  id: number;
  result?: unknown;
  error?: { data?: { code?: string } };
};
async function rpc(
  socket: WebSocket,
  id: number,
  method: string,
  params: unknown,
): Promise<Response> {
  const pending = new Promise<Response>((resolve, reject) => {
    const handler = (raw: unknown) => {
      try {
        const message = JSON.parse(String(raw)) as Response;
        if (message.id === id) {
          socket.off("message", handler);
          resolve(message);
        }
      } catch (error) {
        reject(error);
      }
    };
    socket.on("message", handler);
  });
  socket.send(JSON.stringify({ id, method, params }));
  return await pending;
}
async function connect(
  url: string,
  ca: Buffer,
  deviceId: string,
  token: string,
): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    ca,
    headers: { "x-zen-device-id": deviceId, Authorization: `Bearer ${token}` },
  });
  await once(socket, "open");
  return socket;
}
async function rejected(
  url: string,
  ca: Buffer,
  deviceId: string,
  token: string,
  origin?: string,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      ca,
      headers: {
        "x-zen-device-id": deviceId,
        Authorization: `Bearer ${token}`,
        ...(origin ? { Origin: origin } : {}),
      },
    });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    socket.once("error", reject);
  });
}
async function postPair(
  url: string,
  ca: Buffer,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const endpoint = new URL(
      url.replace("wss:", "https:").replace("/remote", "/pair"),
    );
    const req = request(
      endpoint,
      { method: "POST", ca, headers: { "content-type": "application/json" } },
      (response) => {
        let result = "";
        response.setEncoding("utf8");
        response.on("data", (part: string) => {
          result += part;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(result) as unknown,
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { textFromUserMessage } from "../src/item.js";
import { RemoteHostAccess } from "../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../src/protocol/native/remote-transport.js";

type Page = {
  processEpoch: string;
  threadId: string;
  watermark: number;
  thread: { id: string; name?: string; archived: boolean };
  entries: (
    | { kind: "item"; item: { id: string; type: string; text?: string } }
    | {
        kind: "text_fragment";
        item: { id: string; type: string };
        offset: number;
        text: string;
        complete: boolean;
      }
  )[];
  nextCursor: string | null;
};
async function rpc(
  ws: WebSocket,
  id: number,
  method: string,
  params: unknown,
): Promise<{ result?: Page; error?: { data?: { code?: string } } }> {
  const reply = new Promise<{
    result?: Page;
    error?: { data?: { code?: string } };
  }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`RPC ${method} timeout`)),
      15000,
    );
    const on = (raw: unknown) => {
      const data = JSON.parse(String(raw)) as {
        id?: number;
        result?: Page;
        error?: { data?: { code?: string } };
      };
      if (data.id === id) {
        clearTimeout(timer);
        ws.off("message", on);
        resolve(data);
      }
    };
    ws.on("message", on);
  });
  ws.send(JSON.stringify({ id, method, params }));
  return await reply;
}

test("legitimate >2MiB canonical history is fully recovered through bounded TLS pages after reconnect", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-paged-recovery-"));
  let socket: WebSocket | undefined;
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
      t.skip("OpenSSL unavailable");
      return;
    }
    const cert = await readFile(path.join(dir, "cert.pem"));
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
      workspaces: () => [{ id: "demo", cwd: dir, label: "Demo" }],
    });
    const server = await serveRemoteHost({
      enabled: true,
      listen: "127.0.0.1",
      port: 0,
      tls: { cert, key: await readFile(path.join(dir, "key.pem")) },
      access,
    });
    try {
      const thread = await host.startThread({
        cwd: dir,
        sandbox: "read-only",
        approvalPolicy: "always",
      });
      for (let n = 0; n < 76; n++)
        await (
          await host.startTurn(
            thread.id,
            `${String(n).padStart(3, "0")}:${"x".repeat(29000)}`,
          )
        ).done;
      const token = (
        await access.pair({
          hostId: "desktop",
          deviceId: "phone",
          code: access.createPairingCode(),
        })
      ).token;
      const connect = async () => {
        const ws = new WebSocket(server.url, {
          ca: cert,
          headers: {
            Authorization: `Bearer ${token}`,
            "x-zen-device-id": "phone",
          },
        });
        await once(ws, "open");
        await rpc(ws, 1, "zen/remote/hello", { hostId: "desktop", version: 1 });
        return ws;
      };
      socket = await connect();
      const first = await rpc(socket, 2, "zen/remote/resume", {
        workspaceId: "demo",
        threadId: thread.id,
      });
      assert(
        first.result && first.result.nextCursor,
        JSON.stringify(first.error),
      );
      const stale = first.result.nextCursor;
      socket.terminate();
      socket = await connect();
      assert.equal(
        (await rpc(socket, 3, "zen/remote/resume/page", { cursor: stale }))
          .error?.data?.code,
        "stale_cursor",
      );
      const restored = await rpc(socket, 4, "zen/remote/resume", {
        workspaceId: "demo",
        threadId: thread.id,
      });
      assert(restored.result);
      let current = restored.result;
      const originalItems = (await host.readThread(thread.id)).items.filter(
        (item) => item.type === "user_message",
      );
      const notifications: {
        method?: string;
        params?: { event?: { type?: string; item?: { id?: string } } };
      }[] = [];
      socket.on("message", (raw) => {
        const event = JSON.parse(String(raw)) as (typeof notifications)[number];
        if (event.method === "zen/remote/thread/event")
          notifications.push(event);
      });
      const late = await host.startTurn(
        thread.id,
        "new item during pagination",
      );
      await late.done;
      const lateId = (await host.readThread(thread.id)).items.find(
        (item) => item.type === "user_message" && item.turnId === late.id,
      )?.id;
      assert(lateId);
      const collected = new Map<string, string>();
      let pageCount = 0;
      let requestId = 5;
      while (true) {
        pageCount++;
        assert(pageCount < 150, "cursor must make progress");
        assert(
          Buffer.byteLength(
            JSON.stringify({ id: requestId, result: current }),
          ) < 300_000,
          "bounded page",
        );
        for (const entry of current.entries) {
          if (entry.kind === "item" && entry.item.type === "user_message")
            collected.set(entry.item.id, entry.item.text ?? "");
          if (
            entry.kind === "text_fragment" &&
            entry.item.type === "user_message"
          ) {
            const existing = collected.get(entry.item.id) ?? "";
            assert.equal(existing.length, entry.offset);
            collected.set(entry.item.id, existing + entry.text);
          }
        }
        if (current.nextCursor === null) break;
        const cursor = current.nextCursor;
        const next = await rpc(socket, requestId++, "zen/remote/resume/page", {
          cursor,
        });
        assert(next.result, JSON.stringify(next.error));
        if (pageCount === 1) {
          const retry = await rpc(
            socket,
            requestId++,
            "zen/remote/resume/page",
            { cursor },
          );
          assert.deepEqual(
            retry.result,
            next.result,
            "lost-page retry returns bounded identical result",
          );
        }
        current = next.result;
      }
      assert(pageCount > 1);
      assert.equal(collected.size, originalItems.length);
      assert(
        !collected.has(lateId),
        "first recovery preserves its canonical boundary",
      );
      for (const item of originalItems)
        assert.equal(
          collected.get(item.id),
          textFromUserMessage(item),
          item.id,
        );
      const deadline = Date.now() + 2000;
      while (
        !notifications.some(({ params }) => params?.event?.item?.id === lateId)
      ) {
        if (Date.now() > deadline)
          throw new Error(
            "buffered live item was not delivered after final page",
          );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      socket?.terminate();
      await server.close();
      access.close();
      await host.closeHostResources();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

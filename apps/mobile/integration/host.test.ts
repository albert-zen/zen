import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import os from "node:os";
import WS from "ws";
const NodeSocket = WS.WebSocket ?? WS;
import { createHostedAppServer } from "../../../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { RemoteHostAccess } from "../../../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../../../src/protocol/native/remote-transport.js";
import { RemoteHostTransport } from "../src/remote-core";

test("Android client transport pairs over trusted TLS, shares Host authority with second device, revocation fails closed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-mobile-host-"));
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
    const key = await readFile(path.join(dir, "key.pem"));
    const host = createHostedAppServer({
      cwd: dir,
      dataDirectory: path.join(dir, "data"),
      model: "fake",
      provider: { type: "fake" },
      journal: new InMemoryThreadJournal(),
      approvalPolicy: "never",
    });
    let workspaceAllowed = true;
    const access = new RemoteHostAccess({
      appServer: host,
      hostId: "isolated-test",
      workspaces: () =>
        workspaceAllowed ? [{ id: "w", cwd: dir, label: "Isolated" }] : [],
    });
    const server = await serveRemoteHost({
      enabled: true,
      listen: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      access,
    });
    try {
      const endpoint = server.url
        .replace(/^wss:/u, "https:")
        .replace(/\/remote$/u, "");
      const secrets = new Map<string, string>();
      let count = 0;
      const mobile = new RemoteHostTransport(
        () => [{ id: "isolated-test", name: "Isolated", endpoint }],
        {
          getSecret: async (k) => secrets.get(k) ?? null,
          setSecret: async (k, v) => {
            secrets.set(k, v);
          },
          deleteSecret: async (k) => {
            secrets.delete(k);
          },
          uuid: () => `device-or-command-${++count}`,
          // Explicit test CA, not TLS verification disablement or process-wide trust change.
          fetch: (async (url: string, init: RequestInit) =>
            await new Promise((resolve, reject) => {
              const req = httpsRequest(
                url,
                {
                  method: "POST",
                  ca: cert,
                  headers: init.headers as Record<string, string>,
                },
                (res) => {
                  let data = "";
                  res.on("data", (chunk) => (data += String(chunk)));
                  res.on("end", () =>
                    resolve({
                      ok: res.statusCode === 200,
                      status: res.statusCode,
                      json: async () => JSON.parse(data),
                    }),
                  );
                },
              );
              req.on("error", reject);
              req.end(init.body as string);
            })) as typeof fetch,
          openSocket: (url, headers) =>
            new NodeSocket(url, { ca: cert, headers }) as unknown as WebSocket,
        },
      );
      await mobile.pair("isolated-test", access.createPairingCode());
      assert.equal(
        (await mobile.snapshot("isolated-test", null)).workspaces[0]?.id,
        "w",
      );
      assert.deepEqual(
        (await mobile.snapshot("isolated-test", "w")).threads,
        [],
      );
      assert.deepEqual(
        await mobile.command("isolated-test", "w", "create", {}),
        { accepted: true },
      );
      const threads = (await mobile.snapshot("isolated-test", "w")).threads;
      assert.equal(threads.length, 1);
      const id = threads[0]!.id;
      await mobile.read("isolated-test", "w", id);
      const sent = await mobile.command("isolated-test", "w", "send", {
        threadId: id,
        text: "test from Android client",
      });
      assert.deepEqual(sent, { accepted: true });
      const second = new NodeSocket(server.url, {
        ca: cert,
        headers: {
          "x-zen-device-id": JSON.parse([...secrets.values()][0]!).deviceId,
          Authorization: `Bearer ${JSON.parse([...secrets.values()][0]!).token}`,
        },
      });
      await new Promise<void>((resolve, reject) => {
        second.on("open", resolve);
        second.on("error", reject);
      });
      try {
        const rpc = async (method: string, params: object) => {
          const id = Math.random();
          return await new Promise<any>((resolve, reject) => {
            const handler = (raw: unknown) => {
              const data = JSON.parse(String(raw));
              if (data.id === id) {
                second.off("message", handler);
                resolve(data);
              }
            };
            second.on("message", handler);
            second.send(JSON.stringify({ id, method, params }), (err) => {
              if (err) reject(err);
            });
          });
        };
        await rpc("zen/remote/hello", { version: 1, hostId: "isolated-test" });
        const resumed = await rpc("zen/remote/resume", {
          workspaceId: "w",
          threadId: id,
        });
        assert.equal(
          resumed.result.entries.filter(
            (entry: any) =>
              entry.kind === "item" && entry.item.type === "user_message",
          ).length,
          1,
        );
      } finally {
        second.terminate();
      }
      const full = await host.startThread({
        cwd: dir,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      });
      await mobile.read("isolated-test", "w", full.id);
      await assert.rejects(
        mobile.command("isolated-test", "w", "send", {
          threadId: full.id,
          text: "do not run",
        }),
        /operation_forbidden/,
      );
      assert.equal(
        (await host.readThread(full.id)).items.filter(
          (item) => item.type === "user_message",
        ).length,
        0,
      );
      // Real TLS Host v1: losing a dynamic workspace invalidates the live view,
      // no public user body is delivered; a fresh resume is required after regrant.
      const projected: any[] = [];
      mobile.subscribe("isolated-test", "w", (event) => projected.push(event));
      await mobile.read("isolated-test", "w", id);
      workspaceAllowed = false;
      await (
        await host.startTurn(id, "private-during-scope-loss")
      ).done;
      const deadline = Date.now() + 3000;
      while (!projected.some((event) => event.type === "resync")) {
        if (Date.now() > deadline)
          throw Error("Host did not invalidate lost-scope live subscription");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(
        !projected.some(
          (event) =>
            event.type === "snapshot" &&
            Object.values(event.items)
              .flat()
              .some((item: any) =>
                item.text?.includes("private-during-scope-loss"),
              ),
        ),
      );
      assert.deepEqual(
        await mobile.command("isolated-test", "w", "send", {
          threadId: id,
          text: "must not send while invalidated",
        }),
        {
          accepted: false,
          error: "Open a Thread and verify its current Turn first.",
        },
      );
      while (!projected.some((event) => event.type === "offline")) {
        if (Date.now() > deadline)
          throw Error("Lost-scope fresh resume did not report denial");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      workspaceAllowed = true;
      assert.ok(
        (await mobile.read("isolated-test", "w", id)).some(
          (item) => item.text === "private-during-scope-loss",
        ),
      );
      access.revoke(JSON.parse([...secrets.values()][0]!).deviceId);
      await assert.rejects(
        mobile.snapshot("isolated-test", "w"),
        /disconnected|offline|unauthorized|connection|Host/i,
      );
      mobile.disconnect();
    } finally {
      await server.close();
      access.close();
      await host.closeHostResources();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

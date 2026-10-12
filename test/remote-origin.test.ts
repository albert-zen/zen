import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { RemoteHostAccess } from "../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../src/protocol/native/remote-transport.js";

async function freePort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert(address && typeof address !== "string");
  socket.close();
  await once(socket, "close");
  return address.port;
}

async function wsStatus(
  url: string,
  cert: Buffer,
  headers: Record<string, string>,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { ca: cert, family: 4, headers });
    ws.once("unexpected-response", (_req, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    ws.once("error", reject);
    ws.once("open", () => {
      ws.close();
      resolve(101);
    });
  });
}

async function rawUpgrade(
  port: number,
  cert: Buffer,
  headers: string[],
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      servername: "localhost",
      ca: cert,
    });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      socket.write(
        [
          "GET /remote HTTP/1.1",
          ...headers,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("data", (part) => {
      const match = /^HTTP\/1\.1 (\d+)/u.exec(String(part));
      if (!match) reject(new Error("invalid HTTP response"));
      else resolve(Number(match[1]));
      socket.destroy();
    });
  });
}

async function httpStatus(
  port: number,
  cert: Buffer,
  method: string,
  origin?: string,
  body?: string,
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const req = request(
      `https://localhost:${port}/pair`,
      {
        method,
        family: 4,
        ca: cert,
        headers: {
          ...(origin === undefined ? {} : { Origin: origin }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

// This test uses a disposable CA as the client's explicit trust anchor and a
// fake Host bound only to 127.0.0.1. No bearer or pairing code is logged.
test("opt-in exact native Origin keeps pair, browser and device boundaries", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-origin-"));
  let host: ReturnType<typeof createHostedAppServer> | undefined;
  let access: RemoteHostAccess | undefined;
  let server: Awaited<ReturnType<typeof serveRemoteHost>> | undefined;
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
    const port = await freePort();
    host = createHostedAppServer({
      cwd: dir,
      dataDirectory: path.join(dir, "data"),
      model: "fake",
      provider: { type: "fake" },
      journal: new InMemoryThreadJournal(),
      approvalPolicy: "never",
    });
    let allowed = true;
    access = new RemoteHostAccess({
      appServer: host,
      hostId: "desktop",
      workspaces: () =>
        allowed ? [{ id: "workspace", cwd: dir, label: "Work" }] : [],
    });
    const invalid = async (
      originEndpoint: string,
      boundPort = port,
      certificate = cert,
    ) =>
      await assert.rejects(
        serveRemoteHost({
          enabled: true,
          listen: "127.0.0.1",
          port: boundPort,
          tls: { cert: certificate, key },
          access: access!,
          originEndpoint,
        }),
      );
    await invalid(`https://localhost:${port + 1}`); // wrong port
    await invalid(`https://evil.test:${port}`); // SAN mismatch
    await invalid(`https://localhost:${port}/remote`);
    await invalid(`https://localhost:0${port}`);
    await invalid(`https://xn--evil:${port}`);
    await invalid(`https://[::1]:${port}`);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        path.join(dir, "no-san-key.pem"),
        "-out",
        path.join(dir, "no-san.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    await invalid(
      `https://localhost:${port}`,
      port,
      await readFile(path.join(dir, "no-san.pem")),
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        path.join(dir, "wildcard-key.pem"),
        "-out",
        path.join(dir, "wildcard.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=foo.test",
        "-addext",
        "subjectAltName=DNS:*.test",
      ],
      { stdio: "ignore" },
    );
    await invalid(
      `https://foo.test:${port}`,
      port,
      await readFile(path.join(dir, "wildcard.pem")),
    );
    const options = {
      enabled: true as const,
      listen: "127.0.0.1",
      port,
      tls: { cert, key },
      access,
      originEndpoint: `https://localhost:${port}`,
    };
    server = await serveRemoteHost(options);
    assert.match(server.url, /^wss:\/\/127\.0\.0\.1:/u);
    const code = access.createPairingCode();
    const pairing = JSON.stringify({
      hostId: "desktop",
      deviceId: "phone",
      code,
    });
    assert.equal(
      await httpStatus(port, cert, "OPTIONS", "https://evil.test"),
      404,
    );
    assert.equal(
      await httpStatus(
        port,
        cert,
        "POST",
        `https://localhost:${port}`,
        pairing,
      ),
      403,
    );
    const token = await new Promise<string>((resolve, reject) => {
      const req = request(
        `https://localhost:${port}/pair`,
        {
          method: "POST",
          family: 4,
          ca: cert,
          headers: { "content-type": "application/json" },
        },
        (response) => {
          let data = "";
          response.on("data", (chunk) => (data += String(chunk)));
          response.on("end", () => {
            try {
              assert.equal(response.statusCode, 200);
              resolve((JSON.parse(data) as { token: string }).token);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.once("error", reject);
      req.end(pairing);
    });
    const url = `wss://localhost:${port}/remote`,
      origin = `https://localhost:${port}`;
    const credentials = {
      Authorization: `Bearer ${token}`,
      "x-zen-device-id": "phone",
    };
    assert.equal(
      await wsStatus(url, cert, {
        ...credentials,
        Origin: "https://evil.test",
      }),
      403,
    );
    assert.equal(
      await wsStatus(url, cert, { ...credentials, Origin: origin }),
      101,
    );
    assert.equal(
      await wsStatus(url, cert, {
        ...credentials,
        Origin: `https://LOCALHOST:${port}`,
        Host: `LOCALHOST:${port}`,
      }),
      101,
    );
    assert.equal(await wsStatus(url, cert, { ...credentials }), 101);
    for (const headers of [
      { Origin: origin },
      { ...credentials, Origin: origin, Host: `127.0.0.1:${port}` },
      { ...credentials, Origin: "null" },
      { ...credentials, Origin: `http://localhost:${port}` },
      { ...credentials, Origin: `${origin}/` },
      { ...credentials, Origin: `${origin}, ${origin}` },
      { ...credentials, Origin: `https://localhost:${port + 1}` },
    ])
      assert.notEqual(await wsStatus(url, cert, headers), 101);
    assert.equal(
      await wsStatus(url, cert, {
        ...credentials,
        Origin: origin,
        "x-zen-device-id": "other",
      }),
      401,
    );
    assert.equal(
      await wsStatus(url, cert, {
        ...credentials,
        Origin: origin,
        Authorization: "Bearer wrong",
      }),
      401,
    );
    const basics = [
      `Host: localhost:${port}`,
      `Origin: ${origin}`,
      `Authorization: Bearer ${token}`,
      "x-zen-device-id: phone",
    ];
    assert.notEqual(
      await rawUpgrade(port, cert, [...basics, `Origin: ${origin}`]),
      101,
    );
    assert.notEqual(
      await rawUpgrade(port, cert, [...basics, `oRiGiN: ${origin}`]),
      101,
    );
    assert.notEqual(
      await rawUpgrade(port, cert, [...basics, `Host: localhost:${port}`]),
      101,
    );
    assert.notEqual(
      await rawUpgrade(port, cert, [
        `Host: evil.test`,
        `Origin: ${origin}`,
        `Authorization: Bearer ${token}`,
        "x-zen-device-id: phone",
        `X-Forwarded-Host: localhost:${port}`,
      ]),
      101,
    );
    access.revoke("phone");
    assert.equal(
      await wsStatus(url, cert, { ...credentials, Origin: origin }),
      401,
    );
    // Exercise a valid-origin authenticated socket through the existing v1
    // hello and dynamically scoped read, not just HTTP 101.
    const device = "second",
      secondCode = access.createPairingCode();
    const another = JSON.stringify({
      hostId: "desktop",
      deviceId: device,
      code: secondCode,
    });
    const token2 = await new Promise<string>((resolve, reject) => {
      const req = request(
        `https://localhost:${port}/pair`,
        {
          method: "POST",
          family: 4,
          ca: cert,
          headers: { "content-type": "application/json" },
        },
        (response) => {
          let data = "";
          response.on("data", (chunk) => (data += String(chunk)));
          response.on("end", () => {
            try {
              assert.equal(response.statusCode, 200);
              resolve((JSON.parse(data) as { token: string }).token);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.once("error", reject);
      req.end(another);
    });
    const ws = new WebSocket(url, {
      family: 4,
      ca: cert,
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token2}`,
        "x-zen-device-id": device,
      },
    });
    try {
      await once(ws, "open");
      const rpc = (
        id: number,
        method: string,
        params: Record<string, unknown>,
      ) =>
        new Promise<{ result?: unknown; error?: unknown }>(
          (resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("RPC timeout")),
              5000,
            );
            const on = (data: unknown) => {
              const message = JSON.parse(String(data)) as {
                id?: number;
                result?: unknown;
                error?: unknown;
              };
              if (message.id !== id) return;
              clearTimeout(timer);
              ws.off("message", on);
              resolve(message);
            };
            ws.on("message", on);
            ws.send(JSON.stringify({ id, method, params }));
          },
        );
      assert(
        (await rpc(1, "zen/remote/hello", { hostId: "desktop", version: 1 }))
          .result,
      );
      const thread = await host.startThread({
        cwd: dir,
        sandbox: "read-only",
        approvalPolicy: "always",
      });
      assert(
        (
          await rpc(2, "zen/remote/resume", {
            workspaceId: "workspace",
            threadId: thread.id,
          })
        ).result,
      );
      allowed = false;
      assert(
        (
          await rpc(3, "zen/remote/resume", {
            workspaceId: "workspace",
            threadId: thread.id,
          })
        ).error,
      );
      const closed = once(ws, "close");
      access.revoke(device);
      assert.equal((await closed)[0], 4003);
    } finally {
      ws.terminate();
    }
    await server.close();
    server = undefined;
    const oldPolicy = await serveRemoteHost({
      enabled: true,
      listen: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      access,
    });
    try {
      const legacyUrl = oldPolicy.url;
      assert.equal(
        await wsStatus(legacyUrl, cert, {
          ...credentials,
          Origin: `https://127.0.0.1:${new URL(legacyUrl).port}`,
        }),
        403,
      );
    } finally {
      await oldPolicy.close();
    }
  } finally {
    await server?.close();
    access?.close();
    await host?.closeHostResources();
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { RemoteHostAccess } from "../src/protocol/native/remote-host.js";
import {
  REMOTE_MAX_UNAUTHENTICATED,
  serveRemoteHost,
} from "../src/protocol/native/remote-transport.js";

async function before<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("explicit close aborts partial TLS pair requests and handshakes, leaves no listener", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-remote-shutdown-"));
  let server: Awaited<ReturnType<typeof serveRemoteHost>> | undefined;
  const peers: { destroy(): void }[] = [];
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
      hostId: "dev",
      workspaces: () => [{ id: "demo", cwd: dir, label: "Demo" }],
    });
    try {
      server = await serveRemoteHost({
        enabled: true,
        listen: "127.0.0.1",
        port: 0,
        tls: { cert, key: await readFile(path.join(dir, "key.pem")) },
        access,
      });
      const port = Number(new URL(server.url).port);
      const slow = tlsConnect({
        host: "127.0.0.1",
        port,
        ca: cert,
        servername: "localhost",
      });
      peers.push(slow);
      await once(slow, "secureConnect");
      slow.write(
        "POST /pair HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: keep-alive\r\n\r\n{",
      );
      const unfinishedHandshake = tcpConnect(port, "127.0.0.1");
      peers.push(unfinishedHandshake);
      await once(unfinishedHandshake, "connect");
      const closed = Promise.all([
        once(slow, "close"),
        once(unfinishedHandshake, "close"),
      ]);
      const started = Date.now();
      await before(server.close(), 2000, "unbounded shutdown");
      await closed;
      assert(Date.now() - started < 2000);
      assert(slow.destroyed && unfinishedHandshake.destroyed);
      await assert.rejects(
        once(tcpConnect(port, "127.0.0.1"), "connect"),
        /ECONNREFUSED/,
      );
    } finally {
      for (const peer of peers) peer.destroy();
      await server?.close();
      access.close();
      await host.closeHostResources();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unauthenticated TLS sessions have a finite admission count", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-remote-cap-"));
  const peers: TLSSocket[] = [];
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
      hostId: "dev",
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
      const port = Number(new URL(server.url).port);
      for (let i = 0; i < REMOTE_MAX_UNAUTHENTICATED; i++) {
        const socket = tlsConnect({
          host: "127.0.0.1",
          port,
          ca: cert,
          servername: "localhost",
        });
        peers.push(socket);
        await once(socket, "secureConnect");
      }
      const overflow = tlsConnect({
        host: "127.0.0.1",
        port,
        ca: cert,
        servername: "localhost",
      });
      peers.push(overflow);
      overflow.on("error", () => undefined);
      await before(
        once(overflow, "close"),
        2000,
        "unauthenticated connection cap not enforced",
      );
      assert(overflow.destroyed);
      const first = peers[0]!;
      const firstClosed = once(first, "close");
      first.destroy();
      await firstClosed;
      const partial = tlsConnect({
        host: "127.0.0.1",
        port,
        ca: cert,
        servername: "localhost",
      });
      peers.push(partial);
      await once(partial, "secureConnect");
      partial.write(
        "POST /pair HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{",
      );
      const started = Date.now();
      await before(
        once(partial, "close"),
        7000,
        "partial pair body did not expire",
      );
      assert(Date.now() - started >= 4_500 && Date.now() - started < 7_000);
    } finally {
      for (const peer of peers) peer.destroy();
      await server.close();
      access.close();
      await host.closeHostResources();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

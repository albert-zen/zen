import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { RemoteHostAccess } from "../../../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../../../src/protocol/native/remote-transport.js";
import { NativeFleetClient } from "../src/main/fleet-native.js";
test("committed remote message with lost journal acknowledgement remains an unknown outcome", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-r2-unknown-"));
  const certFile = path.join(dir, "cert.pem"),
    keyFile = path.join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(certFile),
    key = await readFile(keyFile),
    store = new InMemoryThreadJournal();
  let armed = false;
  const journal = {
    read: (id: string) => store.read(id),
    listThreadIds: () => store.listThreadIds(),
    create: (items: any) => store.create(items),
    append: async (item: any) => {
      await store.append(item);
      if (armed && item.type === "user_message")
        throw new Error("fixture write acknowledgement lost after commit");
    },
  };
  const host = createHostedAppServer({
    cwd: dir,
    dataDirectory: path.join(dir, "data"),
    model: "fake",
    provider: { type: "fake" },
    journal,
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  const access = new RemoteHostAccess({
    appServer: host,
    hostId: "host",
    access: "control",
    workspaces: () => [{ id: "work", cwd: dir, label: "Work" }],
  });
  const server = await serveRemoteHost({
    enabled: true,
    listen: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    access,
  });
  const peer = {
    id: "remote",
    label: "Remote",
    transport: "https" as const,
    hostId: "host",
    endpoint: server.url.replace(/^wss:/, "https:").replace(/\/remote$/, ""),
    access: "control" as const,
    workspace: "work",
  };
  const vault = new Map<string, any>();
  const client = new NativeFleetClient({
    ca: cert,
    credentials: {
      get: async (id) => vault.get(id) ?? null,
      set: async (id, v) => {
        vault.set(id, v);
      },
      delete: async (id) => {
        vault.delete(id);
      },
    },
  });
  try {
    await client.pair(peer, access.createPairingCode());
    const thread = await host.startThread({ cwd: dir });
    armed = true;
    let failure: any;
    try {
      await client.invoke(
        peer,
        {
          version: 1,
          name: "zenx_threads_send",
          arguments: {
            target: thread.id,
            text: "This message was canonically committed",
          },
          callId: "one",
        },
        AbortSignal.timeout(10000),
      );
    } catch (e: any) {
      failure = e;
    }
    assert.ok(failure);
    assert.notEqual(failure.confirmedRejection, true);
    assert.match(failure.message, /outcome unknown/);
    assert.equal(
      (await store.read(thread.id)).filter((i) => i.type === "user_message")
        .length,
      1,
    );
  } finally {
    await server.close();
    access.close();
    await host.closeHostResources();
    await rm(dir, { recursive: true, force: true });
  }
});

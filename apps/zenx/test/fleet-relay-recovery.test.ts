import assert from "node:assert/strict";
import test from "node:test";
import {
  serveFleetRelay,
  hashFleetRelayToken,
  connectFleetRelayHost,
} from "../src/main/fleet-relay.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostedAppServer } from "../../cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { RemoteHostAccess } from "../../../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../../../src/protocol/native/remote-transport.js";
import { NativeFleetClient } from "../src/main/fleet-native.js";
test(
  "relay disconnect resumes read-only observation and recovers the same canonical Turn once",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-relay-recovery-"));
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
    const relay = await serveFleetRelay({
      enabled: true,
      listen: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      registrations: [
        {
          hostId: "host",
          tokenSha256: hashFleetRelayToken("fixture-registration-token"),
        },
      ],
    });
    const bridgeOptions = {
      hostId: "host",
      relayEndpoint: relay.endpoint,
      registrationToken: "fixture-registration-token",
      nativeEndpoint: server.url
        .replace(/^wss:/, "https:")
        .replace(/\/remote$/, ""),
      ca: cert,
      nativeCa: cert,
    };
    let bridge = await connectFleetRelayHost(bridgeOptions);
    const peer = {
      id: "remote",
      label: "Remote",
      transport: "https" as const,
      hostId: "host",
      endpoint: relay.endpoint,
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
      const turn = await host.startTurn(
        thread.id,
        `!shell ${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},2200)"`,
      );
      const outcomes: any[] = [];
      const errors: string[] = [];
      let ready = 0;
      const stop = await client.subscribeThread(
        peer,
        "work",
        thread.id,
        {
          includeCurrentTerminal: false,
          onTurn: (t) => outcomes.push(t),
          onError: (e) => errors.push(e.message),
          onReady: () => ready++,
        },
        AbortSignal.timeout(12000),
      );
      try {
        await bridge.close();
        await new Promise((r) => setTimeout(r, 100));
        bridge = await connectFleetRelayHost(bridgeOptions);
        await turn.done;
        await new Promise((r) => setTimeout(r, 1800));
        assert.ok(ready >= 2);
        assert.deepEqual(outcomes, [
          { threadId: thread.id, turnId: turn.id, status: "completed" },
        ]);
        assert.equal((await client.test(peer)).status, "connected");
        assert.equal(
          (await host.readThread(thread.id)).items.filter(
            (item) => item.type === "turn_started",
          ).length,
          1,
        );
      } finally {
        stop();
      }
    } finally {
      await bridge.close();
      await relay.close();
      await server.close();
      access.close();
      await host.closeHostResources();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ZenAppServer } from "../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { ToolEnvironment } from "../../../src/tool.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { serveCodexWebSocket } from "../../../src/protocol/codex/websocket.js";
import {
  ZenXProtocolClient,
  ZenXProtocolError,
} from "../src/protocol-client/index.js";
import {
  MutableAppServerRequestPort,
  ZenXSelfControlCapabilityPackage,
} from "../src/main/capabilities/self-control-package.js";

for (const messageType of ["guidance", "follow_up", "replacement"] as const) {
  test(`exact-ID idle ${messageType} start rejects archive before admission with no Item or Turn`, async () => {
    const f = await fixture();
    try {
      const selected = (await f.client.request("thread/start", {})).thread;
      const before = await f.journal.read(selected.id);
      const original = f.port.request.bind(f.port);
      let archived = false;
      f.port.request = (async (method, params) => {
        if (
          (method === "turn/start" || method === "zen/turn/send-unarchived") &&
          "threadId" in params &&
          params.threadId === selected.id
        ) {
          await f.app.setThreadArchived(selected.id, true);
          archived = true;
        }
        return await original(method, params);
      }) as typeof f.port.request;
      await assert.rejects(
        f.invoke({
          threadId: selected.id,
          text: "must not execute",
          messageType,
        }),
        /archived.*unarchive/iu,
      );
      assert.equal(archived, true);
      assert.deepEqual(await f.journal.read(selected.id), before);
      assert.equal((await f.app.readThread(selected.id)).turns.length, 0);
      assert.equal(f.samples(), 0);
    } finally {
      await f.close();
    }
  });
}

for (const [mode, messageType] of [
  ["steer", "guidance"],
  ["queue", "follow_up"],
  ["replace", "replacement"],
] as const) {
  test(`exact-ID ${mode} rejects when archive wins after the active snapshot`, async () => {
    const f = await fixture(true);
    try {
      const selected = (await f.client.request("thread/start", {})).thread;
      const seed = await f.app.startTurn(selected.id, "existing work");
      await f.entered;
      const original = f.port.request.bind(f.port);
      let before: Awaited<ReturnType<typeof f.journal.read>> | undefined;
      let attempts = 0;
      f.port.request = (async (method, params) => {
        if (
          method === "zen/turn/send-unarchived" &&
          "mode" in params &&
          params.mode === mode
        ) {
          attempts++;
          f.release();
          await seed.done;
          await f.app.setThreadArchived(selected.id, true);
          before = await f.journal.read(selected.id);
        }
        return await original(method, params);
      }) as typeof f.port.request;
      await assert.rejects(
        f.invoke({
          threadId: selected.id,
          text: "must not append",
          messageType,
        }),
        /archived.*unarchive/iu,
      );
      assert.equal(attempts, 1);
      assert.deepEqual(await f.journal.read(selected.id), before);
      const snapshot = await f.app.readThread(selected.id);
      assert.equal(snapshot.archived, true);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(f.samples(), 1);
    } finally {
      await f.close();
    }
  });
}

test("exact-ID replacement replay preserves the receipt and rejects later archive admission", async () => {
  const f = await fixture(true);
  try {
    const selected = (await f.client.request("thread/start", {})).thread;
    const seed = await f.app.startTurn(selected.id, "existing work");
    await f.entered;
    const callId = randomUUID();
    const args = {
      threadId: selected.id,
      text: "replacement",
      messageType: "replacement",
    };
    const accepted = (await f.invoke(args, callId)) as {
      turnId: string;
      interruptedTurnId: string;
      clientUserMessageId: string;
    };
    assert.equal(accepted.interruptedTurnId, seed.id);
    const completed = await f.app.replaceTurn(
      selected.id,
      seed.id,
      "replacement",
      { clientId: accepted.clientUserMessageId },
    );
    await completed.turn.done;
    assert.equal(completed.turn.id, accepted.turnId);
    const before = await f.journal.read(selected.id);
    const original = f.port.request.bind(f.port);
    let attempts = 0;
    f.port.request = (async (method, params) => {
      if (
        method === "zen/turn/send-unarchived" &&
        "mode" in params &&
        params.mode === "replace"
      ) {
        attempts++;
        await f.app.setThreadArchived(selected.id, true);
      }
      return await original(method, params);
    }) as typeof f.port.request;
    await assert.rejects(f.invoke(args, callId), /archived.*unarchive/iu);
    assert.equal(attempts, 1);
    assert.deepEqual(await f.journal.read(selected.id), before);
    assert.equal(f.samples(), 2);
  } finally {
    await f.close();
  }
});

test("exact-ID guidance retries a definite start race with the same fenced identity", async () => {
  const f = await fixture(true);
  try {
    const selected = (await f.client.request("thread/start", {})).thread;
    const original = f.port.request.bind(f.port);
    const identities: string[] = [];
    let seed: Awaited<ReturnType<typeof f.app.startTurn>> | undefined;
    let before: Awaited<ReturnType<typeof f.journal.read>> | undefined;
    f.port.request = (async (method, params) => {
      if (
        method === "zen/turn/send-unarchived" &&
        "mode" in params &&
        "clientUserMessageId" in params
      ) {
        identities.push(params.clientUserMessageId);
        if (params.mode === "start") {
          seed = await f.app.startTurn(selected.id, "another client won");
          await f.entered;
        } else if (params.mode === "steer") {
          f.release();
          await seed!.done;
          await f.app.setThreadArchived(selected.id, true);
          before = await f.journal.read(selected.id);
        }
      }
      return await original(method, params);
    }) as typeof f.port.request;
    await assert.rejects(
      f.invoke({
        threadId: selected.id,
        text: "exact guidance",
        messageType: "guidance",
      }),
      /archived.*unarchive/iu,
    );
    assert.equal(identities.length, 2);
    assert.equal(identities[0], identities[1]);
    assert.deepEqual(await f.journal.read(selected.id), before);
    assert.equal(f.samples(), 1);
  } finally {
    await f.close();
  }
});

test("fuzzy self-control delivery retains its historical unfenced admission", async () => {
  const f = await fixture();
  try {
    const selected = (await f.client.request("thread/start", {})).thread;
    await f.app.setThreadName(selected.id, "explicit fuzzy title");
    const original = f.port.request.bind(f.port);
    let methodUsed: string | undefined;
    f.port.request = (async (method, params) => {
      if (method === "turn/start") {
        methodUsed = method;
        await f.app.setThreadArchived(selected.id, true);
      }
      return await original(method, params);
    }) as typeof f.port.request;
    const result = (await f.invoke({
      target: "explicit fuzzy title",
      text: "historical behavior",
      messageType: "guidance",
    })) as { turnId: string };
    assert.equal(methodUsed, "turn/start");
    assert.ok(result.turnId);
    const snapshot = await f.app.readThread(selected.id);
    assert.equal(snapshot.archived, true);
    assert.equal(snapshot.turns.length, 1);
  } finally {
    await f.close();
  }
});

test("exact-ID guidance retries a definite steer race without losing its archive fence", async () => {
  const f = await fixture(true);
  try {
    const selected = (await f.client.request("thread/start", {})).thread;
    const seed = await f.app.startTurn(selected.id, "existing work");
    await f.entered;
    const original = f.port.request.bind(f.port);
    const modes: string[] = [],
      identities: string[] = [];
    let before: Awaited<ReturnType<typeof f.journal.read>> | undefined;
    f.port.request = (async (method, params) => {
      if (
        method === "zen/turn/send-unarchived" &&
        "mode" in params &&
        "clientUserMessageId" in params
      ) {
        modes.push(params.mode);
        identities.push(params.clientUserMessageId);
        if (params.mode === "steer") {
          f.release();
          await seed.done;
        } else if (params.mode === "start") {
          await f.app.setThreadArchived(selected.id, true);
          before = await f.journal.read(selected.id);
        }
      }
      return await original(method, params);
    }) as typeof f.port.request;
    await assert.rejects(
      f.invoke({
        threadId: selected.id,
        text: "fenced retry",
        messageType: "guidance",
      }),
      /archived.*unarchive/iu,
    );
    assert.deepEqual(modes, ["steer", "start"]);
    assert.equal(identities[0], identities[1]);
    assert.deepEqual(await f.journal.read(selected.id), before);
    assert.equal(f.samples(), 1);
  } finally {
    await f.close();
  }
});

test("native unarchived admission is optional, strictly boolean, and not a CAS parameter", async () => {
  const f = await fixture();
  try {
    const selected = (await f.client.request("thread/start", {})).thread;
    await f.app.setThreadArchived(selected.id, true);
    const before = await f.journal.read(selected.id);
    await assert.rejects(
      f.client.request("zen/turn/send", {
        threadId: selected.id,
        mode: "start",
        clientUserMessageId: "invalid-flag",
        input: [{ type: "text", text: "invalid flag" }],
        requireUnarchived: "true",
      } as unknown as Parameters<typeof f.client.request<"zen/turn/send">>[1]),
      /must be a boolean/u,
    );
    await assert.rejects(
      f.client.request("turn/start", {
        threadId: selected.id,
        input: [{ type: "text", text: "wrong protocol" }],
        requireUnarchived: true,
      } as unknown as Parameters<typeof f.client.request<"turn/start">>[1]),
      /requireUnarchived.*not supported|unsupported.*requireUnarchived/iu,
    );
    assert.deepEqual(await f.journal.read(selected.id), before);
    const result = await f.client.request("zen/turn/send", {
      threadId: selected.id,
      mode: "start",
      clientUserMessageId: "legacy-default",
      input: [{ type: "text", text: "old default" }],
    });
    assert.ok(result.turnId);
    assert.equal((await f.app.readThread(selected.id)).archived, true);
    const other = (await f.client.request("thread/start", {})).thread;
    await f.app.setThreadArchived(other.id, true);
    assert.ok(
      (
        await f.client.request("zen/turn/send", {
          threadId: other.id,
          mode: "start",
          clientUserMessageId: "explicit-old-default",
          input: [{ type: "text", text: "false preserves defaults" }],
          requireUnarchived: false,
        })
      ).turnId,
    );
  } finally {
    await f.close();
  }
});

for (const messageType of ["guidance", "follow_up", "replacement"] as const) {
  test(`an old Host rejects exact ${messageType} without an unguarded fallback`, async () => {
    const f = await fixture();
    try {
      const selected = (await f.client.request("thread/start", {})).thread;
      const before = await f.journal.read(selected.id);
      const original = f.port.request.bind(f.port);
      let guarded = 0,
        unguarded = 0;
      f.port.request = (async (method, params) => {
        if (method === "zen/turn/send-unarchived") {
          guarded++;
          throw new ZenXProtocolError(
            -32601,
            "Method not found: zen/turn/send-unarchived",
          );
        }
        if (
          [
            "zen/turn/send",
            "turn/start",
            "turn/steer",
            "turn/queue",
            "turn/replace",
          ].includes(method)
        )
          unguarded++;
        return await original(method, params);
      }) as typeof f.port.request;
      await assert.rejects(
        f.invoke({
          threadId: selected.id,
          text: "requires upgraded Host",
          messageType,
        }),
        /does not support archive-fenced.*Update the target Host/u,
      );
      assert.equal(guarded, 1);
      assert.equal(unguarded, 0);
      assert.deepEqual(await f.journal.read(selected.id), before);
      assert.equal(f.samples(), 0);
    } finally {
      await f.close();
    }
  });
}

test("guarded native send enforces archival even when a caller supplies a false flag", async () => {
  const f = await fixture();
  try {
    const selected = (await f.client.request("thread/start", {})).thread;
    await f.app.setThreadArchived(selected.id, true);
    const before = await f.journal.read(selected.id);
    await assert.rejects(
      f.client.request("zen/turn/send-unarchived", {
        threadId: selected.id,
        mode: "start",
        clientUserMessageId: "cannot-weaken",
        input: [{ type: "text", text: "must remain fenced" }],
        requireUnarchived: false,
      }),
      /archived.*unarchive/iu,
    );
    assert.deepEqual(await f.journal.read(selected.id), before);
    assert.equal(f.samples(), 0);
  } finally {
    await f.close();
  }
});

async function fixture(holdFirst = false) {
  const journal = new InMemoryThreadJournal();
  let samples = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const app = new ZenAppServer({
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ bundles: [] }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "fixture",
        adapter: {
          provider: "fixture",
          async *stream(request) {
            samples++;
            if (samples === 1 && holdFirst) {
              enter();
              await Promise.race([
                released,
                new Promise<void>((resolve) => {
                  if (request.signal.aborted) resolve();
                  else
                    request.signal.addEventListener("abort", () => resolve(), {
                      once: true,
                    });
                }),
              ]);
              if (request.signal.aborted) return;
            }
            yield { type: "text_delta", delta: "done" };
          },
        },
        modelCatalog: new StaticModelCatalog([
          { id: "fixture", contextWindow: 32768, isDefault: true },
        ]),
      },
    ]),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: "fixture",
      modelId: "fixture",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const server = await serveCodexWebSocket({
    appServer: app,
    zenHome: process.cwd(),
    listen: "ws://127.0.0.1:0",
  });
  const client = await ZenXProtocolClient.connect({
    url: server.url,
    clientInfo: {
      name: "archive-admission-fixture",
      title: "Fixture",
      version: "1",
    },
  });
  const port = new MutableAppServerRequestPort();
  await port.attach(client, process.cwd());
  const control = new ZenXSelfControlCapabilityPackage({ appServer: port });
  return {
    app,
    journal,
    client,
    port,
    control,
    entered,
    release,
    samples: () => samples,
    invoke: async (args: Record<string, unknown>, callId = randomUUID()) =>
      await control.invoke("zenx_threads_send", {
        name: "zenx_threads_send",
        arguments: args,
        callId,
        cwd: process.cwd(),
        signal: new AbortController().signal,
      }),
    close: async () => {
      release();
      client.close();
      await server.close();
    },
  };
}

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import type { CanonicalItem } from "../src/item.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import {
  RemoteHostAccess,
  RemoteHostError,
  projectRemoteItem,
} from "../src/protocol/native/remote-host.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-remote-test-"));
  const a = await realpath(root);
  const b = await mkdtemp(path.join(os.tmpdir(), "zen-remote-other-"));
  const host = createHostedAppServer({
    cwd: a,
    dataDirectory: path.join(root, "host-data"),
    model: "fake",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    approvalPolicy: "never",
  });
  const remote = new RemoteHostAccess({
    appServer: host,
    hostId: "desktop-a",
    workspaces: () => [{ id: "a", cwd: a, label: "A" }],
  });
  return {
    host,
    remote,
    a,
    b,
    async close() {
      remote.close();
      await host.closeHostResources();
      await rm(root, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    },
  };
}

async function errorCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof RemoteHostError && error.code === code,
  );
}

test("pairing is host-bound, one-shot, rejects unauthorized and revokes connected clients", async () => {
  const f = await fixture();
  try {
    const pairing = f.remote.createPairingCode();
    await errorCode(
      () =>
        f.remote.pair({ hostId: "other", deviceId: "phone", code: pairing }),
      "wrong_host",
    );
    const enrolled = await f.remote.pair({
      hostId: "desktop-a",
      deviceId: "phone",
      code: pairing,
    });
    await errorCode(
      () =>
        f.remote.pair({ hostId: "desktop-a", deviceId: "copy", code: pairing }),
      "unauthorized",
    );
    await errorCode(
      () => f.remote.hello("phone", "incorrect", "desktop-a", 0),
      "unauthorized",
    );
    assert.equal(
      (await f.remote.hello("phone", enrolled.token, "desktop-a", 0)).hostId,
      "desktop-a",
    );
    await errorCode(
      () => f.remote.hello("phone", enrolled.token, "wrong", 0),
      "wrong_host",
    );
    f.remote.revoke("phone");
    await errorCode(
      () => f.remote.hello("phone", enrolled.token, "desktop-a", 0),
      "revoked",
    );
  } finally {
    await f.close();
  }
});

test("only Host-authorized workspaces and their own threads can create, read and send", async () => {
  const f = await fixture();
  try {
    const token = (
      await f.remote.pair({
        hostId: "desktop-a",
        deviceId: "phone",
        code: f.remote.createPairingCode(),
      })
    ).token;
    const outside = await f.host.startThread({ cwd: f.b });
    assert.deepEqual(
      (await f.remote.workspaces("phone", token)).map((w) => w.id),
      ["a"],
    );
    await errorCode(
      () => f.remote.create("phone", token, "../other"),
      "wrong_workspace",
    );
    await errorCode(
      () => f.remote.resume("phone", token, "a", outside.id),
      "wrong_workspace",
    );
    await errorCode(
      () =>
        f.remote.send("phone", token, {
          workspaceId: "a",
          threadId: outside.id,
          clientId: "other",
          text: "wrong",
        }),
      "wrong_workspace",
    );
    const created = await f.remote.create("phone", token, "a");
    assert(!JSON.stringify(created).includes(f.a));
    assert.deepEqual(
      (await f.remote.threads("phone", token, "a")).map((t) => t.threadId),
      [created.id],
    );
  } finally {
    await f.close();
  }
});

test("two clients share one canonical thread; duplicate send ID is idempotent, conflicts and stale stop fail", async () => {
  const f = await fixture();
  try {
    const t1 = (
      await f.remote.pair({
        hostId: "desktop-a",
        deviceId: "one",
        code: f.remote.createPairingCode(),
      })
    ).token;
    const t2 = (
      await f.remote.pair({
        hostId: "desktop-a",
        deviceId: "two",
        code: f.remote.createPairingCode(),
      })
    ).token;
    const created = await f.remote.create("one", t1, "a");
    const before = await f.remote.resume("one", t1, "a", created.id);
    const first = await f.remote.send("one", t1, {
      workspaceId: "a",
      threadId: created.id,
      clientId: "same-id",
      text: "hello",
    });
    const duplicate = await f.remote.send("two", t2, {
      workspaceId: "a",
      threadId: created.id,
      clientId: "same-id",
      text: "hello",
    });
    assert.equal(duplicate.turnId, first.turnId);
    await errorCode(
      () =>
        f.remote.send("two", t2, {
          workspaceId: "a",
          threadId: created.id,
          clientId: "same-id",
          text: "different",
        }),
      "idempotency_conflict",
    );
    await errorCode(
      () => f.remote.interrupt("two", t2, "a", created.id, "wrong-turn"),
      "stale_turn",
    );
    const after = await f.remote.resume("two", t2, "a", created.id);
    assert.equal(
      after.thread.items.filter((item) => item.type === "user_message").length,
      1,
    );
    assert(after.watermark >= before.watermark);
    assert.equal(after.processEpoch, before.processEpoch);
    assert.equal(
      (await f.remote.hello("two", t2, "desktop-a", 0)).processEpoch,
      after.processEpoch,
    );
  } finally {
    await f.close();
  }
});

test("remote public projection excludes opaque provider content, tools and private configuration", () => {
  const base = {
    id: "i",
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-01-01T00:00:00Z",
  };
  assert.equal(
    projectRemoteItem({
      ...base,
      type: "reasoning",
      contentVisibility: "opaque",
      reasoningContent: "PRIVATE_PROVIDER_TOKEN",
      summary: "public-ish",
    }),
    null,
  );
  assert.equal(
    projectRemoteItem({
      ...base,
      type: "tool_result",
      toolCallId: "call",
      content: "PRIVATE_TOOL_OUTPUT",
      status: "completed",
    } as unknown as CanonicalItem),
    null,
  );
  assert.deepEqual(
    projectRemoteItem({
      ...base,
      type: "agent_message",
      text: "safe response",
    }),
    { ...base, type: "agent_message", text: "safe response" },
  );
});

test("pairing can authorize a strict workspace subset, denied even when globally configured", async () => {
  const f = await fixture();
  try {
    const token = (
      await f.remote.pair({
        hostId: "desktop-a",
        deviceId: "restricted",
        code: f.remote.createPairingCode([]),
      })
    ).token;
    assert.deepEqual(await f.remote.workspaces("restricted", token), []);
    await errorCode(
      () => f.remote.create("restricted", token, "a"),
      "wrong_workspace",
    );
  } finally {
    await f.close();
  }
});

test("remote start is confined to read-only approval-required threads, not existing full-access sessions", async () => {
  const f = await fixture();
  try {
    const token = (
      await f.remote.pair({
        hostId: "desktop-a",
        deviceId: "restricted",
        code: f.remote.createPairingCode(),
      })
    ).token;
    const existing = await f.host.startThread({
      cwd: f.a,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    await errorCode(
      () =>
        f.remote.send("restricted", token, {
          workspaceId: "a",
          threadId: existing.id,
          clientId: "never",
          text: "run tool",
        }),
      "operation_forbidden",
    );
    const created = await f.remote.create("restricted", token, "a");
    const actual = await f.host.readThread(created.id);
    assert.equal(actual.sandbox, "read-only");
    assert.equal(actual.approvalPolicy, "always");
  } finally {
    await f.close();
  }
});

test("resume over a deliberately secret-bearing trusted snapshot returns only public data", async () => {
  const f = await fixture();
  try {
    const token = (
      await f.remote.pair({
        hostId: "desktop-a",
        deviceId: "phone",
        code: f.remote.createPairingCode(),
      })
    ).token;
    const created = await f.remote.create("phone", token, "a");
    const original = f.host.readThread.bind(f.host);
    f.host.readThread = async (id) => {
      const snapshot = await original(id);
      if (id !== created.id) return snapshot;
      return {
        ...snapshot,
        providerProfileId: "PRIVATE_PROVIDER_KEY",
        items: [
          ...snapshot.items,
          {
            id: "opaque-id",
            threadId: id,
            turnId: "opaque-turn",
            createdAt: "2026-01-01T00:00:00Z",
            type: "reasoning",
            reasoningContent: "PRIVATE_PROVIDER_SECRET",
            contentVisibility: "opaque",
            summary: "PRIVATE_SUMMARY",
          },
        ] as typeof snapshot.items,
      };
    };
    const read = JSON.stringify(
      await f.remote.resume("phone", token, "a", created.id),
    );
    assert(!read.includes("PRIVATE_PROVIDER"));
    assert(!read.includes("PRIVATE_SUMMARY"));
    assert(!read.includes(f.a));
  } finally {
    await f.close();
  }
});

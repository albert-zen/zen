import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OpenCodeAgentProviderAdapter } from "../src/main/agent-providers/opencode-adapter.js";
import type { AgentProviderEvent } from "../src/main/agent-providers/types.js";

const SERVER = await readFile(
  new URL("./fixtures/opencode-app-server.mjs", import.meta.url),
  "utf8",
);

async function fixture(behavior = "normal", home?: string) {
  const directory =
    home ?? (await mkdtemp(path.join(os.tmpdir(), "opencode-adapter-")));
  const script = path.join(directory, "server.mjs");
  await writeFile(script, SERVER);
  const children: ReturnType<typeof spawn>[] = [];
  const spawnProcess = ((command: string, args: string[], options: object) => {
    assert.equal(command, "opencode");
    assert.deepEqual(args, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    const child = spawn(
      process.execPath,
      [script, directory, behavior, ...args],
      options,
    );
    children.push(child);
    return child;
  }) as typeof spawn;
  const adapter = new OpenCodeAgentProviderAdapter({
    spawnProcess,
    processCwd: directory,
    startupTimeoutMs: 5000,
    requestTimeoutMs: 1500,
  });
  const events: AgentProviderEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  return {
    adapter,
    directory,
    children,
    events,
    requests: async () =>
      (await readFile(path.join(directory, "requests.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              path: string;
              directory: string | null;
              body: Record<string, unknown>;
            },
        ),
  };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("Expected native event did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("OpenCode owns real model catalog, native session history, prompts, permissions, and interruption", async () => {
  const f = await fixture();
  try {
    const models = await f.adapter.models();
    assert.deepEqual(
      models.map((model) => model.id),
      ["test/model-one", "test/model-two"],
    );
    assert.equal(models[0]?.isDefault, true);
    assert.deepEqual(models[0]?.inputModalities, ["text", "image"]);
    const native = await f.adapter.create({
      cwd: f.directory,
      permissionMode: "danger-full-access",
    });
    assert.equal(native.nativeSessionId, "native-1");
    assert.equal(native.model, "test/model-one");
    assert.deepEqual(native.thread.turns, []);
    const create = (await f.requests()).find(
      (request) => request.method === "POST" && request.path === "/session",
    )!;
    assert.equal(create.directory, f.directory);
    // Omit session-level overrides: the native agent retains its configured allow/ask/deny policy.
    assert.equal(Object.hasOwn(create.body, "permission"), false);
    await f.adapter.send(native.nativeSessionId, {
      text: "Hello",
      model: "test/model-two",
    });
    await until(() => f.events.some((event) => event.type === "approval"));
    const approval = f.events.find((event) => event.type === "approval")!;
    assert.equal(approval.sessionId, "native-1");
    const snapshot = await f.adapter.read(native.nativeSessionId);
    assert.equal(
      snapshot.model,
      "test/model-two",
      "native message model overrides a stale native session default",
    );
    assert.equal(snapshot.thread.status.type, "active");
    assert.equal(snapshot.thread.turns[0]?.status, "inProgress");
    assert.equal(snapshot.thread.turns[0]?.items[1]?.type, "agentMessage");
    const streamed = snapshot.thread.turns[0]?.items[1];
    assert.equal(
      streamed?.type === "agentMessage" ? streamed.text : "",
      "Native streamed answer",
      "native transient deltas are visible before persistence",
    );
    const tool = snapshot.thread.turns[0]?.items.find(
      (item) => item.type === "commandExecution",
    );
    assert.equal(tool?.toolName, "bash");
    assert.deepEqual(tool?.toolArguments, { command: "pwd" });
    await assert.rejects(
      f.adapter.respondApproval("missing", "accept"),
      /Unknown/,
    );
    await f.adapter.respondApproval(
      approval.type === "approval" ? approval.requestId : "",
      "accept",
    );
    await until(() =>
      f.events.some((event) => event.type === "approvalResolved"),
    );
    const reply = (await f.requests()).find((request) =>
      request.path.endsWith("/reply"),
    )!;
    assert.deepEqual(reply.body, { reply: "once" });
    const completed = (await f.adapter.read(native.nativeSessionId)).thread
      .turns[0];
    assert.equal(completed?.status, "completed");
    assert.ok(
      completed?.durationMs !== null &&
        completed?.durationMs !== undefined &&
        completed.durationMs >= 0 &&
        completed.durationMs < 60000,
      "fixture timestamps describe this run, not an old epoch",
    );
    await f.adapter.send(native.nativeSessionId, {
      text: "Interrupt this native turn",
    });
    await f.adapter.interrupt(native.nativeSessionId);
    const interrupted = await f.adapter.read(native.nativeSessionId);
    assert.equal(interrupted.thread.turns.at(-1)?.status, "interrupted");
    assert.equal(interrupted.thread.turns[0]?.status, "completed");
    assert.equal(interrupted.thread.status.type, "idle");
    assert.equal(f.children.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      (await f.adapter.models()).length,
      2,
      "an idle SSE stream must outlive requestTimeoutMs",
    );
  } finally {
    await f.adapter.dispose();
  }
  assert.ok(
    f.children.every(
      (child) => child.exitCode !== null || child.signalCode !== null,
    ),
  );
  await assert.rejects(f.adapter.models(), /stopped/);
});

test("OpenCode restores native sessions and rereads authoritative history after Host restart", async () => {
  const first = await fixture();
  const native = await first.adapter.create({
    cwd: first.directory,
    permissionMode: "danger-full-access",
  });
  await first.adapter.send(native.nativeSessionId, {
    text: "Persisted prompt",
  });
  await first.adapter.dispose();
  const second = await fixture("normal", first.directory);
  try {
    const restored = await second.adapter.read(native.nativeSessionId);
    assert.equal(restored.thread.turns[0]?.items[0]?.type, "userMessage");
    assert.equal(restored.thread.turns[0]?.items[1]?.type, "agentMessage");
    await until(() => second.events.some((event) => event.type === "approval"));
    const disk = JSON.parse(
      await readFile(path.join(first.directory, "native.json"), "utf8"),
    );
    disk.history[native.nativeSessionId][1].parts[0].text =
      "Changed by native engine";
    await writeFile(
      path.join(first.directory, "native.json"),
      JSON.stringify(disk),
    );
    const updated = await second.adapter.read(native.nativeSessionId);
    const item = updated.thread.turns[0]?.items[1];
    assert.equal(
      item?.type === "agentMessage" ? item.text : "",
      "Changed by native engine",
    );
    await second.adapter.respondApproval("approval-0", "decline");
    assert.deepEqual(
      (await second.requests())
        .filter((request) => request.path.endsWith("/reply"))
        .at(-1)?.body,
      { reply: "reject" },
    );
  } finally {
    await second.adapter.dispose();
  }
});

test("OpenCode refuses unsupported sandboxes before launch and never substitutes a native model", async () => {
  const f = await fixture();
  try {
    for (const permissionMode of ["read-only", "workspace-write"] as const)
      await assert.rejects(
        f.adapter.create({ cwd: f.directory, permissionMode }),
        /no equivalent filesystem sandbox/,
      );
    assert.equal(f.children.length, 0);
    assert.deepEqual(f.adapter.capabilities.permissionModes, [
      "danger-full-access",
    ]);
    await assert.rejects(
      f.adapter.create({
        cwd: f.directory,
        permissionMode: "danger-full-access",
        model: "disconnected/m",
      }),
      /available OpenCode/,
    );
    assert.equal(
      (await f.requests()).filter((request) => request.method === "POST")
        .length,
      0,
    );
    await assert.rejects(f.adapter.read("unknown"), /HTTP 404/);
  } finally {
    await f.adapter.dispose();
  }
});

test("OpenCode binds only the owned loopback child, rejects incompatible protocols, and reaps failed startups", async () => {
  for (const behavior of [
    "bad-url",
    "bad-version",
    "bad-catalog",
    "no-ready",
  ]) {
    const f = await fixture(behavior);
    try {
      await assert.rejects(
        f.adapter.models(),
        behavior === "bad-url"
          ? /private Host-local/
          : behavior === "bad-version"
            ? /Unsupported OpenCode/
            : behavior === "bad-catalog"
              ? /Invalid OpenCode provider catalog/
              : /timed out/,
      );
    } finally {
      await f.adapter.dispose();
    }
    assert.ok(
      f.children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    );
  }
});

test("OpenCode reports unsupported structured questions and clears pending prompts on process loss", async () => {
  const f = await fixture("crash-after-prompt");
  try {
    const native = await f.adapter.create({
      cwd: f.directory,
      permissionMode: "danger-full-access",
    });
    await f.adapter.send(native.nativeSessionId, { text: "question" });
    await until(() =>
      f.events.some(
        (event) =>
          event.type === "error" &&
          event.message.includes("structured user input"),
      ),
    );
    await until(() =>
      f.events.some(
        (event) =>
          event.type === "error" && event.message.includes("Restart ZenX"),
      ),
    );
    assert.ok(
      f.events.some(
        (event) =>
          event.type === "approvalResolved" &&
          event.sessionId === native.nativeSessionId,
      ),
    );
    await assert.rejects(
      f.adapter.read(native.nativeSessionId),
      /Restart ZenX/,
    );
  } finally {
    await f.adapter.dispose();
  }
});

test(
  "OpenCode executable GUI fixture accepts the real CLI launch and persists only its native store",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "opencode-gui-fixture-"),
    );
    const old = process.env.OPENCODE_PEER_STATE_FILE;
    process.env.OPENCODE_PEER_STATE_FILE = path.join(directory, "peer.json");
    const adapter = new OpenCodeAgentProviderAdapter({
      executable: new URL("./fixtures/opencode-app-server.mjs", import.meta.url)
        .pathname,
      processCwd: directory,
    });
    try {
      const native = await adapter.create({
        cwd: directory,
        permissionMode: "danger-full-access",
      });
      assert.equal(native.nativeSessionId, "native-1");
      assert.ok(
        (await readFile(process.env.OPENCODE_PEER_STATE_FILE, "utf8")).includes(
          '"native-1"',
        ),
      );
      assert.deepEqual(
        JSON.parse(await readFile(path.join(directory, "launch.json"), "utf8")),
        ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      );
    } finally {
      await adapter.dispose();
      if (old === undefined) delete process.env.OPENCODE_PEER_STATE_FILE;
      else process.env.OPENCODE_PEER_STATE_FILE = old;
    }
  },
);

test("two Projects keep distinct native OpenCode models and defaults in one process", async () => {
  const f = await fixture("scoped-models");
  const a = path.join(f.directory, "project-a"),
    b = path.join(f.directory, "project-b");
  await Promise.all([mkdir(a), mkdir(b)]);
  try {
    assert.deepEqual(
      (await f.adapter.models(a)).map((model) => [model.id, model.isDefault]),
      [["test/model-one", true]],
    );
    assert.deepEqual(
      (await f.adapter.models(b)).map((model) => [model.id, model.isDefault]),
      [["test/model-two", true]],
    );
    const first = await f.adapter.create({
      cwd: a,
      permissionMode: "danger-full-access",
      model: "test/model-one",
    });
    const second = await f.adapter.create({
      cwd: b,
      permissionMode: "danger-full-access",
    });
    assert.equal(first.model, "test/model-one");
    assert.equal(second.model, "test/model-two");
    await assert.rejects(
      f.adapter.create({
        cwd: b,
        permissionMode: "danger-full-access",
        model: "test/model-one",
      }),
      /Select an available/,
    );
    await f.adapter.send(second.nativeSessionId, {
      text: "project scoped prompt",
      model: "test/model-two",
    });
    assert.equal(f.children.length, 1);
    const requests = await f.requests();
    assert.equal(
      requests.filter(
        (request) => request.path === "/session" && request.method === "POST",
      ).length,
      2,
    );
    assert.ok(
      requests
        .filter(
          (request) =>
            request.path === "/provider" || request.path === "/config",
        )
        .every((request) => request.directory === a || request.directory === b),
    );
  } finally {
    await f.adapter.dispose();
  }
});
test("stale native permission read must not revive replied approval", async () => {
  const f = await fixture("stale-permission");
  try {
    const native = await f.adapter.create({
      cwd: f.directory,
      permissionMode: "danger-full-access",
    });
    await f.adapter.send(native.nativeSessionId, {
      text: "test approval race",
    });
    await until(() => f.events.some((e) => e.type === "approval"));
    const a = f.events.find((e) => e.type === "approval")!;
    if (a.type !== "approval") throw Error("fixture");
    const oldRead = f.adapter.read(native.nativeSessionId);
    await until(() =>
      existsSync(path.join(f.directory, "permission-read-pending")),
    );
    await f.adapter.respondApproval(a.requestId, "accept");
    await writeFile(
      path.join(f.directory, "release-permission-read"),
      "release",
    );
    await oldRead;
    const approvals = f.events.filter(
      (e) => e.type === "approval" || e.type === "approvalResolved",
    );
    assert.equal(approvals.at(-1)?.type, "approvalResolved");
  } finally {
    await f.adapter.dispose();
  }
});

test("OpenCode Stop uses its exact known locator while transcript and permission reads fail", async () => {
  const f = await fixture();
  try {
    const native = await f.adapter.create({
      cwd: f.directory,
      permissionMode: "danger-full-access",
    });
    await f.adapter.send(native.nativeSessionId, { text: "work" });
    assert.equal(
      (await f.adapter.read(native.nativeSessionId)).thread.status.type,
      "active",
    );
    await writeFile(path.join(f.directory, "fail-history"), "yes");
    await writeFile(path.join(f.directory, "fail-permissions"), "yes");
    const before = (await f.requests()).length;
    await f.adapter.interrupt(native.nativeSessionId);
    assert.deepEqual((await f.requests()).slice(before), [
      {
        method: "POST",
        path: `/session/${native.nativeSessionId}/abort`,
        directory: f.directory,
        body: {},
      },
    ]);
  } finally {
    await f.adapter.dispose();
  }
});

test("restored OpenCode Stop reads only metadata and rejects foreign or unknown session identity", async () => {
  const first = await fixture();
  const native = await first.adapter.create({
    cwd: first.directory,
    permissionMode: "danger-full-access",
  });
  await first.adapter.send(native.nativeSessionId, { text: "work" });
  await first.adapter.dispose();
  await writeFile(path.join(first.directory, "fail-history"), "yes");
  await writeFile(path.join(first.directory, "fail-permissions"), "yes");
  const second = await fixture("normal", first.directory);
  try {
    await assert.rejects(second.adapter.interrupt(""), /Invalid/);
    assert.equal(
      second.children.length,
      0,
      "invalid IDs cannot launch a process",
    );
    await assert.rejects(second.adapter.interrupt("missing"), /HTTP 404/);
    const file = path.join(first.directory, "native.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.sessions[native.nativeSessionId].id = "foreign";
    await writeFile(file, JSON.stringify(state));
    await assert.rejects(
      second.adapter.interrupt(native.nativeSessionId),
      /different session/,
    );
    assert.equal(
      (await second.requests()).filter((r) => r.path.endsWith("/abort")).length,
      0,
    );
    state.sessions[native.nativeSessionId].id = native.nativeSessionId;
    await writeFile(file, JSON.stringify(state));
    const before = (await second.requests()).length;
    await second.adapter.interrupt(native.nativeSessionId);
    assert.deepEqual((await second.requests()).slice(before), [
      {
        method: "GET",
        path: `/session/${native.nativeSessionId}`,
        directory: null,
        body: {},
      },
      {
        method: "POST",
        path: `/session/${native.nativeSessionId}/abort`,
        directory: first.directory,
        body: {},
      },
    ]);
  } finally {
    await second.adapter.dispose();
  }
});

test("OpenCode abort acknowledgement is not a native completion receipt", async () => {
  const f = await fixture("abort-ack-only");
  try {
    const native = await f.adapter.create({
      cwd: f.directory,
      permissionMode: "danger-full-access",
    });
    await f.adapter.send(native.nativeSessionId, { text: "work" });
    await f.adapter.interrupt(native.nativeSessionId);
    assert.equal(
      (await f.adapter.read(native.nativeSessionId)).thread.status.type,
      "active",
    );
  } finally {
    await f.adapter.dispose();
  }
});

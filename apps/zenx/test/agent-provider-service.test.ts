import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentProviderService } from "../src/main/agent-providers/service.js";
import type { AgentProviderAdapter } from "../src/main/agent-providers/types.js";

function fixture() {
  let calls = 0;
  const adapter = {
    capabilities: {
      models: true,
      interrupt: true,
      resume: true,
      changeModel: true,
      approvals: true,
    },
    models: async () => [],
    create: async ({ cwd }: { cwd: string }) => ({
      nativeSessionId: "native-1",
      model: "test",
      thread: { id: "native-1", cwd, turns: [] },
    }),
    read: async () => {
      calls++;
      return {
        nativeSessionId: "native-1",
        model: "test",
        thread: { id: "native-1", cwd: "/workspace", turns: [] },
      };
    },
    send: async () => {},
    interrupt: async () => {},
    respondApproval: async () => {},
    onEvent: () => () => {},
    dispose: async () => {},
  } as unknown as AgentProviderAdapter;
  return { adapter, calls: () => calls };
}
test("provider bindings persist only locators and restore through the engine", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { adapter, calls } = fixture();
  const service = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
  );
  await service.save({ id: "codex-personal", kind: "codex", name: "Personal" });
  const created = await service.create({
    providerInstanceId: "codex-personal",
    cwd: "/workspace",
    model: "test",
    permissionMode: "read-only",
  });
  const disk = await readFile(path.join(dir, "agent-providers.json"), "utf8");
  assert.equal(disk.includes('"turns"'), false);
  const restored = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
  );
  assert.equal(
    (await restored.read(created.binding.id)).binding.nativeSessionId,
    "native-1",
  );
  assert.equal(calls(), 1);
  assert.equal((await restored.list())[0]?.kind, "zen");
});
test("bound instance identity cannot change and unknown IDs never fall back to Zen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { adapter } = fixture();
  const service = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
  );
  await service.save({ id: "codex-personal", kind: "codex", name: "Personal" });
  await service.create({
    providerInstanceId: "codex-personal",
    cwd: "/workspace",
    permissionMode: "read-only",
  });
  await assert.rejects(
    service.save({ id: "codex-personal", kind: "opencode", name: "Changed" }),
    /kind/,
  );
  await assert.rejects(service.read("missing"), /Unknown/);
  await service.save({ id: "codex-personal", kind: "codex", name: "Renamed" });
  assert.equal((await service.list())[1]?.name, "Renamed");
});
test("concurrent configuration writes retain both independent instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { adapter } = fixture();
  const service = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
  );
  await Promise.all([
    service.save({ id: "a", kind: "codex", name: "A" }),
    service.save({ id: "b", kind: "opencode", name: "B" }),
  ]);
  assert.deepEqual(
    (
      await new AgentProviderService(
        dir,
        () => adapter,
        async () => [],
      ).list()
    ).map((i) => i.id),
    ["zen", "a", "b"],
  );
});
test("catalog is instance-scoped, and an empty native catalog stays empty", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { adapter } = fixture();
  let zenCalls = 0;
  const service = new AgentProviderService(
    dir,
    () => adapter,
    async () => {
      zenCalls++;
      return [];
    },
  );
  await service.save({ id: "codex", kind: "codex", name: "Codex" });
  assert.deepEqual(await service.models("codex"), []);
  assert.equal(zenCalls, 0);
  await service.models("zen");
  assert.equal(zenCalls, 1);
  await assert.rejects(service.models("unknown"), /Unknown/);
});
test("invalid config input and stopped Host calls fail explicitly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { adapter } = fixture();
  const service = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
  );
  await assert.rejects(
    service.save({ id: "zen", kind: "codex", name: "Codex" }),
    /reserved/,
  );
  await assert.rejects(
    service.create({
      providerInstanceId: "codex",
      cwd: "relative",
      permissionMode: "read-only",
    }),
    /absolute/,
  );
  await service.save({ id: "codex", kind: "codex", name: "Codex" });
  await service.dispose();
  await assert.rejects(service.models("zen"), /stopped/);
});
test("approval IDs are bound to the exact engine session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { adapter } = fixture();
  let listener:
    | ((
        event: import("../src/main/agent-providers/types.js").AgentProviderEvent,
      ) => void)
    | undefined;
  let next = 0;
  let approved = 0;
  adapter.onEvent = (receive) => {
    listener = receive;
    return () => {};
  };
  adapter.create = async ({ cwd }) => ({
    nativeSessionId: `native-${++next}`,
    model: "test",
    thread: { id: `native-${next}`, cwd, turns: [] } as never,
  });
  adapter.respondApproval = async () => {
    approved++;
  };
  const service = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
  );
  await service.save({ id: "a", kind: "codex", name: "A" });
  const a = await service.create({
    providerInstanceId: "a",
    cwd: "/workspace",
    permissionMode: "read-only",
  });
  const b = await service.create({
    providerInstanceId: "a",
    cwd: "/workspace",
    permissionMode: "read-only",
  });
  listener?.({
    type: "approval",
    sessionId: "native-1",
    requestId: "ask-1",
    title: "Command",
    detail: "echo hi",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    service.respondApproval(b.binding.id, "ask-1", "accept"),
    /belong/,
  );
  await service.respondApproval(a.binding.id, "ask-1", "decline");
  assert.equal(approved, 1);
  await assert.rejects(
    service.respondApproval(a.binding.id, "ask-1", "accept"),
    /pending/,
  );
});
test("failed persistence leaves the current configuration unchanged", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { adapter } = fixture();
  const service = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
  );
  await service.list();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dir, "agent-providers.json"));
  await assert.rejects(
    service.save({ id: "codex", kind: "codex", name: "Codex" }),
  );
  assert.deepEqual(
    (await service.list()).map((i) => i.id),
    ["zen"],
  );
});
test("persisted bindings cannot silently move to another Host", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { adapter } = fixture();
  const service = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
    async () => "host-one",
  );
  await service.save({ id: "codex", kind: "codex", name: "Codex" });
  const other = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
    async () => "host-two",
  );
  await assert.rejects(other.list(), /another Host/);
});
test("an in-flight create fences executable replacement until its native binding is saved", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { adapter } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = adapter.create;
  adapter.create = async (input) => {
    await gate;
    return original(input);
  };
  const service = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
  );
  await service.save({ id: "codex", kind: "codex", name: "Codex" });
  const pending = service.create({
    providerInstanceId: "codex",
    cwd: "/workspace",
    permissionMode: "read-only",
  });
  await assert.rejects(
    service.save({
      id: "codex",
      kind: "codex",
      name: "Codex",
      executable: "another",
    }),
    /sessions/,
  );
  release();
  await pending;
  await assert.rejects(
    service.save({
      id: "codex",
      kind: "codex",
      name: "Codex",
      executable: "another",
    }),
    /sessions/,
  );
});
test("a corrupt store is reported instead of silently resetting instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dir, "agent-providers.json"), "not-json");
  const { adapter } = fixture();
  const service = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
  );
  await assert.rejects(service.list());
  await assert.rejects(
    service.save({ id: "codex", kind: "codex", name: "Codex" }),
  );
  assert.equal(
    await readFile(path.join(dir, "agent-providers.json"), "utf8"),
    "not-json",
  );
});
test("the Host routes a real child-process adapter through a namespaced locator", async (t) => {
  const { CodexAgentAdapter } =
    await import("../src/main/agent-providers/codex-adapter.js");
  const { fileURLToPath } = await import("node:url");
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const service = new AgentProviderService(
    dir,
    () =>
      new CodexAgentAdapter({
        binaryPath: process.execPath,
        args: [
          fileURLToPath(
            new URL("./fixtures/codex-app-server-peer.cjs", import.meta.url),
          ),
        ],
        env: { PEER_SCENARIO: "gui" },
      }),
    async () => [],
  );
  t.after(() => service.dispose());
  await service.save({ id: "codex", kind: "codex", name: "Codex" });
  assert.equal((await service.models("codex"))[0]?.id, "test-model");
  const created = await service.create({
    providerInstanceId: "codex",
    cwd: "/workspace/test",
    permissionMode: "read-only",
  });
  assert.notEqual(created.binding.id, created.binding.nativeSessionId);
  assert.equal(created.thread.id, created.binding.id);
  const events: string[] = [];
  service.onEvent((event) => {
    if (event.type === "changed") events.push(event.sessionId);
  });
  await service.send(created.binding.id, { text: "hello" });
  let read = await service.read(created.binding.id);
  const deadline = Date.now() + 2000;
  while (
    read.thread.turns.at(-1)?.status !== "completed" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    read = await service.read(created.binding.id);
  }
  assert.equal(read.thread.turns.at(-1)?.status, "completed");
  assert.ok(events.length > 0);
  assert.ok(events.every((id) => id === created.binding.id));
  assert.equal(read.thread.canonicalItems, undefined);
});
test("delayed Host configuration cannot create a process after disposal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const { adapter } = fixture();
  const setup = new AgentProviderService(
    dir,
    () => adapter,
    async () => [],
    async () => "host",
  );
  await setup.save({ id: "codex", kind: "codex", name: "Codex" });
  await setup.dispose();
  let release!: (value: string) => void;
  const identity = new Promise<string>((resolve) => {
    release = resolve;
  });
  let created = 0;
  const service = new AgentProviderService(
    dir,
    () => {
      created++;
      return adapter;
    },
    async () => [],
    () => identity,
  );
  const catalog = service.models("codex");
  await service.dispose();
  release("host");
  await assert.rejects(catalog, /stopped/);
  assert.equal(created, 0);
});
test("engine-wide errors retain source instance identity without mutating the native event", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const callbacks = new Map<
    string,
    (
      event: import("../src/main/agent-providers/types.js").AgentProviderEvent,
    ) => void
  >();
  const service = new AgentProviderService(
    dir,
    (instance) => {
      const { adapter } = fixture();
      adapter.onEvent = (listener) => {
        callbacks.set(instance.id, listener);
        return () => {};
      };
      return adapter;
    },
    async () => [],
  );
  await service.save({ id: "a", kind: "codex", name: "First" });
  await service.save({ id: "b", kind: "opencode", name: "Second" });
  await service.models("a");
  await service.models("b");
  const events: import("../src/main/agent-providers/types.js").AgentProviderEvent[] =
    [];
  service.onEvent((event) => events.push(event));
  const native = { type: "error" as const, message: "Process stopped" };
  callbacks.get("a")!(native);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    {
      type: "error",
      message: "First: Process stopped",
      providerInstanceId: "a",
    },
  ]);
  assert.deepEqual(native, { type: "error", message: "Process stopped" });
  await service.dispose();
});

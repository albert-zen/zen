import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillsService } from "../apps/cli/src/skills.js";
import { prepareSkillInput } from "../src/skill-input.js";
import { ZenAppServer } from "../src/app-server.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { JsonlThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  compileModelMessages,
  type ModelAdapter,
  type ModelMessage,
} from "../src/model.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";

test("import keeps resources after source removal, defaults to no metadata, explicit input replays", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-skills-"));
  try {
    const source = path.join(root, "source");
    await mkdir(path.join(source, "references"), { recursive: true });
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: sample\ndescription: Useful skill\n---\nUse references/guide.md\n",
    );
    await writeFile(
      path.join(source, "references/guide.md"),
      "Associated resource",
    );
    const service = new SkillsService(path.join(root, "host"));
    const imported = await service.importDirectory(source);
    await rm(source, { recursive: true });
    const snapshot = await service.list();
    assert.equal(snapshot.skills[0]!.mode, "manual");
    assert.equal(
      await readFile(
        path.join(imported.directory, "references/guide.md"),
        "utf8",
      ),
      "Associated resource",
    );
    assert.deepEqual(await service.prepare([{ type: "text", text: "hello" }]), [
      { type: "text", text: "hello" },
    ]);
    const request = [{ type: "skill" as const, id: imported.id }];
    const loaded = await service.prepare(request);
    assert.match(JSON.stringify(loaded), /Use references\/guide.md/);
    await service.setMode(imported.id, "disabled");
    await assert.rejects(service.prepare(request), /disabled/);
    assert.deepEqual(await prepareSkillInput(service, request, loaded), loaded);
    assert.equal(
      (await new SkillsService(path.join(root, "host")).list()).skills[0]!.mode,
      "disabled",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package policy, user overrides, same-name sources and catalog budget are explicit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-skills-policy-"));
  try {
    const source = path.join(root, "source");
    await mkdir(path.join(source, "agents"), { recursive: true });
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: sample\ndescription: >\n  Folded YAML\n  description\n---\nSECRET_BODY",
    );
    const policy = "policy:\n  model_visible: true\n";
    await writeFile(path.join(source, "agents/zen.yaml"), policy);
    const service = new SkillsService(path.join(root, "host"));
    const first = await service.importDirectory(source);
    const second = await service.importDirectory(source);
    assert.notEqual(first.id, second.id);
    assert.equal(first.mode, "auto");
    assert.equal(first.configurationSource, "package");
    const automatic = JSON.stringify(
      await service.prepare([{ type: "text", text: "hello" }]),
    );
    assert.match(automatic, /Folded YAML description/);
    assert.doesNotMatch(automatic, /SECRET_BODY/);
    await service.setMode(first.id, "manual");
    assert.equal((await service.list()).skills[0]!.configurationSource, "user");
    assert.equal(
      await readFile(path.join(source, "agents/zen.yaml"), "utf8"),
      policy,
    );
    assert.equal(
      await readFile(path.join(first.directory, "agents/zen.yaml"), "utf8"),
      policy,
    );
    await service.setMode(first.id, null);
    assert.equal((await service.list()).skills[0]!.mode, "auto");
    await writeFile(
      path.join(source, "SKILL.md"),
      `---\nname: sample\ndescription: ${"D".repeat(4000)}\n---\nbody`,
    );
    for (let count = 0; count < 5; count++)
      await service.importDirectory(source);
    await assert.rejects(
      service.prepare([{ type: "text", text: "hello" }]),
      /directory exceeds.*budget/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function serverFor(
  root: string,
  requests: ModelMessage[][],
  service: SkillsService,
  adapterOverride?: ModelAdapter,
) {
  const adapter: ModelAdapter = adapterOverride ?? {
    provider: "skills-test",
    async *stream(request) {
      requests.push(structuredClone(request.messages));
      yield { type: "text_delta", delta: "Acknowledged" };
    },
  };
  return new ZenAppServer({
    skills: service,
    journal: new JsonlThreadJournal(path.join(root, "journal")),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ runtimes: [] }),
    }),
    threadMetadata: new InMemoryThreadMetadataStore(),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: adapter.provider,
        adapter,
        modelCatalog: new StaticModelCatalog([
          { id: "fake", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd: root,
      providerProfileId: adapter.provider,
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

test("start retries reuse one running/completed canonical Turn across Skill changes and restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-skills-start-retry-"));
  const service = new SkillsService(path.join(root, "host"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const adapter: ModelAdapter = {
    provider: "skills-test",
    async *stream() {
      calls++;
      await gate;
      yield { type: "text_delta", delta: "done" };
    },
  };
  let first: Awaited<ReturnType<ZenAppServer["startTurn"]>> | undefined;
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: sample\ndescription: Test\n---\nORIGINAL_BODY",
    );
    const skill = await service.importDirectory(source);
    const server = serverFor(root, [], service, adapter);
    const thread = await server.startThread();
    const reference = [{ type: "skill" as const, id: skill.id }];
    first = await server.startTurn(thread.id, reference, {
      clientId: "retry-start",
    });
    const running = await server.startTurn(thread.id, reference, {
      clientId: "retry-start",
    });
    assert.equal(running.id, first.id);
    assert.equal(running.done, first.done);
    await writeFile(
      path.join(skill.directory, "SKILL.md"),
      "INVALID MODIFIED PACKAGE",
    );
    await service.setMode(skill.id, "disabled");
    const disabledRetry = await server.startTurn(thread.id, reference, {
      clientId: "retry-start",
    });
    assert.equal(disabledRetry.id, first.id);
    await assert.rejects(
      server.startTurn(thread.id, "different input", {
        clientId: "retry-start",
      }),
      { code: "idempotency_conflict" },
    );
    release();
    await first.done;
    const before = (await server.readThread(thread.id)).items;
    const completed = await server.startTurn(thread.id, reference, {
      clientId: "retry-start",
    });
    await completed.done;
    assert.equal(completed.id, first.id);
    assert.deepEqual((await server.readThread(thread.id)).items, before);
    const restored = serverFor(root, [], service, adapter);
    const replayed = await restored.startTurn(thread.id, reference, {
      clientId: "retry-start",
    });
    await replayed.done;
    assert.equal(replayed.id, first.id);
    assert.equal(calls, 1);
    assert.deepEqual((await restored.readThread(thread.id)).items, before);
    await assert.rejects(
      restored.startTurn(thread.id, [{ type: "skill", id: "different-id" }], {
        clientId: "retry-start",
      }),
      { code: "idempotency_conflict" },
    );
    await writeFile(
      path.join(skill.directory, "SKILL.md"),
      "---\nname: sample\ndescription: Test\n---\nUPDATED_BODY",
    );
    const independent1 = await restored.startTurn(thread.id, "ordinary send");
    await independent1.done;
    const independent2 = await restored.startTurn(thread.id, "ordinary send");
    await independent2.done;
    assert.notEqual(independent1.id, independent2.id);
    assert.equal(calls, 3);
  } finally {
    release();
    await first?.done;
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed start with the same client ID never appends or executes twice", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-completed-start-retry-"),
  );
  try {
    const requests: ModelMessage[][] = [];
    const server = serverFor(
      root,
      requests,
      new SkillsService(path.join(root, "host")),
    );
    const thread = await server.startThread();
    const first = await server.startTurn(thread.id, "perform once", {
      clientId: "same-request",
    });
    await first.done;
    const before = (await server.readThread(thread.id)).items;
    const retry = await server.startTurn(thread.id, "perform once", {
      clientId: "same-request",
    });
    await retry.done;
    assert.equal(requests.length, 1);
    assert.equal(retry.id, first.id);
    assert.deepEqual((await server.readThread(thread.id)).items, before);
    const projection = new NativeRecoveryProjection(server);
    const responses: unknown[] = [];
    const connection = new NativeConnection({
      appServer: server,
      projection,
      send: (message) => responses.push(message),
    });
    try {
      await connection.receive({
        id: "native-retry",
        method: "zen/turn/send",
        params: {
          threadId: thread.id,
          mode: "start",
          clientUserMessageId: "same-request",
          input: [{ type: "text", text: "perform once" }],
        },
      });
      assert.deepEqual(responses, [
        { id: "native-retry", result: { turnId: first.id } },
      ]);
      assert.equal(requests.length, 1);
      assert.deepEqual((await server.readThread(thread.id)).items, before);
    } finally {
      connection.close();
      projection.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queue, steer and replacement capture Skills at admission and reject stale turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-skills-admission-"));
  const service = new SkillsService(path.join(root, "host"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const adapter: ModelAdapter = {
    provider: "skills-test",
    async *stream(request) {
      if (++calls === 1)
        await Promise.race([
          gate,
          new Promise<never>((_, reject) =>
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            ),
          ),
        ]);
      yield { type: "text_delta", delta: "done" };
    },
  };
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: sample\ndescription: Test skill\n---\nCAPTURED_BODY",
    );
    const skill = await service.importDirectory(source);
    const server = serverFor(root, [], service, adapter);
    const thread = await server.startThread();
    const running = await server.startTurn(thread.id, "wait");
    const reference = [{ type: "skill" as const, id: skill.id }];
    await server.steerTurn(thread.id, running.id, reference, {
      clientId: "steered",
    });
    await server.queueMessage(thread.id, reference, "queued");
    const count = (await server.readThread(thread.id)).items.length;
    await assert.rejects(
      server.steerTurn(thread.id, "stale-turn", reference),
      /not running/,
    );
    assert.equal((await server.readThread(thread.id)).items.length, count);
    const replacement = await server.replaceTurn(
      thread.id,
      running.id,
      reference,
      { clientId: "replaced" },
    );
    await replacement.turn.done;
    release();
    await running.done;
    await service.setMode(skill.id, "disabled");
    await server.queueMessage(thread.id, reference, "queued"); // replay exact existing request
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (await server.readThread(thread.id)).items.filter(
          (item) => item.type === "turn_completed",
        ).length >= 2
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const items = (await server.readThread(thread.id)).items;
    for (const id of ["steered", "queued", "replaced"]) {
      const message = items.find(
        (item) => item.type === "user_message" && item.clientId === id,
      );
      assert.ok(message, id);
      assert.match(JSON.stringify(message), /CAPTURED_BODY/);
    }
    assert.equal(
      items.filter((item) => item.type === "user_message_queued").length,
      1,
    );
    await (
      await server.startTurn(thread.id, "admission fence")
    ).done;
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("ZAS native input, canonical restart and compaction use snapshots without reinjecting manual Skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-skills-runtime-"));
  const service = new SkillsService(path.join(root, "host"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: hidden-name\ndescription: hidden-description\n---\nORIGINAL_INSTRUCTIONS",
    );
    const skill = await service.importDirectory(source);
    const requests: ModelMessage[][] = [];
    const server = serverFor(root, requests, service);
    const thread = await server.startThread();
    await (
      await server.startTurn(thread.id, "hello")
    ).done;
    assert.doesNotMatch(
      JSON.stringify(requests),
      /hidden-name|hidden-description|ORIGINAL_INSTRUCTIONS/,
    );
    const projection = new NativeRecoveryProjection(server);
    const messages: unknown[] = [];
    const connection = new NativeConnection({
      appServer: server,
      projection,
      send: (message) => messages.push(message),
    });
    await connection.receive({
      id: "skill-send",
      method: "zen/turn/send",
      params: {
        threadId: thread.id,
        mode: "start",
        clientUserMessageId: "explicit",
        input: [{ type: "skill", id: skill.id }],
      },
    });
    assert(
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "result" in message,
      ),
    );
    for (
      let attempt = 0;
      attempt < 100 &&
      (await server.readThread(thread.id)).items.filter(
        (item) => item.type === "turn_completed",
      ).length < 2;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const before = await server.readThread(thread.id);
    assert.match(JSON.stringify(before.items), /ORIGINAL_INSTRUCTIONS/);
    assert.match(JSON.stringify(before.items), /skillSource/);
    await writeFile(
      path.join(skill.directory, "SKILL.md"),
      "---\nname: hidden-name\ndescription: hidden-description\n---\nCHANGED_INSTRUCTIONS",
    );
    await service.setMode(skill.id, "disabled");
    const restarted = serverFor(root, requests, service);
    const restored = await restarted.readThread(thread.id);
    assert.deepEqual(
      compileModelMessages(restored.items),
      compileModelMessages(before.items),
    );
    await (
      await restarted.startTurn(thread.id, "after restart")
    ).done;
    assert.match(JSON.stringify(requests.at(-1)), /ORIGINAL_INSTRUCTIONS/);
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)),
      /CHANGED_INSTRUCTIONS/,
    );
    await restarted.compactThread(thread.id);
    await (
      await restarted.startTurn(thread.id, "after compaction")
    ).done;
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1)),
      /CHANGED_INSTRUCTIONS/,
    );
    const count = (await restarted.readThread(thread.id)).items.length;
    await assert.rejects(
      restarted.startTurn(thread.id, [{ type: "skill", id: skill.id }]),
      /disabled/,
    );
    assert.equal((await restarted.readThread(thread.id)).items.length, count);
    connection.close();
    projection.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

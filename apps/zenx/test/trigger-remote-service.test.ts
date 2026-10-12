import assert from "node:assert/strict";
import test from "node:test";
import {
  ZenXTriggerService,
  type ZenXTriggerAppServerPort,
  type ZenXTriggerStorePort,
} from "../src/main/trigger-service.js";
import { canonicalTriggerSnapshot } from "../src/main/trigger-store.js";
import type {
  CreateTriggerInput,
  TriggerSnapshot,
} from "../src/main/trigger-types.js";
import type {
  ClientRequestParams,
  ServerNotificationMethod,
  ServerNotificationParams,
} from "../src/protocol-client/index.js";

type Subscribe = NonNullable<ZenXTriggerAppServerPort["subscribeRemoteThread"]>;
type Options = Parameters<Subscribe>[3];
interface Registration {
  device: string;
  workspace: string | undefined;
  threadId: string;
  options: Options;
  signal: AbortSignal;
  disposed: number;
}
class RemoteManager implements ZenXTriggerAppServerPort {
  registrations: Registration[] = [];
  queued: ClientRequestParams["turn/queue"][] = [];
  listener?: Parameters<ZenXTriggerAppServerPort["onNotification"]>[0];
  beforeReturn?: (registration: Registration) => Promise<void> | void;
  registrationError?: Error;
  sendError?: Error;
  async request(): Promise<never> {
    throw new Error("Unexpected turn/start");
  }
  async enqueue(input: ClientRequestParams["turn/queue"]): Promise<void> {
    this.queued.push(input);
    if (this.sendError) throw this.sendError;
  }
  onNotification(
    listener: Parameters<ZenXTriggerAppServerPort["onNotification"]>[0],
  ) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async subscribeRemoteThread(
    ...args: Parameters<Subscribe>
  ): Promise<() => void> {
    const [device, workspace, threadId, options, signal] = args;
    const registration = {
      device,
      workspace,
      threadId,
      options,
      signal,
      disposed: 0,
    };
    this.registrations.push(registration);
    await this.beforeReturn?.(registration);
    if (this.registrationError) throw this.registrationError;
    options.onReady?.();
    return () => {
      registration.disposed++;
    };
  }
  complete(
    registration: Registration,
    turnId: string,
    status: "completed" | "failed" | "interrupted" = "completed",
  ) {
    registration.options.onTurn({
      threadId: registration.threadId,
      turnId,
      status,
    });
  }
  local(threadId: string, turnId: string) {
    this.listener?.(
      "turn/completed" as ServerNotificationMethod,
      {
        threadId,
        turn: {
          id: turnId,
          status: "completed",
          error: null,
          items: [],
          itemsView: "full",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      } as ServerNotificationParams["turn/completed"],
    );
  }
}
function memoryStore() {
  let value: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  let gate: (() => Promise<void>) | undefined;
  return {
    read: async () => structuredClone(value),
    write: async (snapshot: TriggerSnapshot) => {
      const wait = gate;
      gate = undefined;
      await wait?.();
      value = canonicalTriggerSnapshot(snapshot);
    },
    saved: () => structuredClone(value),
    blockNext: (wait: () => Promise<void>) => {
      gate = wait;
    },
  } satisfies ZenXTriggerStorePort & {
    saved(): TriggerSnapshot;
    blockNext(wait: () => Promise<void>): void;
  };
}
const remoteInput = (
  overrides: Partial<Extract<CreateTriggerInput, { kind: "thread" }>> = {},
): Extract<CreateTriggerInput, { kind: "thread" }> => ({
  kind: "thread",
  threadId: "assistant-local",
  watchedThreadId: "same-source-id",
  label: "Remote result",
  prompt: "Read the exact remote result and reply to Room room-a",
  sourceDevice: "desktop-a",
  sourceWorkspace: "project-a",
  once: false,
  ...overrides,
});
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert(check(), "Expected Trigger state did not become visible");
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

test("remote completion keeps exact source namespace and never matches a same-ID local Thread", async () => {
  const manager = new RemoteManager();
  const service = new ZenXTriggerService(manager, memoryStore());
  await service.start();
  try {
    const watch = await service.create(remoteInput());
    manager.local("same-source-id", "turn-1");
    await settle();
    assert.equal(manager.queued.length, 0);
    const first = manager.registrations[0]!;
    first.options.onTurn({
      threadId: "different-source",
      turnId: "wrong-turn",
      status: "completed",
    });
    assert.match(
      service.snapshot().triggers[0]?.sourceError ?? "",
      /identity changed/u,
    );
    assert.equal(service.snapshot().history.length, 0);
    manager.complete(first, "turn-1", "failed");
    manager.complete(first, "turn-1", "failed");
    await until(() => service.snapshot().history[0]?.delivery === "queued");
    assert.equal(manager.queued.length, 1);
    const history = service.snapshot().history[0]!;
    assert.equal(history.threadId, "assistant-local");
    assert.equal(history.sourceDevice, "desktop-a");
    assert.equal(history.sourceWorkspace, "project-a");
    assert.equal(history.sourceThreadId, "same-source-id");
    assert.equal(history.sourceTurnId, "turn-1");
    assert.match(
      JSON.stringify(manager.queued[0]!.input),
      /Source device: desktop-a.*Source workspace: project-a.*Source Turn: turn-1.*Status: failed/su,
    );
    await service.update({
      ...remoteInput({ sourceDevice: "desktop-b" }),
      id: watch.id,
    });
    assert(first.signal.aborted);
    manager.complete(first, "stale");
    manager.complete(manager.registrations[1]!, "turn-1");
    await until(() => manager.queued.length === 2);
    await service.update({
      ...remoteInput({
        sourceDevice: "desktop-b",
        sourceWorkspace: "project-b",
      }),
      id: watch.id,
    });
    manager.complete(manager.registrations[2]!, "turn-1");
    await until(() => manager.queued.length === 3);
    assert.equal(
      new Set(
        service.snapshot().history.map((entry) => entry.clientUserMessageId),
      ).size,
      3,
    );
  } finally {
    await service.stop();
  }
});

test("synchronous registration recovery and duplicate live events consume a remote one-shot once", async () => {
  const manager = new RemoteManager();
  manager.beforeReturn = (registration) => {
    assert.equal(registration.options.includeCurrentTerminal, true);
    manager.complete(registration, "racing-terminal", "interrupted");
    manager.complete(registration, "racing-terminal", "interrupted");
  };
  const store = memoryStore();
  const service = new ZenXTriggerService(manager, store);
  await service.start();
  try {
    const watch = await service.create(
      remoteInput({ once: true, includeLatest: true }),
    );
    await until(() => service.snapshot().history[0]?.delivery === "queued");
    const registration = manager.registrations[0]!;
    assert.equal(service.snapshot().triggers[0]!.active, false);
    assert(registration.signal.aborted);
    assert.equal(registration.disposed, 1);
    manager.complete(registration, "later");
    await settle();
    assert.equal(manager.queued.length, 1);
    await service.stop();
    manager.beforeReturn = undefined;
    await service.start();
    assert.equal(manager.registrations.length, 1);
    assert.equal(
      service.snapshot().triggers.find((entry) => entry.id === watch.id)
        ?.active,
      false,
    );
    assert.equal(store.saved().history[0]?.sourceDevice, "desktop-a");
  } finally {
    await service.stop();
  }
});

test("offline source errors are visible and transient, preserve waiting, and clear after recovery", async () => {
  const manager = new RemoteManager();
  const store = memoryStore();
  const service = new ZenXTriggerService(manager, store);
  const changes: TriggerSnapshot[] = [];
  service.onChange((snapshot) => {
    changes.push(snapshot);
  });
  await service.start();
  try {
    const watch = await service.create(remoteInput({ once: true }));
    const registration = manager.registrations[0]!;
    registration.options.onError(
      new Error("Host disconnected; waiting to reconnect"),
    );
    assert.match(
      service.snapshot().triggers[0]?.sourceError ?? "",
      /disconnected/u,
    );
    assert.equal(service.snapshot().triggers[0]?.active, true);
    assert.equal(service.snapshot().history.length, 0);
    assert.equal(store.saved().triggers[0]?.sourceError, undefined);
    registration.options.onReady?.();
    assert.equal(service.snapshot().triggers[0]?.sourceError, undefined);
    assert(
      changes.some((snapshot) =>
        snapshot.triggers[0]?.sourceError?.includes("disconnected"),
      ),
    );
    manager.complete(registration, "observed-before-gap");
    manager.complete(registration, "observed-before-gap");
    await until(() => service.snapshot().history[0]?.delivery === "queued");
    assert.equal(manager.queued.length, 1);
    assert.equal(
      service.snapshot().triggers.find((entry) => entry.id === watch.id)
        ?.active,
      false,
    );
  } finally {
    await service.stop();
  }
});

test("initial source registration failure remains explicit without manufacturing a completion", async () => {
  const manager = new RemoteManager();
  manager.registrationError = new Error(
    "Fleet Host unpaired; observation stopped",
  );
  const service = new ZenXTriggerService(manager, memoryStore());
  await service.start();
  try {
    const watch = await service.create(remoteInput({ once: true }));
    assert.match(watch.sourceError ?? "", /unpaired/u);
    assert.equal(watch.active, true);
    assert.equal(service.snapshot().history.length, 0);
    manager.registrationError = undefined;
    await service.resume(watch.id, service.snapshot().triggers[0]!);
    await until(() => manager.registrations.length === 2);
    manager.complete(manager.registrations[1]!, "after-repair");
    await until(() => manager.queued.length === 1);
  } finally {
    await service.stop();
  }
});

test("a callback queued behind a definition save cannot wake the replacement definition", async () => {
  const manager = new RemoteManager();
  const store = memoryStore();
  const service = new ZenXTriggerService(manager, store);
  await service.start();
  try {
    const watch = await service.create(remoteInput());
    const old = manager.registrations[0]!;
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.blockNext(async () => {
      entered();
      await gate;
    });
    const update = service.update({
      ...remoteInput({ prompt: "Replacement prompt" }),
      id: watch.id,
    });
    await writing;
    manager.complete(old, "queued-old-event");
    release();
    await update;
    await settle();
    assert.equal(manager.queued.length, 0);
    assert.equal(old.disposed, 1);
    manager.complete(manager.registrations[1]!, "fresh-event");
    await until(() => manager.queued.length === 1);
    assert.match(
      JSON.stringify(manager.queued[0]!.input),
      /Replacement prompt/u,
    );
    await service.update({
      id: watch.id,
      kind: "signal",
      threadId: "assistant-local",
      label: "Signal",
      prompt: "Signal prompt",
      signalName: "ready",
    });
    manager.complete(manager.registrations[1]!, "after-kind-change");
    await settle();
    assert.equal(manager.queued.length, 1);
  } finally {
    await service.stop();
  }
});

test("cancel/delete/suspend/stop fence old subscriptions; restart never requests old terminal replay", async () => {
  const manager = new RemoteManager();
  const service = new ZenXTriggerService(manager, memoryStore());
  await service.start();
  try {
    const watch = await service.create(remoteInput());
    let old = manager.registrations.at(-1)!;
    await service.cancel(watch.id);
    assert(old.signal.aborted);
    manager.complete(old, "after-cancel");
    await service.resume(watch.id);
    old = manager.registrations.at(-1)!;
    service.suspendWakeups();
    assert(old.signal.aborted);
    manager.complete(old, "after-suspend");
    service.resumeWakeups();
    old = manager.registrations.at(-1)!;
    await service.stop();
    assert(old.signal.aborted);
    manager.complete(old, "after-stop");
    await service.start();
    old = manager.registrations.at(-1)!;
    assert(
      manager.registrations.every(
        (registration) => !registration.options.includeCurrentTerminal,
      ),
    );
    manager.complete(old, "live-turn");
    await until(() => manager.queued.length === 1);
    await service.stop();
    await service.start();
    manager.complete(manager.registrations.at(-1)!, "live-turn");
    await settle();
    assert.equal(manager.queued.length, 1);
    await service.delete(watch.id);
    manager.complete(manager.registrations.at(-1)!, "after-delete");
    await settle();
    assert.equal(manager.queued.length, 1);
    assert(
      manager.registrations.every(
        (registration) => registration.signal.aborted,
      ),
    );
  } finally {
    await service.stop();
  }
});

test("cancel while subscription setup is pending disposes its late result and ignores its callbacks", async () => {
  const manager = new RemoteManager();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  manager.beforeReturn = async () => {
    await gate;
  };
  const service = new ZenXTriggerService(manager, memoryStore());
  await service.start();
  try {
    const creating = service.create(remoteInput());
    await until(() => manager.registrations.length === 1);
    const id = service.snapshot().triggers[0]!.id;
    await service.cancel(id);
    const registration = manager.registrations[0]!;
    manager.complete(registration, "late-callback");
    release();
    const result = await creating;
    assert.equal(result.active, false);
    assert.equal(registration.disposed, 1);
    assert.equal(manager.queued.length, 0);
    assert.equal(service.snapshot().history.length, 0);
  } finally {
    release();
    await service.stop();
  }
});

test("remote failed delivery consumes a one-shot and is never retried", async () => {
  const manager = new RemoteManager();
  manager.sendError = new Error("Transport closed before acknowledgement");
  const service = new ZenXTriggerService(manager, memoryStore());
  await service.start();
  try {
    await service.create(remoteInput({ once: true }));
    manager.complete(manager.registrations[0]!, "complete-but-send-unknown");
    await until(() => service.snapshot().history[0]?.status === "failed");
    assert.equal(service.snapshot().history[0]?.delivery, "unknown");
    assert.equal(service.snapshot().triggers[0]?.active, false);
    await service.stop();
    await service.start();
    assert.equal(manager.registrations.length, 1);
    assert.equal(manager.queued.length, 1);
  } finally {
    await service.stop();
  }
});

test("explicit local source retains local behavior and remote workspace requires a device", async () => {
  const manager = new RemoteManager();
  const service = new ZenXTriggerService(manager, memoryStore());
  await service.start();
  try {
    await service.create(
      remoteInput({ sourceDevice: "local", sourceWorkspace: undefined }),
    );
    assert.equal(manager.registrations.length, 0);
    manager.local("same-source-id", "local-turn");
    await until(() => manager.queued.length === 1);
    await assert.rejects(
      service.create(remoteInput({ sourceDevice: undefined })),
      /requires a remote/u,
    );
  } finally {
    await service.stop();
  }
});

test("remote source resolution bypasses local names and exact result reads stay on the source device", async () => {
  const { ZenXBundledAutomationPluginService } =
    await import("../src/main/automation-plugin-service.js");
  const manager = new RemoteManager();
  const resolutions: unknown[][] = [];
  const reads: unknown[][] = [];
  let resolvedThreadId = "same-source-id";
  let resolvedWorkspace = "project-a";
  const port: ZenXTriggerAppServerPort = {
    request: () => manager.request(),
    enqueue: (params) => manager.enqueue(params),
    onNotification: (listener) => manager.onNotification(listener),
    subscribeRemoteThread: (...args) => manager.subscribeRemoteThread(...args),
    resolveRemoteThread: async (...args) => {
      resolutions.push(args);
      return { threadId: resolvedThreadId, workspace: resolvedWorkspace };
    },
    readRemoteThread: async (...args) => {
      reads.push(args);
      return {
        threadId: "same-source-id",
        turns: [
          {
            id: "exact-turn",
            status: "completed",
            preview: "Remote canonical public result",
          },
        ],
      };
    },
    readThread: async () => {
      throw new Error("Must not read same-ID local source");
    },
  };
  const service = new ZenXBundledAutomationPluginService(
    port,
    memoryStore(),
    new Set(),
    undefined,
    {
      projectProjection: { canonicalKeys: async (values) => values },
      request: async (_method, params) => ({
        data: params.archived
          ? []
          : [
              {
                id: "assistant-local",
                name: "Assistant",
                cwd: "/fixture",
                status: { type: "idle" },
              },
              {
                id: "same-source-id",
                name: "Different local source",
                cwd: "/fixture",
                status: { type: "idle" },
              },
            ],
        nextCursor: null,
      }),
    },
  );
  await service.startPlugin("zenx-triggers", {} as never);
  try {
    const watch = await service.create(
      remoteInput({
        threadId: "Assistant",
        watchedThreadId: "Remote title",
        sourceWorkspace: undefined,
      }),
    );
    assert.deepEqual(resolutions, [["desktop-a", undefined, "Remote title"]]);
    assert.equal(watch.threadId, "assistant-local");
    assert.deepEqual(watch.watch, {
      threadId: "same-source-id",
      event: "turn_completed",
      once: false,
      sourceDevice: "desktop-a",
      sourceWorkspace: "project-a",
    });
    manager.complete(manager.registrations[0]!, "exact-turn");
    await until(() => service.snapshot().history[0]?.delivery === "queued");
    const result = await service.result(service.snapshot().history[0]!.id);
    assert.deepEqual(reads, [
      ["desktop-a", "project-a", "same-source-id", "exact-turn"],
    ]);
    assert.equal(result.preview, "Remote canonical public result");
    assert.equal(result.sourceDevice, "desktop-a");
    await service.cancel(watch.id);
    await service.resume(watch.id);
    assert.deepEqual(resolutions[1], [
      "desktop-a",
      "project-a",
      "same-source-id",
    ]);
    await service.cancel(watch.id);
    resolvedThreadId = "replacement-source";
    await assert.rejects(service.resume(watch.id), /source identity changed/u);
    assert.equal(service.snapshot().triggers[0]?.active, false);
    resolvedThreadId = "same-source-id";
    resolvedWorkspace = "another-project";
    await assert.rejects(service.resume(watch.id), /source identity changed/u);
    assert.equal(service.snapshot().triggers[0]?.active, false);
  } finally {
    await service.stopPlugin("zenx-triggers");
  }
});

test("public Triggers schemas and listing preserve remote locators and visible source errors", async () => {
  const { ZenXTriggersCapabilityPackage } =
    await import("../src/main/capabilities/automation-control-package.js");
  const manager = new RemoteManager();
  const service = new ZenXTriggerService(manager, memoryStore());
  await service.start();
  const capability = new ZenXTriggersCapabilityPackage(service as never);
  const invoke = async (name: string, args: Record<string, unknown>) =>
    capability.invoke(name, {
      name,
      callId: name,
      threadId: "assistant-local",
      cwd: process.cwd(),
      arguments: args,
      signal: new AbortController().signal,
    });
  try {
    await invoke("zenx_triggers_create", {
      ...remoteInput(),
      threadId: undefined,
    });
    const registration = manager.registrations[0]!;
    registration.options.onError(
      new Error("Last source connection error: device is offline"),
    );
    const waiting = (await invoke("zenx_triggers_list", {})) as TriggerSnapshot;
    assert.equal(waiting.triggers[0]?.watch?.sourceDevice, "desktop-a");
    assert.equal(waiting.triggers[0]?.watch?.sourceWorkspace, "project-a");
    assert.match(waiting.triggers[0]?.sourceError ?? "", /offline/u);
    manager.complete(registration, "public-turn");
    await until(() => service.snapshot().history[0]?.delivery === "queued");
    const completed = (await invoke(
      "zenx_triggers_list",
      {},
    )) as TriggerSnapshot;
    assert.equal(completed.history[0]?.sourceDevice, "desktop-a");
    assert.equal(completed.history[0]?.sourceWorkspace, "project-a");
  } finally {
    await service.stop();
  }
});

test("suspend/resume fences a remote completion already queued behind a durable mutation", async () => {
  const manager = new RemoteManager();
  const store = memoryStore();
  const service = new ZenXTriggerService(manager, store);
  await service.start();
  try {
    await service.create(remoteInput());
    const old = manager.registrations[0]!;
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.blockNext(async () => {
      entered();
      await gate;
    });
    const mutation = service.create({
      threadId: "assistant-local",
      kind: "signal",
      label: "Unrelated",
      prompt: "Signal",
      signalName: "ready",
    });
    await writing;
    manager.complete(old, "queued-before-suspension");
    service.suspendWakeups();
    service.resumeWakeups();
    release();
    await mutation;
    await settle();
    assert.equal(manager.queued.length, 0);
    assert.equal(service.snapshot().history.length, 0);
    manager.complete(manager.registrations.at(-1)!, "new-live-completion");
    await until(() => manager.queued.length === 1);
  } finally {
    await service.stop();
  }
});

test("remote and timer continuations into an assistant Thread use next-cycle delivery and preserve explicit prompts", async () => {
  const manager = new RemoteManager();
  const sent: ClientRequestParams["turn/queue"][] = [];
  const callbacks: Array<() => void> = [];
  let now = 100;
  const port: ZenXTriggerAppServerPort = {
    request: () => manager.request(),
    enqueue: (params) => manager.enqueue(params),
    onNotification: (listener) => manager.onNotification(listener),
    subscribeRemoteThread: (...args) => manager.subscribeRemoteThread(...args),
    sendAssistant: async (params) => {
      sent.push(params);
      return { turnId: `assistant-turn-${sent.length}` };
    },
  };
  const service = new ZenXTriggerService(port, memoryStore(), {
    now: () => now,
    schedule: (callback) => {
      callbacks.push(callback);
      return callback;
    },
    cancelScheduled: () => {},
  });
  await service.start();
  try {
    const first = await service.createAssistantRoom({
      name: "First",
      members: [{ name: "Assistant", threadId: "assistant-local" }],
    });
    const second = await service.createAssistantRoom({
      name: "Second",
      members: [{ name: "Assistant", threadId: "assistant-local" }],
    });
    const prompt = `Read the native source and reply only to Room ${second.id}. Preserve this specific decision.`;
    await service.create(remoteInput({ once: true, prompt }));
    manager.complete(manager.registrations[0]!, "remote-result");
    await until(
      () =>
        sent.length === 1 &&
        service.snapshot().history[0]?.status === "running",
    );
    assert.equal(manager.queued.length, 0);
    const remoteText = JSON.stringify(sent[0]!.input);
    assert.match(remoteText, /Preserve this specific decision/u);
    assert.match(
      remoteText,
      new RegExp(
        `Associated assistant Room IDs: ${first.id}, ${second.id}`,
        "u",
      ),
    );
    assert.match(
      remoteText,
      /Honor the registered trigger prompt and its explicit destination/u,
    );
    assert.doesNotMatch(remoteText, /Current user message/u);
    assert.match(remoteText, /ongoing personal assistant/u);
    assert.equal(service.snapshot().history[0]?.delivery, undefined);
    manager.local("assistant-local", "assistant-turn-1");
    await until(() => service.snapshot().history[0]?.status === "completed");
    assert(
      service.snapshot().rooms.every((room) => room.messages.length === 0),
    );
    await service.create({
      kind: "timer",
      threadId: "assistant-local",
      label: "Timer continuation",
      prompt: "Recheck exactly this plan without inventing a new user request",
      runAt: 101,
    });
    now = 101;
    callbacks.at(-1)!();
    await until(() => sent.length === 2);
    assert.equal(manager.queued.length, 0);
    assert.match(JSON.stringify(sent[1]!.input), /Recheck exactly this plan/u);
    assert.doesNotMatch(
      JSON.stringify(sent[1]!.input),
      /Current user message/u,
    );
    assert(
      service.snapshot().rooms.every((room) => room.messages.length === 0),
    );
    await service.create(
      remoteInput({ threadId: "ordinary-thread", once: true }),
    );
    manager.complete(manager.registrations.at(-1)!, "ordinary-result");
    await until(() => manager.queued.length === 1);
    assert.equal(sent.length, 2);
    assert.doesNotMatch(
      JSON.stringify(manager.queued[0]!.input),
      /Always On Assistant context/u,
    );
  } finally {
    await service.stop();
  }
});

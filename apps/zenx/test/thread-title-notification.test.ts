import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { completedThreadTurn } from "../src/main/thread-completion-notification.js";
import { ZenXThreadTitleCoordinator } from "../src/main/thread-title-coordinator.js";
import {
  observeCompletedInputTitle,
  observeDiscoveredThreadTitle,
  observeThreadSnapshotTitle,
} from "../src/main/thread-title-notification.js";
import { ZenXThreadTitleStore } from "../src/main/thread-title-store.js";
import type { ThreadTitleInference } from "../src/main/thread-title-types.js";
import type { ServerNotificationParams } from "../src/protocol-client/index.js";
import {
  waitForTitleStage,
  waitForTitleStatus,
} from "./fixtures/thread-title-state.js";

test("an externally-originated completed userMessage starts staged naming once", async () => {
  await withCoordinator(async ({ titles, inference }) => {
    const notification = completedUserMessage(
      "thread-external",
      "Plan the cross-client release workflow",
    );
    await observeCompletedInputTitle(titles, "item/completed", notification);
    assert.equal(titles.snapshot()["thread-external"]?.status, "generating");
    assert.equal(inference.calls, 1);

    await observeCompletedInputTitle(titles, "item/completed", notification);
    assert.equal(inference.calls, 1);
    inference.resolve("Cross-client release workflow");
    await waitForTitleStatus(
      titles,
      "thread-external",
      "generated",
      "external user-message title generation",
    );
  });
});

test("a canonical duplicate cannot restart generation or overwrite a pre-observed manual title", async () => {
  await withCoordinator(async ({ titles, inference }) => {
    await titles.observe(
      "thread-preobserved",
      "Renderer input wins immediately",
    );
    await titles.rename("thread-preobserved", "Manual authority");

    await observeCompletedInputTitle(
      titles,
      "item/completed",
      completedUserMessage(
        "thread-preobserved",
        "Canonical copy of renderer input",
      ),
    );
    assert.equal(inference.calls, 1);
    assert.equal(titles.snapshot()["thread-preobserved"]?.status, "manual");
    inference.resolve("Late semantic title");
    await titles.stop();
    assert.equal(
      titles.snapshot()["thread-preobserved"]?.title,
      "Manual authority",
    );
  });
});

test("an App Server rename becomes authoritative over pending generation", async () => {
  await withCoordinator(async ({ titles, inference }) => {
    await titles.observe("thread-agent-renamed", "Original title source");
    await titles.synchronizeNativeName(
      "thread-agent-renamed",
      "Agent-managed name",
    );
    inference.resolve("Late generated name");
    await titles.stop();
    assert.deepEqual(titles.snapshot()["thread-agent-renamed"], {
      threadId: "thread-agent-renamed",
      title: "Agent-managed name",
      status: "manual",
      version: 3,
      source: "Original title source",
    });
  });
});

test("an App Server rename between generated commit and mirror restores native authority", async () => {
  await assertRenameWinsGenerationRace("after-generated-commit");
});

test("a later dispatch notification supersedes authority observed while that dispatch was in flight", async () => {
  await assertRenameWinsGenerationRace("during-generated-mirror");
});

test("observer bounds canonical text and logs failures without rejecting", async () => {
  const observed: string[] = [];
  const warnings: string[] = [];
  await observeCompletedInputTitle(
    {
      observe: async (_threadId, input) => {
        observed.push(input);
        throw new Error("metadata unavailable");
      },
    },
    "item/completed",
    completedUserMessage("thread-a", "x".repeat(3_000)),
    (message) => warnings.push(message),
  );
  assert.equal(observed[0]?.length, 2_000);
  assert.match(warnings[0] ?? "", /metadata unavailable/u);
});

test("discovery catches a first message committed before resume, without changing native names", async () => {
  const observed: string[] = [];
  const titles = {
    observe: async (_id: string, input: string) => {
      observed.push(input);
    },
  };
  const snapshot = {
    id: "im-race",
    name: null,
    turns: [
      {
        items: [
          completedUserMessage("im-race", "first canonical IM input").item,
        ],
      },
    ],
  } as unknown as import("../src/protocol-client/index.js").Thread;
  let reads = 0;
  await observeDiscoveredThreadTitle(
    async () => {
      reads++;
      await observeThreadSnapshotTitle(titles, {
        id: snapshot.id,
        items: [canonicalInput("user_message", "first canonical IM input")],
      } as unknown as import("../../../src/app-server.js").ThreadSnapshot);
    },
    { id: snapshot.id },
  );
  assert.equal(reads, 1);
  assert.deepEqual(observed, ["first canonical IM input"]);
  observed.length = 0;
  await observeThreadSnapshotTitle(titles, {
    ...snapshot,
    name: "User-owned native name",
  });
  assert.deepEqual(observed, []);
});

test("opening an unnamed existing IM thread stages its first meaningful canonical input", async () => {
  await withCoordinator(async ({ titles, inference }) => {
    const snapshot = {
      id: "im-existing",
      name: null,
      turns: [
        { items: [completedUserMessage("im-existing", " ").item] },
        {
          items: [
            completedUserMessage("im-existing", "Original QQ request").item,
          ],
        },
      ],
    } as unknown as import("../src/protocol-client/index.js").Thread;
    await observeThreadSnapshotTitle(titles, snapshot);
    assert.equal(
      titles.snapshot()["im-existing"]?.source,
      "Original QQ request",
    );
    await titles.rename("im-existing", "User title");
    await observeThreadSnapshotTitle(titles, snapshot);
    assert.equal(titles.snapshot()["im-existing"]?.title, "User title");
    assert.equal(inference.calls, 1);
    inference.resolve("Late title");
    await titles.stop();
  });
});

test("discovery failures are reported without breaking global notifications", async () => {
  const warnings: string[] = [];
  await observeDiscoveredThreadTitle(
    async () => {
      throw new Error("Thread unavailable");
    },
    { id: "gone" } as import("../src/protocol-client/index.js").Thread,
    (warning) => warnings.push(warning),
  );
  assert.match(warnings[0] ?? "", /Thread unavailable/);
});

function canonicalInput(
  type: "user_message" | "thread_message" | "host_message",
  text: string,
  id = "input-a",
): import("../../../src/item.js").DeliveredInputItem {
  const base = {
    id,
    threadId: "thread-external",
    turnId: "turn-a",
    clientId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  if (type === "host_message")
    return {
      ...base,
      type,
      sender: "host",
      source: "bootstrap",
      mode: "start",
      text,
    };
  const content = [{ type: "text" as const, text }];
  if (type === "user_message") return { ...base, type, content };
  return {
    ...base,
    type,
    mode: "batch-next",
    messageType: "follow_up",
    sender: { threadId: "source", toolCallId: "tool", callId: "call" },
    content,
  };
}

for (const type of [
  "user_message",
  "thread_message",
  "host_message",
] as const) {
  test(`${type} first native input stages once across live, snapshot and replay`, async () => {
    await withCoordinator(async ({ titles, inference }) => {
      const item = canonicalInput(type, "Plan a synthetic release");
      const event = {
        processEpoch: "epoch",
        threadId: item.threadId,
        watermark: 1,
        event: { type: "item_completed" as const, item },
      };
      const stages: string[] = [];
      titles.onChange((snapshot) =>
        stages.push(snapshot[item.threadId]!.status),
      );
      await Promise.all([
        observeCompletedInputTitle(titles, "zen/thread/event", event),
        observeCompletedInputTitle(titles, "zen/thread/event", event),
      ]);
      await observeThreadSnapshotTitle(titles, {
        id: item.threadId,
        items: [item],
      } as unknown as import("../../../src/app-server.js").ThreadSnapshot);
      assert.equal(inference.calls, 1);
      assert.deepEqual(stages, ["provisional", "generating"]);
      assert.equal(
        titles.snapshot()[item.threadId]?.source,
        "Plan a synthetic release",
      );
      inference.resolve("Release plan");
      await waitForTitleStatus(
        titles,
        item.threadId,
        "generated",
        "canonical input generation",
      );
      await titles.restart();
      await observeCompletedInputTitle(titles, "zen/thread/event", event);
      assert.equal(inference.calls, 1);
      assert.equal(titles.snapshot()[item.threadId]?.title, "Release plan");
    });
  });
}

test("canonical input order wins over compatibility turns and skips empty controls and metadata-only wakeups", async () => {
  const observed: string[] = [];
  const empty = canonicalInput(
    "host_message",
    "[ZenX trigger wakeup]\nTrigger ID: synthetic\nTask: ",
  );
  const first = canonicalInput("thread_message", "First Thread request");
  const snapshot = {
    id: first.threadId,
    name: null,
    canonicalItems: [
      {
        ...empty,
        type: "host_message_queued",
        input: [{ type: "text", text: "Not delivered" }],
      },
      { ...empty, type: "turn_started" },
      canonicalInput("user_message", " "),
      empty,
      first,
      canonicalInput("user_message", "Later human input"),
    ],
    turns: [
      {
        items: [
          completedUserMessage(first.threadId, "Lossy compatibility order")
            .item,
        ],
      },
    ],
  } as unknown as import("../src/protocol-client/index.js").Thread;
  const titles = {
    observe: async (_id: string, input: string) => {
      observed.push(input);
    },
  };
  await observeThreadSnapshotTitle(titles, snapshot);
  assert.deepEqual(observed, ["First Thread request"]);
  observed.length = 0;
  await observeThreadSnapshotTitle(titles, { ...snapshot, canonicalItems: [] });
  assert.deepEqual(observed, [], "an empty native snapshot is authoritative");
});

test("native snapshot names protect later input without replacing newer manual ownership", async () => {
  await withCoordinator(async ({ titles, inference }) => {
    const snapshot = {
      id: "thread-external",
      name: "Saved native title",
      items: [],
    } as unknown as import("../../../src/app-server.js").ThreadSnapshot;
    await observeThreadSnapshotTitle(titles, snapshot);
    await titles.observe("thread-external", "Later incoming Thread input");
    assert.equal(inference.calls, 0);
    assert.equal(
      titles.snapshot()["thread-external"]?.title,
      "Saved native title",
    );
    await titles.rename("thread-external", "New manual title");
    await observeThreadSnapshotTitle(titles, snapshot);
    assert.equal(
      titles.snapshot()["thread-external"]?.title,
      "New manual title",
    );
  });
});

function completedUserMessage(
  threadId: string,
  text: string,
): ServerNotificationParams["item/completed"] {
  return {
    threadId,
    turnId: "turn-a",
    item: {
      type: "userMessage",
      id: "message-a",
      clientId: "external-client-message",
      content: [{ type: "text", text, text_elements: [] }],
    },
    completedAtMs: 1,
  };
}

async function withCoordinator(
  run: (context: {
    titles: ZenXThreadTitleCoordinator;
    inference: ControlledInference;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-notification-"),
  );
  let titlesToClose: ZenXThreadTitleCoordinator | undefined;
  try {
    const inference = new ControlledInference();
    const titles = new ZenXThreadTitleCoordinator({
      store: new ZenXThreadTitleStore(path.join(directory, "titles.json")),
      inference,
      titleModel: () => "gpt-5.6-luna",
      setNativeName: async () => undefined,
    });
    titlesToClose = titles;
    await titles.initialize();
    await run({ titles, inference });
  } finally {
    await titlesToClose?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertRenameWinsGenerationRace(
  phase: "after-generated-commit" | "during-generated-mirror",
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-authority-race-"),
  );
  let titlesToClose: ZenXThreadTitleCoordinator | undefined;
  try {
    const inference = new ControlledInference();
    let nativeName = "";
    let synchronization: Promise<unknown> | undefined;
    const synchronizations: Promise<unknown>[] = [];
    const synchronizationStarted = signal();
    const secondSynchronizationStarted = signal();
    const trackSynchronization = (operation: Promise<unknown>): void => {
      synchronizations.push(operation);
      synchronizationStarted.resolve();
      if (synchronizations.length === 2) secondSynchronizationStarted.resolve();
    };
    let injected = false;
    let titles!: ZenXThreadTitleCoordinator;
    titles = new ZenXThreadTitleCoordinator({
      store: new ZenXThreadTitleStore(path.join(directory, "titles.json")),
      inference,
      titleModel: () => "gpt-5.6-luna",
      setNativeName: async (_threadId, title) => {
        if (
          phase === "during-generated-mirror" &&
          title === "Late generated" &&
          !injected
        ) {
          injected = true;
          nativeName = "Agent authority";
          synchronization = titles.synchronizeNativeName(
            "thread-race",
            "Agent authority",
          );
          trackSynchronization(synchronization);
          await synchronization;
        }
        nativeName = title;
        const mirrorNotification = titles.synchronizeNativeName(
          "thread-race",
          title,
        );
        trackSynchronization(mirrorNotification);
        await mirrorNotification;
      },
    });
    titlesToClose = titles;
    if (phase === "after-generated-commit") {
      titles.onChange((snapshot) => {
        if (snapshot["thread-race"]?.status !== "generated" || injected) return;
        injected = true;
        nativeName = "Agent authority";
        synchronization = titles.synchronizeNativeName(
          "thread-race",
          "Agent authority",
        );
        trackSynchronization(synchronization);
      });
    }
    await titles.initialize();
    await titles.observe("thread-race", "Original title source");
    inference.resolve("Late generated");
    await waitForTitleStage(
      synchronizationStarted.promise,
      `${phase} authority synchronization start`,
      () =>
        `tracked synchronizations=${String(
          synchronizations.length,
        )}; projection=${JSON.stringify(titles.snapshot()["thread-race"] ?? null)}`,
    );
    assert.notEqual(synchronization, undefined);
    await synchronization;
    if (phase === "during-generated-mirror")
      await waitForTitleStage(
        secondSynchronizationStarted.promise,
        "generated mirror reconciliation start",
        () =>
          `tracked synchronizations=${String(synchronizations.length)}; projection=${JSON.stringify(
            titles.snapshot()["thread-race"] ?? null,
          )}`,
      );
    for (let index = 0; index < synchronizations.length; index += 1)
      await synchronizations[index];
    assert.deepEqual(titles.snapshot()["thread-race"], {
      threadId: "thread-race",
      title:
        phase === "during-generated-mirror"
          ? "Late generated"
          : "Agent authority",
      status: "manual",
      version: phase === "during-generated-mirror" ? 5 : 4,
      source: "Original title source",
    });
    assert.equal(
      nativeName,
      phase === "during-generated-mirror"
        ? "Late generated"
        : "Agent authority",
    );
  } finally {
    await titlesToClose?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

class ControlledInference implements ThreadTitleInference {
  calls = 0;
  #pending:
    | {
        resolve(value: string): void;
        reject(error: Error): void;
      }
    | undefined;

  async generate(
    _input: string,
    _model: string,
    signal: AbortSignal,
  ): Promise<string> {
    this.calls += 1;
    return await new Promise<string>((resolve, reject) => {
      const abort = (): void => pending.reject(abortError(signal));
      const pending = {
        resolve: (value: string): void => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error: Error): void => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else this.#pending = pending;
    });
  }

  resolve(value: string): void {
    this.#pending?.resolve(value);
    this.#pending = undefined;
  }
}

function signal(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  let resolved = false;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolved) return;
      resolved = true;
      resolvePromise();
    },
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Title generation aborted", "AbortError");
}

test("native discovery preserves browser cleanup on completed, failed and interrupted turns", () => {
  for (const status of ["completed", "failed", "interrupted"] as const) {
    assert.deepEqual(
      completedThreadTurn("zen/thread/event", {
        processEpoch: "synthetic",
        threadId: "thread",
        watermark: 1,
        event: {
          type: "turn_completed",
          threadId: "thread",
          turnId: "turn",
          status,
        },
      }),
      { threadId: "thread", failed: status !== "completed" },
    );
    assert.deepEqual(
      completedThreadTurn("turn/completed", {
        threadId: "thread",
        turn: {
          id: "turn",
          status,
          items: [],
          itemsView: "full",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      }),
      { threadId: "thread", failed: status !== "completed" },
    );
  }
  assert.equal(
    completedThreadTurn("zen/thread/event", {
      processEpoch: "synthetic",
      threadId: "thread",
      watermark: 1,
      event: {
        type: "item_completed",
        item: canonicalInput("host_message", "First native input"),
      },
    }),
    undefined,
  );
});

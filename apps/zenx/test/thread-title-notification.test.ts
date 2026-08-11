import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXThreadTitleCoordinator } from "../src/main/thread-title-coordinator.js";
import { observeCompletedUserMessageTitle } from "../src/main/thread-title-notification.js";
import { ZenXThreadTitleStore } from "../src/main/thread-title-store.js";
import type { ThreadTitleInference } from "../src/main/thread-title-types.js";
import type { ServerNotificationParams } from "../src/protocol-client/index.js";

test("an externally-originated completed userMessage starts staged naming once", async () => {
  await withCoordinator(async ({ titles, inference }) => {
    const notification = completedUserMessage(
      "thread-external",
      "Plan the cross-client release workflow",
    );
    await observeCompletedUserMessageTitle(
      titles,
      "item/completed",
      notification,
    );
    assert.equal(titles.snapshot()["thread-external"]?.status, "generating");
    assert.equal(inference.calls, 1);

    await observeCompletedUserMessageTitle(
      titles,
      "item/completed",
      notification,
    );
    assert.equal(inference.calls, 1);
    inference.resolve("Cross-client release workflow");
    await waitForStatus(titles, "thread-external", "generated");
  });
});

test("a canonical duplicate cannot restart generation or overwrite a pre-observed manual title", async () => {
  await withCoordinator(async ({ titles, inference }) => {
    await titles.observe(
      "thread-preobserved",
      "Renderer input wins immediately",
    );
    await titles.rename("thread-preobserved", "Manual authority");

    await observeCompletedUserMessageTitle(
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
    await tick();
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
    await tick();
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

test("an App Server rename while generated mirror is in flight restores native authority", async () => {
  await assertRenameWinsGenerationRace("during-generated-mirror");
});

test("observer bounds canonical text and logs failures without rejecting", async () => {
  const observed: string[] = [];
  const warnings: string[] = [];
  await observeCompletedUserMessageTitle(
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
  try {
    const inference = new ControlledInference();
    const titles = new ZenXThreadTitleCoordinator({
      store: new ZenXThreadTitleStore(path.join(directory, "titles.json")),
      inference,
      titleModel: () => "gpt-5.6-luna",
      setNativeName: async () => undefined,
    });
    await titles.initialize();
    await run({ titles, inference });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertRenameWinsGenerationRace(
  phase: "after-generated-commit" | "during-generated-mirror",
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-title-authority-race-"),
  );
  try {
    const inference = new ControlledInference();
    let nativeName = "";
    let synchronization: Promise<unknown> | undefined;
    const synchronizations: Promise<unknown>[] = [];
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
          synchronizations.push(synchronization);
          await tick();
        }
        nativeName = title;
        synchronizations.push(
          titles.synchronizeNativeName("thread-race", title),
        );
      },
    });
    if (phase === "after-generated-commit") {
      titles.onChange((snapshot) => {
        if (snapshot["thread-race"]?.status !== "generated" || injected) return;
        injected = true;
        nativeName = "Agent authority";
        synchronization = titles.synchronizeNativeName(
          "thread-race",
          "Agent authority",
        );
        synchronizations.push(synchronization);
      });
    }
    await titles.initialize();
    await titles.observe("thread-race", "Original title source");
    inference.resolve("Late generated");
    for (
      let attempt = 0;
      attempt < 5_000 && synchronization === undefined;
      attempt += 1
    ) {
      await tick();
    }
    assert.notEqual(synchronization, undefined);
    await synchronization;
    assert.deepEqual(titles.snapshot()["thread-race"], {
      threadId: "thread-race",
      title: "Agent authority",
      status: "manual",
      version: 4,
      source: "Original title source",
    });
    assert.equal(nativeName, "Agent authority");
    for (let index = 0; index < synchronizations.length; index += 1)
      await synchronizations[index];
    await titles.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

class ControlledInference implements ThreadTitleInference {
  calls = 0;
  #resolve: ((value: string) => void) | undefined;

  async generate(): Promise<string> {
    this.calls += 1;
    return await new Promise<string>((resolve) => {
      this.#resolve = resolve;
    });
  }

  resolve(value: string): void {
    this.#resolve?.(value);
    this.#resolve = undefined;
  }
}

async function waitForStatus(
  titles: ZenXThreadTitleCoordinator,
  threadId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    if (titles.snapshot()[threadId]?.status === status) return;
    await tick();
  }
  assert.fail(`Timed out waiting for title status ${status}`);
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

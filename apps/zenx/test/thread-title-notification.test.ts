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

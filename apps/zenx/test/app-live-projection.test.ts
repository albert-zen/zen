import "./dom-primitives.js";
/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import type { ModelUsageProjection } from "../../../src/model-usage.js";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type {
  AppServerHostStatus,
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "../src/main/app-server-manager.js";
import type { ZenXThreadAttachmentProjection } from "../src/main/image-attachments.js";
import type {
  ServerNotificationMethod,
  ServerNotificationParams,
  Thread,
} from "../src/protocol-client/index.js";
import {
  runtimeCommand,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";
import { App } from "../src/renderer/src/App.js";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { pluginUiRegistry } from "../src/renderer/src/PluginProductPage.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { nativeRecoveryForThread } from "./native-recovery-fixture.js";
import { encodeModelKey } from "../../../src/protocol/codex/model-key.js";
const { act, createElement } = React;
Object.assign(globalThis, { React });

test("message Fork sends the exact native Item and opens only the new Thread without a Turn", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  let resolveFork!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    resolveFork = resolve;
  });
  const source = threadWithMessage("boundary");
  const copy = {
    ...threadWithMessage("forked answer"),
    id: "fork-1",
    name: "Renamed source · Fork",
  };
  const harness = await mountApp({
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "zen/thread/resume")
        return resumed(
          (params as { threadId: string }).threadId === "fork-1"
            ? copy
            : source,
        );
      if (method === "zen/thread/fork") return pending;
      throw new Error(`Unexpected request: ${method}`);
    },
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")!.click(),
    );
    const fork = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".message-fork"),
    );
    await act(async () => {
      fork.click();
      fork.click();
    });
    assert.deepEqual(
      requests.filter((request) => request.method === "zen/thread/fork"),
      [
        {
          method: "zen/thread/fork",
          params: {
            sourceThreadId: "thread-1",
            through: { type: "item", itemId: "agent-boundary" },
            workspace: { type: "same-directory" },
          },
        },
      ],
    );
    await act(async () =>
      resolveFork({ thread: nativeRecoveryForThread(copy).thread }),
    );
    assert.deepEqual(
      requests
        .filter((request) => request.method === "zen/thread/resume")
        .map((request) => request.params),
      [{ threadId: "thread-1" }, { threadId: "fork-1" }],
    );
    assert.equal(
      requests.some(
        (request) =>
          request.method.startsWith("turn/") ||
          request.method === "zen/turn/send",
      ),
      false,
    );
  } finally {
    await harness.unmount();
  }
});

test("late message Fork completion cannot replace newer navigation, including away and back", async () => {
  let resolveFork!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    resolveFork = resolve;
  });
  const requests: Array<{ method: string; params: unknown }> = [];
  const source = threadWithMessage("boundary");
  const harness = await mountApp({
    threads: async (archived) =>
      archived ? [] : [summary(), summary("thread-2", "Thread two")],
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "zen/thread/resume")
        return resumed(
          (params as { threadId: string }).threadId === "thread-1"
            ? source
            : thread("thread-2"),
        );
      if (method === "zen/thread/fork") return pending;
      throw new Error(`Unexpected request: ${method}`);
    },
  });
  try {
    const rows = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
    ];
    await act(async () => rows[0]!.click());
    const button = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".message-fork"),
    );
    await act(async () => button.click());
    await act(async () => rows[1]!.click());
    await act(async () => rows[0]!.click());
    // The new viewport must share the still-pending exact action, not create another copy.
    const remounted = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".message-fork"),
    );
    await act(async () => remounted.click());
    assert.equal(
      requests.filter((request) => request.method === "zen/thread/fork").length,
      1,
    );
    await act(async () =>
      resolveFork({ thread: nativeRecoveryForThread(thread("fork-1")).thread }),
    );
    assert.equal(
      requests.some(
        (request) =>
          request.method === "zen/thread/resume" &&
          (request.params as { threadId: string }).threadId === "fork-1",
      ),
      false,
    );
  } finally {
    await harness.unmount();
  }
});

test("message Fork exposes a stale-boundary failure and retries only after another explicit click", async () => {
  let attempts = 0;
  const methods: string[] = [];
  const harness = await mountApp({
    request: async (method) => {
      methods.push(method);
      if (method === "zen/thread/resume")
        return resumed(threadWithMessage("boundary"));
      if (method === "zen/thread/fork") {
        attempts++;
        throw new Error(
          "The selected completed agent message is unavailable in this Thread",
        );
      }
      throw new Error(`Unexpected request: ${method}`);
    },
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")!.click(),
    );
    const button = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".message-fork"),
    );
    await act(async () => button.click());
    assert.equal(attempts, 1);
    assert.equal(button.disabled, false);
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /selected completed agent message is unavailable/,
    );
    assert.equal(
      methods.filter((method) => method === "zen/thread/resume").length,
      1,
    );
    await act(async () => button.click());
    assert.equal(attempts, 2);
    assert.equal(
      methods.some(
        (method) => method.startsWith("turn/") || method === "zen/turn/send",
      ),
      false,
    );
  } finally {
    await harness.unmount();
  }
});

test("actual App navigation restores exact thread disclosures after loading remounts", async () => {
  const a = {
    ...thread(),
    turns: runtimeThread(
      [runtimeCommand("one"), runtimeCommand("two")],
      "completed",
    ).turns,
  };
  const b = { ...a, id: "thread-2" };
  const harness = await mountApp({
    threads: async (archived) =>
      archived ? [] : [summary(), summary("thread-2", "Thread two")],
    request: async (method, params) => {
      if (method === "zen/thread/resume")
        return resumed(
          (params as { threadId: string }).threadId === a.id ? a : b,
        );
      throw new Error(`Unexpected request: ${method}`);
    },
  });
  const click = async (selector: string) => {
    const button = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(selector),
    );
    await act(async () => button.click());
  };
  try {
    await click(".thread-row");
    await click(".turn-toggle");
    await click(".trace-toggle");
    await click(".trace-item-toggle");
    const selected = document.querySelector(".trace-detail");
    const rows = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
    ];
    assert.equal(rows.length, 2);
    await act(async () => rows[1]!.click());
    await waitFor(() => document.querySelector(".turn-toggle"));
    assert.equal(
      document.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      selected?.isConnected,
      false,
      "old transcript DOM is not cached",
    );
    await act(async () => rows[0]!.click());
    await waitFor(() => document.querySelector(".trace-item-toggle"));
    assert.equal(
      document.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      document.querySelector(".trace-toggle")?.getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      document
        .querySelector(".trace-item-toggle")
        ?.getAttribute("aria-expanded"),
      "true",
    );
  } finally {
    await harness.unmount();
  }
});

test("canonical image tool completion refreshes the visible attachment projection", async () => {
  let notify: NotificationListener | undefined;
  const image = {
    type: "attachment" as const,
    sha256: "a".repeat(64),
    mediaType: "image/png" as const,
    byteLength: 68,
    width: 1,
    height: 1,
  };
  let images: ZenXThreadAttachmentProjection = {};
  const harness = await mountApp({
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(thread());
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    attachments: async () => images,
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    await waitFor(() =>
      document.querySelector("#thread-browser-toggle:not(:disabled)"),
    );
    await act(async () => {
      notify?.(
        "zen/thread/event",
        nativeEvent(1, {
          type: "turn_started",
          threadId: "thread-1",
          turnId: "turn-1",
        }),
      );
      notify?.(
        "zen/thread/event",
        nativeEvent(2, {
          type: "item_completed",
          item: {
            id: "image-call",
            type: "tool_call",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: new Date(20_000).toISOString(),
            callId: "image-call-id",
            name: "view_image",
            arguments: { path: "/tmp/image.png" },
          },
        }),
      );
      images = { "image-call": [image] };
      notify?.(
        "zen/thread/event",
        nativeEvent(3, {
          type: "item_completed",
          item: {
            id: "image-result",
            type: "tool_result",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: new Date(21_000).toISOString(),
            callId: "image-call-id",
            output: "Viewed image",
            exitCode: 0,
            modelContent: [{ type: "image", attachment: image }],
          },
        }),
      );
    });
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".trace-item-toggle")?.click(),
    );
    await waitFor(() =>
      document.querySelector('[aria-label="Preview Tool image 1"]'),
    );
  } finally {
    await harness.unmount();
  }
});

test("thread exposes one working side panel instead of the legacy workspace drawer", async () => {
  const harness = await mountApp({
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(thread());
      throw new Error("Unexpected protocol request: " + method);
    },
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        "#thread-browser-toggle:not(:disabled)",
      ),
    );
    assert.equal(
      document.querySelectorAll(".app-shell > #thread-browser-toggle").length,
      1,
    );
    assert.equal(
      document.querySelector('[aria-label="Open workspace panel"]'),
      null,
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>("#thread-browser-toggle")!
        .click(),
    );
    assert.equal(
      document.querySelector(".auxiliary-panel")?.getAttribute("data-open"),
      "true",
    );
    assert.equal(document.querySelector(".workspace-drawer"), null);
    assert.equal(
      document.querySelector(".app-shell > #thread-browser-toggle"),
      null,
    );
    const close = document.querySelector<HTMLButtonElement>(
      ".auxiliary-close-button",
    )!;
    await act(async () => close.click());
    assert.equal(
      document.querySelector(".auxiliary-panel")?.getAttribute("data-open"),
      "false",
    );
    assert.ok(document.querySelector(".app-shell > #thread-browser-toggle"));
  } finally {
    await harness.unmount();
  }
});

test("resume commits canonical state before auxiliary reads and replays catch-up events", async () => {
  const resumeResponse = deferred<ReturnType<typeof resumed>>();
  const usage = deferred<ModelUsageProjection>();
  let notify: NotificationListener | undefined;
  const harness = await mountApp({
    request: async (method) => {
      if (method === "zen/thread/resume") return await resumeResponse.promise;
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    attachments: async () => {
      throw new Error("attachment projection unavailable");
    },
    usage: async () => await usage.promise,
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    assert.match(document.body.textContent ?? "", /Loading conversation/u);
    assert.ok(notify);

    await act(async () => {
      resumeResponse.resolve(resumed(thread()));
      notify?.(
        "zen/thread/event",
        nativeEvent(1, {
          type: "turn_started",
          threadId: "thread-1",
          turnId: "turn-1",
        }),
      );
      notify?.(
        "zen/thread/event",
        nativeEvent(2, {
          type: "item_completed",
          item: {
            id: "agent-catch-up",
            type: "agent_message",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: new Date(20_000).toISOString(),
            text: "Catch-up after resume",
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(document.body.textContent ?? "", /Catch-up after resume/u);
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /Loading conversation/u,
    );
    assert.match(document.body.textContent ?? "", /Catch-up after resume/u);
    assert.match(
      document.body.textContent ?? "",
      /attachment projection unavailable/u,
    );
    await act(async () => {
      usage.resolve({
        thread: { responseCount: 1, inputTokens: 7, outputTokens: 3 },
        turns: {},
        context: {
          inputTokens: 7,
          inputTokenSource: "provider",
          contextWindow: 70,
          ratio: 0.1,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    const contextUsage = document.querySelector<HTMLButtonElement>(
      ".context-usage-trigger",
    );
    assert.ok(contextUsage);
    assert.equal(
      contextUsage.getAttribute("aria-label"),
      "Open context details. Context 10% · 7 / 70 tokens\nThread cache unknown",
    );
  } finally {
    await harness.unmount();
  }
});

test("keeps an inactive Thread's streaming projection when returning to it", async () => {
  let notify: NotificationListener | undefined;
  const resumeCalls: string[] = [];
  const harness = await mountApp({
    request: async (method, params) => {
      if (method !== "zen/thread/resume")
        throw new Error(`Unexpected protocol request: ${method}`);
      const threadId = (params as { threadId: string }).threadId;
      resumeCalls.push(threadId);
      const priorThreadOneResumes = resumeCalls.filter(
        (candidate) => candidate === "thread-1",
      ).length;
      return threadId === "thread-1" && priorThreadOneResumes === 2
        ? nativeRecoveryForThread(streamingThread(), { watermark: 4 })
        : resumed(thread(threadId));
    },
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    threads: async (archived) =>
      archived
        ? []
        : [
            summary("thread-1", "Thread one"),
            summary("thread-2", "Thread two"),
          ],
  });
  try {
    const threadOne = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(".thread-row"),
      ).find((row) => row.textContent?.includes("Thread one")),
    );
    await act(async () => threadOne.click());
    await waitFor(() => resumeCalls.includes("thread-1"));
    assert.ok(notify);
    await act(async () => {
      notify?.(
        "zen/thread/event",
        nativeEvent(1, {
          type: "turn_started",
          threadId: "thread-1",
          turnId: "turn-1",
        }),
      );
      notify?.(
        "zen/thread/event",
        nativeEvent(2, {
          type: "item_started",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "streamed-item",
          itemType: "agent_message",
        }),
      );
      notify?.(
        "zen/thread/event",
        nativeEvent(3, {
          type: "item_delta",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "streamed-item",
          delta: "Initial stream",
        }),
      );
    });
    assert.match(document.body.textContent ?? "", /Initial stream/u);

    const threadTwo = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(".thread-row"),
      ).find((row) => row.textContent?.includes("Thread two")),
    );
    await act(async () => threadTwo.click());
    await waitFor(() => resumeCalls.includes("thread-2"));
    await act(async () => {
      notify?.(
        "zen/thread/event",
        nativeEvent(4, {
          type: "item_delta",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "streamed-item",
          delta: " continues while away",
        }),
      );
    });

    await act(async () => threadOne.click());
    await waitFor(
      () =>
        resumeCalls.filter((threadId) => threadId === "thread-1").length === 2,
    );
    assert.match(
      document.body.textContent ?? "",
      /Initial stream continues while away/u,
    );
    assert.equal(
      document.querySelector<HTMLElement>(".agent-copy")?.textContent,
      "Initial stream continues while away",
    );
  } finally {
    await harness.unmount();
  }
});

for (const recoveredEpoch of ["old-host", "new-host"] as const) {
  test(`disconnect invalidates a background cache before ${recoveredEpoch === "old-host" ? "same-epoch" : "new-epoch"} recovery`, async () => {
    let status: ((value: AppServerHostStatus) => void) | undefined;
    const backgroundRecovery = deferred<ReturnType<typeof resumed>>();
    const resumeCalls = new Map<string, number>();
    const harness = await mountApp({
      request: async (method, params) => {
        if (method !== "zen/thread/resume")
          throw new Error(`Unexpected protocol request: ${method}`);
        const threadId = (params as { threadId: string }).threadId;
        const call = (resumeCalls.get(threadId) ?? 0) + 1;
        resumeCalls.set(threadId, call);
        if (threadId === "thread-2" && call === 1) {
          return nativeRecoveryForThread(
            threadWithAgentMessage("thread-2", "Old partial", true),
            { processEpoch: "old-host", watermark: 3 },
          );
        }
        if (threadId === "thread-2") return await backgroundRecovery.promise;
        return nativeRecoveryForThread(thread("thread-1"), {
          processEpoch: recoveredEpoch,
        });
      },
      onStatus: (listener) => {
        status = listener;
        return () => {
          status = undefined;
        };
      },
      threads: async (archived) =>
        archived
          ? []
          : [
              summary("thread-1", "Thread one"),
              summary("thread-2", "Thread two"),
            ],
    });
    try {
      const row = (name: string) =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(".thread-row"),
        ).find((candidate) => candidate.textContent?.includes(name));
      await act(async () => row("Thread two")?.click());
      await waitFor(() =>
        (document.body.textContent ?? "").includes("Old partial"),
      );
      await act(async () => row("Thread one")?.click());
      await waitFor(() => resumeCalls.get("thread-1") === 1);
      assert.ok(status);
      await act(async () => {
        status?.({ type: "reconnecting", attempt: 1, delayMs: 0 });
        status?.({ type: "ready", reconnected: true });
        await Promise.resolve();
      });
      await waitFor(() => resumeCalls.get("thread-1") === 2);
      await act(async () => row("Thread two")?.click());
      await waitFor(() => resumeCalls.get("thread-2") === 2);
      assert.match(document.body.textContent ?? "", /Loading conversation/u);
      assert.doesNotMatch(document.body.textContent ?? "", /Old partial/u);

      await act(async () => {
        backgroundRecovery.resolve(
          nativeRecoveryForThread(
            threadWithAgentMessage("thread-2", "Completed while away", false),
            { processEpoch: recoveredEpoch, watermark: 8 },
          ),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.match(document.body.textContent ?? "", /Completed while away/u);
      assert.doesNotMatch(document.body.textContent ?? "", /Old partial/u);
    } finally {
      await harness.unmount();
    }
  });
}

test("failed ready approval snapshot drops stale cards and replays live requests", async () => {
  const nextSnapshot = deferred<ApprovalRequestEvent[]>();
  let snapshotCalls = 0;
  let status: ((value: AppServerHostStatus) => void) | undefined;
  let requestApproval: ((value: ApprovalRequestEvent) => void) | undefined;
  let resolveApproval: ((value: ApprovalResolvedEvent) => void) | undefined;
  const oldApproval = approval("old-ui-id", "old command");
  const newApproval = approval("new-ui-id", "new command");
  const resolvedApproval = approval("resolved-ui-id", "resolved command");
  const harness = await mountApp({
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(thread());
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    getPendingApprovals: async () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? [oldApproval] : await nextSnapshot.promise;
    },
    onStatus: (listener) => {
      status = listener;
      return () => {
        status = undefined;
      };
    },
    onApprovalRequest: (listener) => {
      requestApproval = listener;
      return () => {
        requestApproval = undefined;
      };
    },
    onApprovalResolved: (listener) => {
      resolveApproval = listener;
      return () => {
        resolveApproval = undefined;
      };
    },
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    await waitFor(() =>
      (document.body.textContent ?? "").includes("old command"),
    );
    assert.ok(status);
    assert.ok(requestApproval);
    assert.ok(resolveApproval);

    await act(async () => {
      status?.({ type: "reconnecting", attempt: 1, delayMs: 0 });
      status?.({ type: "ready", reconnected: true });
      requestApproval?.(newApproval);
      requestApproval?.(resolvedApproval);
      resolveApproval?.({
        requestId: resolvedApproval.requestId,
        threadId: resolvedApproval.params.threadId,
        decision: "cancel",
      });
      nextSnapshot.reject(new Error("snapshot unavailable"));
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.doesNotMatch(document.body.textContent ?? "", /old command/u);
    assert.match(document.body.textContent ?? "", /new command/u);
    assert.doesNotMatch(document.body.textContent ?? "", /resolved command/u);
    assert.match(document.body.textContent ?? "", /snapshot unavailable/u);
  } finally {
    await harness.unmount();
  }
});

test("a late resume response from the previous Host generation cannot replace the current snapshot", async () => {
  const responses = [
    deferred<ReturnType<typeof resumed>>(),
    deferred<ReturnType<typeof resumed>>(),
  ];
  let resumeCalls = 0;
  let status: ((value: AppServerHostStatus) => void) | undefined;
  const harness = await mountApp({
    request: async (method) => {
      if (method === "zen/thread/resume") {
        const response = responses[resumeCalls++];
        assert.ok(response);
        return await response.promise;
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    onStatus: (listener) => {
      status = listener;
      return () => {
        status = undefined;
      };
    },
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    assert.equal(resumeCalls, 1);
    assert.ok(status);
    await act(async () => {
      status?.({ type: "reconnecting", attempt: 1, delayMs: 0 });
      responses[0]!.resolve(resumed(threadWithMessage("stale generation")));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(document.body.textContent ?? "", /stale generation/u);

    await act(async () => {
      status?.({ type: "ready", reconnected: true });
      await Promise.resolve();
    });
    assert.equal(resumeCalls, 2);

    await act(async () => {
      responses[1]!.resolve(resumed(threadWithMessage("current generation")));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(document.body.textContent ?? "", /current generation/u);

    assert.match(document.body.textContent ?? "", /current generation/u);
    assert.doesNotMatch(document.body.textContent ?? "", /stale generation/u);
  } finally {
    await harness.unmount();
  }
});

test("a successor ready snapshot inherits live approval events when it fails", async () => {
  const snapshots = [
    deferred<ApprovalRequestEvent[]>(),
    deferred<ApprovalRequestEvent[]>(),
  ];
  let snapshotCalls = 0;
  let status: ((value: AppServerHostStatus) => void) | undefined;
  let requestApproval: ((value: ApprovalRequestEvent) => void) | undefined;
  let resolveApproval: ((value: ApprovalResolvedEvent) => void) | undefined;
  const live = approval("live-generation-id", "live command");
  const harness = await mountApp({
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(thread());
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    getPendingApprovals: async () => {
      const snapshot = snapshots[snapshotCalls++];
      assert.ok(snapshot);
      return await snapshot.promise;
    },
    onStatus: (listener) => {
      status = listener;
      return () => {
        status = undefined;
      };
    },
    onApprovalRequest: (listener) => {
      requestApproval = listener;
      return () => {
        requestApproval = undefined;
      };
    },
    onApprovalResolved: (listener) => {
      resolveApproval = listener;
      return () => {
        resolveApproval = undefined;
      };
    },
  });
  try {
    await waitFor(() => snapshotCalls === 1);
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    assert.ok(status);
    assert.ok(requestApproval);
    assert.ok(resolveApproval);

    await act(async () => {
      requestApproval?.(live);
      status?.({ type: "ready", reconnected: true });
      resolveApproval?.({
        requestId: "an-old-generation-ui-id",
        threadId: "thread-1",
        decision: "cancel",
      });
      snapshots[1]!.reject(new Error("successor snapshot failed"));
      snapshots[0]!.resolve([]);
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(document.body.textContent ?? "", /live command/u);
    assert.match(document.body.textContent ?? "", /successor snapshot failed/u);
  } finally {
    await harness.unmount();
  }
});

type NotificationListener = <M extends ServerNotificationMethod>(
  method: M,
  params: ServerNotificationParams[M],
) => void;

test("plugin query intent stays on its owned page and preserves the sidebar selection", async () => {
  const route = "/plugins/route-harness/home";
  const dispose = pluginUiRegistry.registerTrusted("route-harness-ui", {
    overview: ({ sdk }) =>
      createElement(
        "div",
        {},
        createElement(
          "p",
          { "data-testid": "plugin-route" },
          String(sdk.context.route),
        ),
        createElement(
          "button",
          {
            onClick: () =>
              sdk.navigation.navigate(`${route}?setup=room-reply&roomId=one`),
          },
          "Open setup intent",
        ),
      ),
  });
  const pluginSnapshot = {
    plugins: [
      {
        id: "route-harness",
        displayName: "Route harness",
        enabled: true,
        available: true,
        lifecycle: "enabled",
        contributionCount: 1,
        version: "1",
        source: "bundled",
      },
    ],
    pages: [
      {
        key: "route-harness:home",
        pluginId: "route-harness",
        id: "home",
        title: "Route harness",
        route,
        surfaceId: "overview",
      },
    ],
    sidebar: [
      {
        key: "route-harness:home",
        pluginId: "route-harness",
        id: "home",
        label: "Route harness",
        icon: "plug",
        pageId: "home",
      },
    ],
    bundles: [
      {
        key: "route-harness:main",
        pluginId: "route-harness",
        id: "main",
        apiVersion: 1,
        kind: "trusted",
        entry: "route-harness-ui",
      },
    ],
    surfaces: [
      {
        key: "route-harness:overview",
        pluginId: "route-harness",
        id: "overview",
        bundleId: "main",
        exportName: "overview",
      },
    ],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
  } as ZenXPluginSnapshot;
  const harness = await mountApp({
    request: async () => {
      throw Error("No Thread request expected");
    },
    pluginSnapshot,
  });
  try {
    const entry = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Route harness",
      ),
    );
    await act(async () => entry.click());
    const setup = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Open setup intent",
      ),
    );
    await act(async () => setup.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(
      document.querySelector('[data-testid="plugin-route"]')?.textContent,
      `${route}?setup=room-reply&roomId=one`,
    );
    assert.equal(entry.getAttribute("aria-current"), "page");
  } finally {
    await harness.unmount();
    dispose();
  }
});

test("Room title and real actions share App's header only on the exact Room route", async () => {
  const roomRoute = "/plugins/zenx-rooms/rooms";
  const otherRoute = "/plugins/zenx-rooms/rooms-preview";
  const rooms = ["a /?中", "b"].map((id, index) => ({
    id,
    name: `Team ${index + 1}`,
    members: [],
    messages: [],
    createdAt: 0,
  }));
  const calls: Array<{ pluginId: string; commandId: string }> = [];
  let navigate: ((route: string) => void) | undefined;
  const dispose = pluginUiRegistry.registerTrusted("room-header-test-ui", {
    overview: ({ sdk }) => {
      navigate = sdk.navigation.navigate;
      return createElement(RoomsPage, { sdk });
    },
  });
  const pluginSnapshot = {
    plugins: [
      {
        id: "zenx-rooms",
        displayName: "Rooms",
        enabled: true,
        available: true,
        lifecycle: "enabled",
        contributionCount: 1,
        version: "1",
        source: "bundled",
      },
    ],
    pages: [
      {
        key: "zenx-rooms:rooms",
        pluginId: "zenx-rooms",
        id: "rooms",
        title: "Rooms",
        route: roomRoute,
        surfaceId: "overview",
      },
    ],
    subroutes: [
      {
        key: "zenx-rooms:preview",
        pluginId: "zenx-rooms",
        id: "preview",
        title: "Preview",
        pageId: "rooms",
        route: otherRoute,
        surfaceId: "overview",
      },
    ],
    sidebar: [],
    bundles: [
      {
        key: "zenx-rooms:main",
        pluginId: "zenx-rooms",
        id: "main",
        apiVersion: 1,
        kind: "trusted",
        entry: "room-header-test-ui",
      },
    ],
    surfaces: [
      {
        key: "zenx-rooms:overview",
        pluginId: "zenx-rooms",
        id: "overview",
        bundleId: "main",
        exportName: "overview",
      },
    ],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
  } as ZenXPluginSnapshot;
  const harness = await mountApp({
    pluginSnapshot,
    request: async () => {
      throw Error("No Thread request expected");
    },
    executeCommand: async (pluginId, commandId) => {
      calls.push({ pluginId, commandId });
      if (pluginId === "zenx-rooms" && commandId === "list") return { rooms };
      throw Error(`Unexpected ${pluginId}/${commandId}`);
    },
  });
  let lastHost: HTMLElement | null = null;
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Open room Team 1"]',
      ),
    );
    await act(async () => row.click());
    const host = await waitFor(() =>
      document.querySelector<HTMLElement>(".room-title-actions-host"),
    );
    await waitFor(() => host.querySelectorAll("button").length === 3);
    const header = host.closest(".workspace-header")!;
    assert.equal(header.querySelector("h1")!.textContent, "Team 1");
    assert.equal(document.querySelectorAll(".workspace-header").length, 1);
    assert.equal(document.querySelector(".rooms-chat-header"), null);
    assert.equal(document.querySelector(".rooms-chat-status"), null);
    assert.equal(document.querySelector(".rooms-chat-list"), null);
    assert.equal(
      host.querySelector<HTMLElement>("#thread-browser-toggle")!.dataset.roomId,
      rooms[0]!.id,
    );
    assert.deepEqual(
      [...host.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      ),
      [
        "Rename conversation",
        "Open conversation workspace",
        "Conversation settings",
      ],
    );

    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Open room Team 2"]')!
        .click(),
    );
    assert.equal(
      document.querySelector(".workspace-header h1")!.textContent,
      "Team 2",
    );
    assert.equal(
      document.querySelector<HTMLElement>(
        ".room-title-actions-host #thread-browser-toggle",
      )!.dataset.roomId,
      "b",
    );
    assert.equal(document.querySelectorAll(".room-title-actions").length, 1);

    for (const route of [
      `${otherRoute}?roomId=b`,
      roomRoute,
      `${roomRoute}?create=room`,
    ]) {
      await act(async () => navigate!(route));
      assert.equal(
        document.querySelector(".room-title-actions-host"),
        null,
        route,
      );
      assert.equal(document.querySelector(".room-title-actions"), null, route);
      assert.equal(host.childElementCount, 0, "retired host is empty");
    }
    await act(async () => navigate!(`${roomRoute}?roomId=b`));
    lastHost = await waitFor(() =>
      document.querySelector<HTMLElement>(".room-title-actions-host"),
    );
    await waitFor(() => lastHost!.querySelectorAll("button").length === 3);
    assert.equal(
      document.querySelector(".workspace-header h1")!.textContent,
      "Team 2",
    );
    assert.ok(
      calls.length > 0 &&
        calls.every(
          (call) => call.pluginId === "zenx-rooms" && call.commandId === "list",
        ),
    );
  } finally {
    await harness.unmount();
    assert.equal(lastHost?.childElementCount ?? 0, 0);
    dispose();
  }
});

test("deletion invalidates a selected Thread's pending resume and does not reopen late history", async () => {
  let notify: NotificationListener | undefined;
  const pending = deferred<ReturnType<typeof resumed>>();
  let deleted = false;
  const harness = await mountApp({
    request: async (method) => {
      if (method === "zen/thread/resume") return await pending.promise;
      if (method === "zen/thread/deleted/list") return { data: [] };
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    threads: async (archived) => (deleted || archived ? [] : [summary()]),
    onNotification: (listener) => {
      notify = listener;
      return () => undefined;
    },
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    deleted = true;
    await act(async () =>
      notify?.(
        "zen/thread/event",
        nativeEvent(1, {
          type: "thread_deleted_updated",
          threadId: "thread-1",
          deleted: true,
        }),
      ),
    );
    await act(async () => pending.resolve(resumed(thread())));
    assert.equal(document.querySelector(".thread-row"), null);
    assert.equal(document.querySelector("#thread-browser-toggle"), null);
    assert.match(document.body.textContent ?? "", /Archived threads/u);
  } finally {
    await harness.unmount();
  }
});

test("App message requests survive acknowledgements, repeated clicks, and Thread remounts", async () => {
  const reads: string[] = [];
  const harness = await mountApp({
    request: async (method, params) => {
      if (method === "zen/thread/resume") {
        const id = (params as { threadId: string }).threadId;
        return resumed(
          threadWithAgentMessage(
            id,
            "[first](first.md) [second](second.md)",
            false,
          ),
        );
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    threads: async (archived) =>
      archived ? [] : [summary(), summary("thread-2", "Thread two")],
    readFile: async (threadId, path) => {
      reads.push(`${threadId}:${path}`);
      throw new Error("Expected unavailable fixture file");
    },
  });
  const selectThread = async (name: string) => {
    const row = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>(".thread-row")].find(
        (value) => value.textContent?.includes(name),
      ),
    );
    await act(async () => row.click());
    await waitFor(() => document.querySelector(".markdown-body a"));
  };
  const clickLink = async (index: number) =>
    act(async () =>
      document
        .querySelectorAll<HTMLAnchorElement>(".markdown-body a")
        [index]!.click(),
    );
  try {
    await selectThread("Thread one");
    await clickLink(0);
    await clickLink(1);
    await clickLink(1);
    assert.deepEqual(reads, [
      "thread-1:first.md",
      "thread-1:second.md",
      "thread-1:second.md",
    ]);
    await selectThread("Thread two");
    await selectThread("Thread one");
    assert.equal(reads.length, 3);
    await clickLink(0);
    assert.equal(reads.at(-1), "thread-1:first.md");
    assert.equal(reads.length, 4);
  } finally {
    await harness.unmount();
  }
});

interface MountOptions {
  readFile?(threadId: string, path: string): Promise<never>;
  pluginSnapshot?: ZenXPluginSnapshot;
  executeCommand?(
    pluginId: string,
    commandId: string,
    input?: unknown,
  ): Promise<unknown>;
  request(method: string, params?: unknown): Promise<unknown>;
  attachments?(threadId: string): Promise<ZenXThreadAttachmentProjection>;
  usage?(threadId: string): Promise<ModelUsageProjection>;
  threads?(archived: boolean): Promise<NativeThreadSummary[]>;
  getPendingApprovals?(): Promise<ApprovalRequestEvent[]>;
  onStatus?(listener: (value: AppServerHostStatus) => void): () => void;
  onNotification?(listener: NotificationListener): () => void;
  onApprovalRequest?(
    listener: (value: ApprovalRequestEvent) => void,
  ): () => void;
  onApprovalResolved?(
    listener: (value: ApprovalResolvedEvent) => void,
  ): () => void;
}

async function mountApp(options: MountOptions) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperties(dom.window.HTMLInputElement.prototype, {
    attachEvent: { value: () => undefined },
    detachEvent: { value: () => undefined },
  });
  const zenx = {
    workspaceFiles: { read: options.readFile },
    panels: { onOpen: () => () => undefined },
    platform: "darwin",
    protocol: {
      getStatus: async (): Promise<AppServerHostStatus> => ({
        type: "ready",
        reconnected: false,
      }),
      getPendingApprovals: async () =>
        options.getPendingApprovals === undefined
          ? []
          : await options.getPendingApprovals(),
      request: async (method: string, params?: unknown) => {
        if (method === "model/list")
          return { data: [model()], nextCursor: null };
        return await options.request(method, params);
      },
      respondToApproval: async () => undefined,
      onApprovalRequest: (listener: (value: ApprovalRequestEvent) => void) =>
        options.onApprovalRequest?.(listener) ?? (() => undefined),
      onApprovalResolved: (listener: (value: ApprovalResolvedEvent) => void) =>
        options.onApprovalResolved?.(listener) ?? (() => undefined),
      onStatus: (listener: (value: AppServerHostStatus) => void) =>
        options.onStatus?.(listener) ?? (() => undefined),
      onNotification: (listener: NotificationListener) =>
        options.onNotification?.(listener) ?? (() => undefined),
    },
    threads: {
      list: async ({ archived = false }: { archived?: boolean } = {}) =>
        options.threads === undefined
          ? archived
            ? []
            : [summary()]
          : await options.threads(archived),
    },
    imageAttachments: {
      pick: async () => [],
      import: async () => [],
      read: async () => new Uint8Array(),
      forThread: async (threadId: string) =>
        options.attachments === undefined
          ? {}
          : await options.attachments(threadId),
    },
    modelUsage: {
      forThread: async (threadId: string) =>
        options.usage === undefined
          ? {
              thread: { responseCount: 0, inputTokens: 0, outputTokens: 0 },
              turns: {},
              context: {
                inputTokens: null,
                inputTokenSource: null,
                contextWindow: null,
                ratio: null,
              },
            }
          : await options.usage(threadId),
    },
    projects: {
      get: async () => ({
        projects: [
          {
            key: "/work/zen",
            workspace: "/work/zen",
            configured: true,
            isDefault: true,
            threadIds: ["thread-1"],
          },
        ],
        unavailableThreadIds: [],
        lastUsedWorkspace: "/work/zen",
      }),
    },
    settings: {
      onManualCodeRequested: () => () => undefined,
      onChanged: () => () => undefined,
      get: async () => ({
        profile: {
          onboardingComplete: true,
          pinnedThreadIds: [],
          providerProfiles: [],
          defaultModel: { providerProfileId: "fake", modelId: "fake" },
          titleModel: { providerProfileId: "fake", modelId: "fake" },
          workspaces: [],
          workspace: "/work/zen",
        },
        subscription: { authenticated: false, expired: false },
        hasApiKey: false,
        apiKeyProviderProfileIds: [],
      }),
      markWorkspaceUsed: async () => ({
        profile: {
          onboardingComplete: true,
          pinnedThreadIds: [],
          providerProfiles: [],
        },
      }),
    },
    titles: {
      get: async () => ({}),
      onChange: () => () => undefined,
    },
    triggers: {
      get: async () => ({ triggers: [], history: [], rooms: [] }),
      onChange: () => () => undefined,
    },
    capabilities: {
      get: async () => ({ capabilities: [], audit: [], providers: [] }),
      onChange: () => () => undefined,
    },
    plugins: {
      executeCommand: async (
        pluginId: string,
        commandId: string,
        input?: unknown,
      ) => {
        if (options.executeCommand)
          return options.executeCommand(pluginId, commandId, input);
        throw Error(`Unexpected plugin command: ${pluginId}/${commandId}`);
      },
      get: async () =>
        options.pluginSnapshot ?? {
          plugins: [],
          sidebar: [],
          pages: [],
          surfaces: [],
          bundles: [],
        },
      onChange: () => () => undefined,
    },
  };
  Object.defineProperty(dom.window, "zenx", { value: zenx });
  dom.window.localStorage.setItem("zenx-sidebar-mode", "inbox");
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(App));
    await Promise.resolve();
  });
  return {
    unmount: async () => {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous, {
        IS_REACT_ACT_ENVIRONMENT: undefined,
      });
      dom.window.close();
    },
  };
}

function approval(requestId: string, command: string): ApprovalRequestEvent {
  return {
    requestId,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: `item-${requestId}`,
      startedAtMs: 10,
      environmentId: null,
      reason: null,
      command,
      cwd: "/work/zen",
      commandActions: [],
      proposedExecpolicyAmendment: null,
      networkApprovalContext: null,
      proposedNetworkPolicyAmendments: null,
    },
  };
}

function summary(
  threadId = "thread-1",
  name = "Thread one",
): NativeThreadSummary {
  return {
    threadId,
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd: "/work/zen",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    archived: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    name,
    preview: "",
    status: "idle",
  };
}

function thread(threadId = "thread-1"): Thread {
  return {
    id: threadId,
    sessionId: threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "fake",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/work/zen",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: threadId === "thread-1" ? "Thread one" : "Thread two",
    turns: [],
  };
}

function runningTurn(): Thread["turns"][number] {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
}

function threadWithMessage(text: string): Thread {
  return {
    ...thread(),
    turns: [
      {
        ...runningTurn(),
        status: "completed",
        completedAt: 20,
        durationMs: 10,
        items: [
          {
            id: `agent-${text}`,
            type: "agentMessage",
            text,
            phase: "final_answer",
            memoryCitation: null,
          },
        ],
      },
    ],
  };
}

function streamingThread(): Thread {
  return {
    ...thread("thread-1"),
    status: { type: "active", activeFlags: [] },
    turns: [
      {
        ...runningTurn(),
        items: [
          {
            id: "streamed-item",
            type: "agentMessage",
            text: "Initial stream continues while away",
            phase: "final_answer",
            memoryCitation: null,
          },
        ],
      },
    ],
  };
}

function threadWithAgentMessage(
  threadId: string,
  text: string,
  active: boolean,
): Thread {
  return {
    ...thread(threadId),
    status: active ? { type: "active", activeFlags: [] } : { type: "idle" },
    turns: [
      {
        ...runningTurn(),
        status: active ? "inProgress" : "completed",
        completedAt: active ? null : 20,
        durationMs: active ? null : 10,
        items: [
          {
            id: "background-agent",
            type: "agentMessage",
            text,
            phase: "final_answer",
            memoryCitation: null,
          },
        ],
      },
    ],
  };
}

function nativeEvent(
  watermark: number,
  event: ServerNotificationParams["zen/thread/event"]["event"],
): ServerNotificationParams["zen/thread/event"] {
  return {
    processEpoch: "test-process-epoch",
    threadId: "thread-1",
    watermark,
    event,
  };
}

function resumed(value: Thread) {
  return nativeRecoveryForThread(value);
}

function model() {
  const id = encodeModelKey({ providerProfileId: "fake", modelId: "fake" });
  return {
    id,
    model: "fake",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "Local demo",
    description: "Local demo",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "medium" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text" as const],
    supportsPersonality: false as const,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function waitFor<T>(read: () => T | null | undefined | false) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("Timed out waiting for renderer projection");
}

test("actual App cached navigation restores tall-Composer position", async () => {
  const a = {
    ...thread(),
    turns: runtimeThread([runtimeCommand("done")], "completed").turns,
  };
  const b = { ...a, id: "thread-2" };
  const harness = await mountApp({
    threads: async (archived) =>
      archived ? [] : [summary(), summary("thread-2", "Thread two")],
    request: async (method, params) => {
      if (method === "zen/thread/resume")
        return resumed(
          (params as { threadId: string }).threadId === a.id ? a : b,
        );
      throw new Error(`Unexpected request: ${method}`);
    },
  });
  const previous = globalThis.ResizeObserver;
  const callbacks = new Set<() => void>();
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe() {
      callbacks.add(this.callback);
    }
    disconnect() {
      callbacks.delete(this.callback);
    }
  } as unknown as typeof ResizeObserver;
  const resize = () => {
    for (const callback of callbacks) callback();
  };
  try {
    const tops = new WeakMap<HTMLElement, number>();
    const proto = window.HTMLElement.prototype;
    const originalRect = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function () {
      return this.classList.contains("bottom-zone")
        ? {
            ...originalRect.call(this),
            height: this.querySelector("textarea")?.value.includes("\n")
              ? 226
              : 126,
          }
        : originalRect.call(this);
    };
    Object.defineProperties(proto, {
      clientHeight: {
        configurable: true,
        get() {
          return 400;
        },
      },
      scrollHeight: {
        configurable: true,
        get() {
          const inset =
            Number.parseFloat(
              this.closest(".thread-view")?.style.getPropertyValue(
                "--bottom-zone-height",
              ) ?? "0",
            ) || 0;
          return 1287 + Math.max(0, inset + 24 - 38);
        },
      },
      scrollTop: {
        configurable: true,
        get() {
          return Math.min(tops.get(this) ?? 0, this.scrollHeight - 400);
        },
        set(value: number) {
          tops.set(this, Math.max(0, Math.min(this.scrollHeight - 400, value)));
        },
      },
    });

    const rows = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
    ];
    assert.equal(rows.length, 2);
    const choose = async (index: number) => {
      await act(async () => rows[index]!.click());
      await waitFor(() => document.querySelector(".messages"));
      await act(async () => resize());
    };
    const scroll = () => document.querySelector<HTMLElement>(".messages")!;
    // Warm both exact native projection caches before testing same-view switching.
    await choose(0);
    await choose(1);
    const reused = scroll();
    await choose(0);
    assert.equal(
      scroll(),
      reused,
      "actual cached App navigation reuses ThreadView",
    );
    const textarea =
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!;
    const key = Object.getOwnPropertyNames(textarea).find((key) =>
      key.startsWith("__reactProps$"),
    )!;
    await act(async () => {
      (
        textarea as unknown as Record<
          string,
          { onChange(event: { target: { value: string } }): void }
        >
      )[key]!.onChange({
        target: {
          value: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine",
        },
      });
    });
    await act(async () => {
      resize();
      scroll().dispatchEvent(
        new window.WheelEvent("wheel", { deltaY: -75, bubbles: true }),
      );
      scroll().scrollTop = 1024;
      scroll().dispatchEvent(new window.Event("scroll"));
    });
    assert.equal(scroll().scrollTop, 1024);
    await choose(1);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!.value,
      "",
    );
    await choose(0);
    assert.equal(
      scroll(),
      reused,
      "test exercised cached navigation, not a loader remount",
    );
    assert.equal(scroll().scrollHeight - scroll().clientHeight, 1099);
    assert.equal(
      scroll().scrollTop,
      1024,
      "actual App cached A must restore after its own Composer inset",
    );
    // New manual input replaces the restored target, including subsequent
    // observer delivery and further cached A/B/A navigation.
    await act(async () => {
      scroll().dispatchEvent(
        new window.WheelEvent("wheel", { deltaY: -75, bubbles: true }),
      );
      scroll().scrollTop = 947;
      scroll().dispatchEvent(new window.Event("scroll"));
      resize();
    });
    assert.equal(scroll().scrollTop, 947);
    await choose(1);
    await choose(0);
    assert.equal(scroll(), reused);
    assert.equal(scroll().scrollTop, 947);
    assert.ok(document.querySelector(".back-live"));
  } finally {
    globalThis.ResizeObserver = previous;
    await harness.unmount();
  }
});

for (const interaction of ["none", "manual", "navigate"] as const) {
  test(`actual App retains canonical image geometry through late media refresh and ${interaction} intent`, async () => {
    const user = {
      type: "userMessage" as const,
      id: "image-user",
      clientId: null,
      content: [
        {
          type: "text" as const,
          text: "Inspect this screenshot.",
          text_elements: [] as [],
        },
      ],
    };
    const a = {
      ...thread(),
      turns: runtimeThread([user, runtimeCommand("done")], "completed").turns,
    };
    const b = { ...a, id: "thread-2" };
    const image = {
      type: "attachment" as const,
      sha256: "a".repeat(64),
      mediaType: "image/png" as const,
      byteLength: 68,
      width: 120,
      height: 90,
    };
    const projection = { "image-user": [image] };
    const late = deferred<ZenXThreadAttachmentProjection>();
    let attachmentLoads = 0;
    let imageStillCurrent = true;
    const harness = await mountApp({
      threads: async (archived) =>
        archived ? [] : [summary(), summary("thread-2", "Thread two")],
      request: async (method, params) => {
        if (method === "zen/thread/resume") {
          const selected =
            (params as { threadId: string }).threadId === a.id ? a : b;
          const snapshot = resumed(selected);
          if (selected.id === a.id && imageStillCurrent) {
            // Use a real multimodal canonical user message, matching the separate
            // read-only attachment projection returned by the Host service.
            for (const item of snapshot.thread.items) {
              if (item.type === "user_message" && item.id === user.id) {
                delete item.text;
                Object.assign(item, {
                  content: [
                    { type: "text", text: "Inspect this screenshot." },
                    { type: "image", attachment: image },
                  ],
                });
              }
            }
          }
          return snapshot;
        }
        throw new Error(`Unexpected request: ${method}`);
      },
      attachments: async (id) =>
        id !== a.id
          ? {}
          : ++attachmentLoads < 3
            ? projection
            : await late.promise,
    });
    const previous = globalThis.ResizeObserver;
    const callbacks = new Set<() => void>();
    globalThis.ResizeObserver = class {
      constructor(private callback: () => void) {}
      observe() {
        callbacks.add(this.callback);
      }
      disconnect() {
        callbacks.delete(this.callback);
      }
    } as unknown as typeof ResizeObserver;
    const resize = () => {
      for (const callback of callbacks) callback();
    };
    try {
      const tops = new WeakMap<HTMLElement, number>();
      const proto = window.HTMLElement.prototype;
      Object.defineProperties(proto, {
        clientHeight: {
          configurable: true,
          get() {
            return this.classList.contains("messages") ? 400 : 0;
          },
        },
        scrollHeight: {
          configurable: true,
          get() {
            if (!this.classList.contains("messages")) return 0;
            // Real image row geometry: 120px thumbnail at 4:3 plus 6px margin.
            return 1000 + (this.querySelector(".message-images") ? 96 : 0);
          },
        },
        scrollTop: {
          configurable: true,
          get() {
            return this.classList.contains("messages")
              ? Math.min(tops.get(this) ?? 0, this.scrollHeight - 400)
              : 0;
          },
          set(value: number) {
            if (this.classList.contains("messages"))
              tops.set(
                this,
                Math.max(0, Math.min(this.scrollHeight - 400, value)),
              );
          },
        },
      });
      const rows = [
        ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
      ];
      const choose = async (i: number) => {
        await act(async () => rows[i]!.click());
        await waitFor(() => document.querySelector(".messages"));
        await act(async () => resize());
      };
      const scroll = () => document.querySelector<HTMLElement>(".messages")!;
      await choose(0);
      await waitFor(() => document.querySelector(".message-images"));
      await choose(1);
      const reused = scroll();
      await choose(0);
      assert.equal(scroll(), reused);
      await waitFor(() => document.querySelector(".message-images"));
      assert.equal(attachmentLoads, 2);
      await act(async () => {
        scroll().dispatchEvent(
          new window.WheelEvent("wheel", { deltaY: -46, bubbles: true }),
        );
        scroll().scrollTop = 650;
        scroll().dispatchEvent(new window.Event("scroll"));
      });
      assert.equal(scroll().scrollTop, 650);
      assert.equal(scroll().scrollHeight - scroll().clientHeight, 696);
      await choose(1);
      await choose(0);
      assert.equal(
        scroll(),
        reused,
        "actual cached App navigation stays unkeyed",
      );
      assert.equal(attachmentLoads, 3);
      assert.ok(
        document.querySelector(".message-images"),
        "canonical image geometry must remain present while Host media refresh is pending",
      );
      assert.equal(scroll().scrollTop, 650);
      if (interaction === "manual") {
        await act(async () => {
          scroll().dispatchEvent(
            new window.WheelEvent("wheel", { deltaY: -100, bubbles: true }),
          );
          scroll().scrollTop = 550;
          scroll().dispatchEvent(new window.Event("scroll"));
        });
      }
      if (interaction === "navigate") await choose(1);
      await act(async () => {
        late.resolve(projection);
      });
      if (interaction === "navigate") {
        assert.equal(
          document.querySelector(".message-images"),
          null,
          "late A media must not enter B, even with reused Item IDs",
        );
        assert.equal(scroll().scrollTop, 600);
        await choose(0);
      }
      await waitFor(() => document.querySelector(".message-images"));
      await act(async () => resize());
      assert.ok(document.querySelector(".back-live"));
      assert.equal(scroll().scrollTop, interaction === "manual" ? 550 : 650);
      // A newer authoritative snapshot without the image invalidates it, even if
      // an asynchronous Host projection still contains the old reference.
      imageStillCurrent = false;
      await choose(1);
      await choose(0);
      assert.equal(document.querySelector(".message-images"), null);
    } finally {
      globalThis.ResizeObserver = previous;
      await harness.unmount();
    }
  });
}

test("message action row appears only after the source Turn finishes, then Fork opens its exact reply", async () => {
  let notify: NotificationListener | undefined;
  const requests: Array<{ method: string; params: unknown }> = [];
  const pending = deferred<unknown>();
  const source = threadWithMessage("boundary");
  source.turns[0]!.status = "inProgress";
  source.turns[0]!.completedAt = null;
  source.turns[0]!.durationMs = null;
  source.status = { type: "active", activeFlags: [] };
  const harness = await mountApp({
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "zen/thread/resume")
        return resumed(
          (params as { threadId: string }).threadId === "fork-1"
            ? thread("fork-1")
            : source,
        );
      if (method === "zen/thread/fork") return pending.promise;
      throw new Error(`Unexpected request: ${method}`);
    },
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")!.click(),
    );
    await waitFor(() => document.querySelector(".agent-copy"));
    assert.equal(document.querySelector(".assistant-message-actions"), null);
    assert.equal(document.querySelector(".message-fork"), null);
    await act(async () => {
      notify?.(
        "zen/thread/event",
        nativeEvent(1, {
          type: "item_completed",
          item: {
            id: "turn-1-completed",
            type: "turn_completed",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: new Date(20000).toISOString(),
            status: "completed",
          },
        }),
      );
      notify?.(
        "zen/thread/event",
        nativeEvent(2, {
          type: "turn_completed",
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
        }),
      );
    });
    assert.ok(
      document.querySelector(".turn.completed"),
      "source completed normally",
    );
    const button = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".message-fork"),
    );
    assert.equal(
      document.querySelectorAll(".assistant-message-actions").length,
      1,
    );
    await act(async () => {
      button.focus();
      button.click();
    });
    assert.equal(button.disabled, true);
    assert.deepEqual(
      requests.find((r) => r.method === "zen/thread/fork")?.params,
      {
        sourceThreadId: "thread-1",
        through: { type: "item", itemId: "agent-boundary" },
        workspace: { type: "same-directory" },
      },
    );
    await act(async () =>
      pending.resolve({
        thread: nativeRecoveryForThread(thread("fork-1")).thread,
      }),
    );
    const ids = requests
      .filter((r) => r.method === "zen/thread/resume")
      .map((r) => (r.params as { threadId: string }).threadId);
    assert.ok(
      ids.includes("fork-1"),
      "successful fork must open when only the source Turn completed",
    );
  } finally {
    await harness.unmount();
  }
});

test("Sidebar debug mode targets its exact Thread, defaults off, exits, and never enables capture", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const harness = await mountApp({
    threads: async (archived) =>
      archived ? [] : [summary(), summary("thread-2", "Thread two")],
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "zen/thread/resume")
        return resumed({
          ...threadWithMessage("debug target"),
          id: (params as { threadId: string }).threadId,
        });
      throw new Error(`Unexpected request: ${method}`);
    },
  });
  const click = async (selector: string) =>
    act(async () =>
      document.querySelector<HTMLButtonElement>(selector)!.click(),
    );
  try {
    await click('[data-thread-id="thread-1"] .thread-row');
    assert.equal(document.querySelector(".thread-view-switch"), null);
    assert.equal(document.querySelector(".thread-debugger"), null);
    await click("#thread-menu-trigger-thread-2");
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-thread-action="debug"]',
    )!;
    assert.equal(toggle.getAttribute("role"), "menuitemcheckbox");
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    await act(async () => toggle.click());
    await waitFor(() => document.querySelector(".thread-debugger"));
    assert.deepEqual(
      requests.filter((r) => r.method === "zen/thread/resume").at(-1)?.params,
      { threadId: "thread-2" },
    );
    assert.equal(
      document.querySelectorAll(".thread-debug-tabs button[aria-pressed]")
        .length,
      2,
    );
    await click("#thread-menu-trigger-thread-2");
    assert.equal(
      document
        .querySelector('[data-thread-action="debug"]')
        ?.getAttribute("aria-checked"),
      "true",
    );
    await click('[data-thread-action="debug"]');
    assert.equal(document.querySelector(".thread-debugger"), null);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.equal(document.activeElement?.id, "thread-composer");
    await click("#thread-menu-trigger-thread-2");
    await click('[data-thread-action="debug"]');
    await waitFor(() => document.querySelector(".thread-debugger"));
    await click(".thread-debug-exit");
    assert.equal(document.querySelector(".thread-debugger"), null);
    assert.equal(document.querySelector(".thread-view-switch"), null);
    await click("#thread-menu-trigger-thread-2");
    await click('[data-thread-action="debug"]');
    await waitFor(() => document.querySelector(".thread-debugger"));
    await click('[data-thread-id="thread-1"] .thread-row');
    assert.equal(document.querySelector(".thread-debugger"), null);
    await click('[data-thread-id="thread-2"] .thread-row');
    assert.equal(document.querySelector(".thread-debugger"), null);
    assert.ok(!requests.some((r) => /capture|debug/i.test(r.method)));
  } finally {
    await harness.unmount();
  }
});

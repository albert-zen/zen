import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppServerManager } from "../src/main/app-server-manager.js";
import type { ZenXCapabilityHost } from "../src/main/capabilities/types.js";
import { isHostEvent } from "../src/main/host-messages.js";

const validSummary = {
  threadId: "thread-1",
  currentMetadata: {
    model: "fake",
    provider: "fake",
    cwd: "/workspace",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  },
  archived: false,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  preview: "hello",
  status: "idle",
};

test("validates exclusive native Thread summary success and error results", () => {
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "success",
      summaries: [validSummary],
    }),
    true,
  );
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "error",
      error: "fixture error",
    }),
    true,
  );
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "undefined-error-key",
      summaries: [validSummary],
      error: undefined,
    }),
    false,
  );
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "undefined-summaries-key",
      summaries: undefined,
      error: "fixture error",
    }),
    false,
  );
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "unavailable-summary",
      summaries: [
        {
          threadId: "damaged-thread",
          archived: false,
          createdAt: null,
          updatedAt: null,
          preview: "Thread journal could not be loaded.",
          status: "systemError",
          error: "invalid journal",
        },
      ],
    }),
    true,
  );
  assert.equal(
    isHostEvent({ type: "thread-summary/result", requestId: "missing" }),
    false,
  );
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "ambiguous",
      summaries: [],
      error: "fixture error",
    }),
    false,
  );
});

test("rejects malformed native Thread summaries at the host boundary", () => {
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "wrong-thread-id",
      summaries: [{ threadId: 42 }],
    }),
    false,
  );
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "wrong-model",
      summaries: [
        {
          ...validSummary,
          currentMetadata: { ...validSummary.currentMetadata, model: 42 },
        },
      ],
    }),
    false,
  );
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "partial-metadata",
      summaries: [
        {
          ...validSummary,
          currentMetadata: { model: "fake" },
        },
      ],
    }),
    false,
  );
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "wrong-status",
      summaries: [{ ...validSummary, status: "completed" }],
    }),
    false,
  );
  assert.equal(
    isHostEvent({
      type: "thread-summary/result",
      requestId: "ambiguous-summary",
      summaries: [{ ...validSummary, error: "unexpected" }],
    }),
    false,
  );
});

test("host event validation is total for hostile object access", () => {
  const hostile = new Proxy(
    {},
    {
      has: () => {
        throw new Error("hostile has trap");
      },
      get: () => {
        throw new Error("hostile getter");
      },
    },
  );
  assert.doesNotThrow(() => isHostEvent(hostile));
  assert.equal(isHostEvent(hostile), false);
});

test("manager rejects a malformed matching summary response", async () => {
  const fixture = await createFixtureManager("matching-malformed");
  try {
    await fixture.manager.start();
    await assert.rejects(
      within(fixture.manager.listThreadSummaries()),
      /Malformed native Thread summary response/u,
    );
  } finally {
    await fixture.manager.stop();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("manager accepts an exclusive error summary response", async () => {
  const fixture = await createFixtureManager("error");
  try {
    await fixture.manager.start();
    await assert.rejects(
      within(fixture.manager.listThreadSummaries()),
      /fixture summary error/u,
    );
  } finally {
    await fixture.manager.stop();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("manager rejects only the active request targeted by an unknown discriminant", async () => {
  const fixture = await createFixtureManager("matching-unknown-discriminant");
  try {
    await fixture.manager.start();
    const [targeted, unrelated] = await Promise.allSettled([
      within(fixture.manager.listThreadSummaries()),
      within(fixture.manager.listThreadSummaries({ archived: true })),
    ]);
    assert.equal(targeted.status, "rejected");
    if (targeted.status === "rejected") {
      assert.match(
        String(targeted.reason),
        /Malformed native Thread summary response/u,
      );
    }
    assert.equal(unrelated.status, "fulfilled");
    if (unrelated.status === "fulfilled") {
      assert.equal(unrelated.value[0]?.threadId, "fixture-thread");
      assert.equal(unrelated.value[0]?.archived, true);
    }
  } finally {
    await fixture.manager.stop();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("known host events ignore a colliding active summary requestId", async () => {
  const invocations: string[] = [];
  const capabilityHost: ZenXCapabilityHost = {
    hostSnapshot: () => ({ definitions: [] }),
    execute: async (invocation) => {
      invocations.push(
        `${invocation.name}:${String(invocation.arguments.target)}`,
      );
      return { output: "ok", exitCode: 0 };
    },
  };
  const fixture = await createFixtureManager(
    "colliding-known-events",
    capabilityHost,
  );
  try {
    await fixture.manager.start();
    const summaries = await within(fixture.manager.listThreadSummaries());
    assert.equal(summaries[0]?.threadId, "fixture-thread");
    await waitFor(() => invocations.length === 1);
    assert.deepEqual(invocations, ["fixture_inspect:summary"]);
  } finally {
    await fixture.manager.stop();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("manager ignores unmatched and late malformed summary responses", async () => {
  const fixture = await createFixtureManager("valid-with-noise");
  try {
    await fixture.manager.start();
    assert.equal(
      (await within(fixture.manager.listThreadSummaries()))[0]?.threadId,
      "fixture-thread",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const archived = await within(
      fixture.manager.listThreadSummaries({ archived: true }),
    );
    const summary = archived[0];
    assert(summary !== undefined && summary.status !== "systemError");
    assert.equal(summary.currentMetadata.cwd, "/archived");
  } finally {
    await fixture.manager.stop();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixtureManager(
  mode: string,
  capabilityHost?: ZenXCapabilityHost,
): Promise<{
  directory: string;
  manager: AppServerManager;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-summary-ipc-"));
  return {
    directory,
    manager: new AppServerManager({
      entryPath: path.resolve("test/fixtures/thread-summary-host.ts"),
      tokenFile: path.join(directory, "app-server.token"),
      hostConfig: {
        cwd: process.cwd(),
        dataDirectory: path.join(directory, "data"),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
      },
      environment: {
        ...process.env,
        ZENX_SUMMARY_FIXTURE_MODE: mode,
      },
      execArgv: ["--import", "tsx"],
      startupTimeoutMs: 10_000,
      ...(capabilityHost === undefined ? {} : { capabilityHost }),
    }),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for result")),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

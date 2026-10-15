import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  observeFocusOperation,
  type FocusObservation,
} from "../src/main/browser-focus-diagnostic.js";

function fixture() {
  const snapshot = {
    user: {
      hasFocus: false,
      visibility: "visible",
      activeElement: "user-input",
      value: "",
      focusEvents: ["blur"],
      visibilityEvents: [] as string[],
    },
    agent: {
      hasFocus: false,
      visibility: "hidden",
      activeElement: "",
      value: "",
      focusEvents: [] as string[],
      visibilityEvents: [] as string[],
    },
    native: {
      pid: 7,
      sentinelFocused: true,
      drift: false,
      axTrusted: true,
      samples: 1,
    },
  };
  const calls: unknown[][] = [];
  return {
    snapshot,
    calls,
    options: {
      operation: "capture-only" as "capture-only" | "insert-only",
      sentinelPid: 7,
      read: async () => {
        calls.push(["read"]);
        return structuredClone(snapshot);
      },
      send: async (
        role: "user" | "agent",
        method: string,
        params: Record<string, unknown>,
      ) => {
        calls.push([role, method, params]);
        return { data: "owned disposable image" };
      },
      wait: async (milliseconds: number) => {
        calls.push(["wait", milliseconds]);
      },
    },
  };
}

test("capture-only dispatches exactly one background agent capture and never inserts", async () => {
  const f = fixture();
  const result = await observeFocusOperation(f.options);
  assert.deepEqual(
    f.calls.filter((entry) => entry[0] === "agent"),
    [
      [
        "agent",
        "Page.captureScreenshot",
        { format: "png", fromSurface: true, captureBeyondViewport: false },
      ],
    ],
  );
  assert(!f.calls.some((entry) => entry[0] === "user"));
  assert.equal(result.focusHistoryChanged, false);
  assert.equal(result.nativeOwnershipChanged, false);
  assert(!JSON.stringify(result).includes("owned disposable image"));
});

test("insert-only records renderer focus independently from unchanged native sentinel ownership", async () => {
  const f = fixture();
  f.options.operation = "insert-only";
  const send = f.options.send;
  f.options.send = async (...args) => {
    const response = await send(...args);
    f.snapshot.user.hasFocus = true;
    f.snapshot.user.focusEvents.push("focus");
    f.snapshot.user.value = "SYNTHETIC";
    return response;
  };
  const result = await observeFocusOperation(f.options);
  assert.deepEqual(
    f.calls.filter((entry) => entry[0] === "user"),
    [["user", "Input.insertText", { text: "SYNTHETIC" }]],
  );
  assert(!f.calls.some((entry) => entry[0] === "agent"));
  assert.equal(result.focusHistoryChanged, true);
  assert.equal(result.nativeOwnershipChanged, false);
  assert.deepEqual(result.before?.user.focusEvents, ["blur"]);
  assert.deepEqual(result.after[0]?.user.focusEvents, ["blur", "focus"]);
});

test("an unknown subject command preserves its already-read baseline before stopping", async () => {
  const f = fixture();
  const evidence: FocusObservation[] = [];
  f.options.send = async (role, method) => {
    f.calls.push([role, method]);
    throw new Error("outcome unknown after dispatch");
  };
  await assert.rejects(
    observeFocusOperation({
      ...f.options,
      record: (value) => evidence.push(structuredClone(value)),
    }),
    /outcome unknown/,
  );
  const saved = evidence.at(-1);
  assert.equal(saved?.status, "stopped-after-error");
  assert.deepEqual(saved?.before, f.snapshot);
  assert.deepEqual(saved?.after, []);
  assert.equal(f.calls.length, 2);
});

test("a failed second after-read preserves the first drift evidence without further reads", async () => {
  const f = fixture();
  const before = structuredClone(f.snapshot);
  const evidence: FocusObservation[] = [];
  const read = f.options.read;
  let reads = 0;
  f.options.read = async () => {
    reads++;
    if (reads === 2) {
      f.snapshot.user.focusEvents.push("focus", "blur");
      f.snapshot.native.drift = true;
    }
    if (reads === 3) {
      f.calls.push(["read-unknown"]);
      throw new Error("second after-read unknown");
    }
    return read();
  };
  await assert.rejects(
    observeFocusOperation({
      ...f.options,
      record: (value) => evidence.push(structuredClone(value)),
    }),
    /second after-read unknown/,
  );
  const saved = evidence.at(-1);
  assert.equal(saved?.status, "stopped-after-error");
  assert.deepEqual(saved?.before, before);
  assert.deepEqual(saved?.after, [f.snapshot]);
  assert.equal(saved?.focusHistoryChanged, true);
  assert.equal(saved?.nativeOwnershipChanged, true);
  assert.equal(reads, 3);
  assert.equal(f.calls.filter((entry) => entry[0] === "agent").length, 1);
  assert.equal(f.calls.at(-1)?.[0], "read-unknown");
});

for (const operation of ["capture-only", "insert-only"] as const)
  test(`${operation} unknown rejection stops immediately without read, second dispatch or wait`, async () => {
    const f = fixture();
    f.options.operation = operation;
    f.options.send = async (role, method) => {
      f.calls.push([role, method]);
      throw new Error("outcome unknown after dispatch");
    };
    await assert.rejects(observeFocusOperation(f.options), /outcome unknown/);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0]?.[0], "read");
    assert.equal(
      f.calls[1]?.[1],
      operation === "capture-only"
        ? "Page.captureScreenshot"
        : "Input.insertText",
    );
  });

test("unsettled setup fails before dispatch instead of resetting a recorded excursion", async () => {
  const f = fixture();
  f.snapshot.user.hasFocus = true;
  await assert.rejects(observeFocusOperation(f.options));
  assert.deepEqual(f.calls, [["read"]]);
});

test("known capture ownership/focus drift remains evidence and is never normalized", async () => {
  const f = fixture();
  f.options.wait = async () => {
    f.snapshot.user.focusEvents.push("focus", "blur");
    f.snapshot.native.drift = true;
  };
  const result = await observeFocusOperation(f.options);
  assert.equal(result.focusHistoryChanged, true);
  assert.equal(result.nativeOwnershipChanged, true);
  assert.equal(result.after[1]?.native.drift, true);
});

test("one-shot workflow uses exact head, fresh processes and stops its pair on error", () => {
  const workflow = readFileSync(
    new URL(
      "../../../.github/workflows/browser-focus-diagnostic.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /types: \[opened\]/);
  assert.match(
    workflow,
    /head\.ref == 'diagnostic\/browser-focus-boundary-20261015'/,
  );
  assert.match(workflow, /github\.run_attempt == 1/);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /set -euo pipefail/);
  assert.match(workflow, /for operation in capture-only insert-only/);
  assert.doesNotMatch(
    workflow,
    /workflow_dispatch|continue-on-error|\|\| true/,
  );
});

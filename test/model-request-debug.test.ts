import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileTraceStore, type TraceEvent } from "../src/trace.js";
import {
  ModelRequestDebugStore,
  validateModelRequestDebugCommand,
} from "../apps/cli/src/model-request-debug.js";
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "trace-reader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileTraceStore(directory);
  const add = (event: Omit<TraceEvent, "threadId"> & { threadId?: string }) =>
    store.record({ threadId: "thread-a", sampleId: "sample-a", ...event });
  return {
    directory,
    store,
    add,
    reader: new ModelRequestDebugStore(store, {
      pageCharacters: 7,
      pageRecords: 2,
    }),
  };
}
async function whole(
  reader: ModelRequestDebugStore,
  threadId: string,
  id: string,
  view: "payload" | "output" | "artifact" = "payload",
) {
  let text = "",
    offset = 0;
  do {
    const page = (
      await reader.control({ action: "read", threadId, id, view, offset })
    ).page!;
    text += page.text;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  return text;
}
test("reader survives restart, paginates exact original body including BOM and supplementary characters", async (t) => {
  const { directory, store, add } = await fixture(t);
  const body =
    '\uFEFF{"messages":[{"role":"user","content":"秘密😀<script>keep()</script>"}],"token":"body-not-redacted"}';
  await add({
    type: "model_sample_started",
    data: {
      purpose: "turn",
      model: "old-model",
      configuration: { permissions: "ask" },
    },
  });
  await add({
    type: "model_request",
    data: { transportAttempt: 1, format: "responses" },
    artifacts: [{ name: "request_body", bytes: body }],
  });
  await add({
    type: "model_request_dispatched",
    data: { transportAttempt: 1 },
  });
  const record = (await store.read("thread-a")).records.find(
    (x) => x.type === "model_request",
  )!;
  const reader = new ModelRequestDebugStore(new FileTraceStore(directory), {
    pageCharacters: 7,
  });
  assert.equal(await whole(reader, "thread-a", record.id), body);
  const page = (
    await reader.control({
      action: "read",
      threadId: "thread-a",
      id: record.id,
      view: "configuration",
    })
  ).page!;
  assert.equal(page.record.model, "old-model");
  assert.equal(page.record.dispatch, "observed");
  assert.equal(page.record.responseCapture, "unknown");
  assert.equal(page.record.sampleOutcome, "unknown");
});
test("semantic completion and full sample duration do not imply raw HTTP EOF or attempt duration", async (t) => {
  const { reader, add } = await fixture(t);
  await add({
    type: "model_request",
    data: { transportAttempt: 1 },
    artifacts: [{ name: "request_body", bytes: "{}" }],
  });
  await add({
    type: "model_request_dispatched",
    data: { transportAttempt: 1 },
  });
  await add({
    type: "model_sample_finished",
    data: { outcome: "completed", elapsedNs: "123000000" },
  });
  let r = (await reader.control({ action: "list", threadId: "thread-a" }))
    .records![0]!;
  assert.equal(r.sampleOutcome, "completed");
  assert.equal(r.responseCapture, "unknown");
  assert.equal(r.sampleDurationMs, 123);
  assert.equal(r.attemptDurationMs, null);
  await add({
    type: "model_response_end",
    data: {
      transportAttempt: 1,
      completeness: "complete",
      bytes: 0,
      chunks: 0,
    },
  });
  r = (await reader.control({ action: "list", threadId: "thread-a" }))
    .records![0]!;
  assert.equal(r.responseCapture, "complete");
  assert.notEqual(r.attemptDurationMs, null);
});
test("completed HTTP body cannot mask model cancellation or parser failure", async (t) => {
  const { reader, add } = await fixture(t);
  await add({ type: "model_request", data: { transportAttempt: 1 } });
  await add({
    type: "model_response_end",
    data: { transportAttempt: 1, completeness: "complete" },
  });
  for (const outcome of ["failed", "cancelled"] as const) {
    await add({ type: "model_sample_finished", data: { outcome } });
    const r = (await reader.control({ action: "list", threadId: "thread-a" }))
      .records![0]!;
    assert.equal(r.responseCapture, "complete");
    assert.equal(r.sampleOutcome, outcome);
  }
});
test("prepared body is not dispatch proof; blocked retries do not inherit previous attempt EOF", async (t) => {
  const { reader, add } = await fixture(t);
  await add({ type: "model_request", data: { transportAttempt: 1 } });
  await add({
    type: "model_response_end",
    data: { transportAttempt: 1, completeness: "complete" },
  });
  await add({
    type: "model_request",
    data: { transportAttempt: 2 },
    artifacts: [{ name: "request_body", bytes: "{}" }],
  });
  let r = (await reader.control({ action: "list", threadId: "thread-a" }))
    .records![0]!;
  assert.equal(r.dispatch, "unknown");
  assert.equal(r.responseCapture, "unknown");
  await add({
    type: "model_dispatch_blocked",
    data: {
      transportAttempt: 2,
      reason: "provider_revoked",
      preparedRequestCaptured: true,
    },
  });
  r = (await reader.control({ action: "list", threadId: "thread-a" }))
    .records![0]!;
  assert.equal(r.dispatch, "blocked");
  assert.equal(r.preparedRequestCaptured, true);
  assert.equal(r.responseCapture, "unknown");
  assert.equal(r.attemptTimingScope, "request-preparation-to-block");
  await add({
    type: "model_dispatch_blocked",
    data: { transportAttempt: 3, preparedRequestCaptured: false },
  });
  r = (await reader.control({ action: "list", threadId: "thread-a" }))
    .records![0]!;
  assert.equal(r.type, "model_dispatch_blocked");
  assert.equal(r.preparedRequestCaptured, false);
  assert.equal(r.requestBytes, null);
});
test("output joins split Unicode bytes, binary artifacts are lossless Base64", async (t) => {
  const { reader, add, store } = await fixture(t);
  const request = await add({
    type: "model_request",
    data: { transportAttempt: 1 },
  });
  const bytes = Buffer.from("😀正文");
  for (const [index, chunk] of [
    bytes.subarray(0, 2),
    bytes.subarray(2),
  ].entries())
    await add({
      type: "model_response_chunk",
      data: { transportAttempt: 1, index },
      artifacts: [{ name: "response_body", bytes: chunk }],
    });
  assert.equal(
    await whole(reader, "thread-a", request.recordId!, "output"),
    "😀正文",
  );
  const binary = await add({
    type: "tool_output",
    artifacts: [{ name: "tool_output", bytes: new Uint8Array([255, 0, 254]) }],
  });
  const page = (
    await reader.control({
      action: "read",
      threadId: "thread-a",
      id: binary.recordId!,
      view: "artifact",
    })
  ).page!;
  assert.equal(page.encoding, "base64");
  assert.equal(page.text, "/wD+");
  assert.equal((await store.read("thread-a")).records.length, 4);
});
test("legacy/adapter input is not reconstructed wire; no absent output is called empty", async (t) => {
  const { reader, add } = await fixture(t);
  const receipt = await add({
    type: "model_input",
    artifacts: [{ name: "model_input", bytes: '{"messages":[]}' }],
  });
  const page = (
    await reader.control({
      action: "read",
      threadId: "thread-a",
      id: receipt.recordId!,
    })
  ).page!;
  assert.equal(page.availability, "unavailable");
  assert.equal(
    await whole(reader, "thread-a", receipt.recordId!, "artifact"),
    '{"messages":[]}',
  );
});
test("all-local includes auxiliary records but IDs cannot read other scope/artifact paths", async (t) => {
  const { reader, add } = await fixture(t);
  const aux = await add({
    threadId: "aux-title",
    type: "model_input",
    artifacts: [{ name: "input", bytes: "private-local" }],
  });
  assert.equal(
    (await reader.control({ action: "list", threadId: "" })).records![0]!
      .threadId,
    "aux-title",
  );
  await assert.rejects(
    reader.control({ action: "read", threadId: "thread-a", id: aux.recordId! }),
    /scope/u,
  );
  for (const input of [
    { action: "clear" },
    { action: "setEnabled", enabled: true },
    { action: "status", path: "/etc/passwd" },
    { action: "read", threadId: "../aux-title", id: aux.recordId },
    {
      action: "read",
      threadId: "aux-title",
      id: aux.recordId,
      view: ["payload"],
    },
    {
      action: "read",
      threadId: "aux-title",
      id: aux.recordId,
      artifactIndex: -1,
    },
  ])
    assert.throws(() => validateModelRequestDebugCommand(input));
});
test("artifact corruption is exposed on read without broad local redaction", async (t) => {
  const { reader, add, store, directory } = await fixture(t);
  const receipt = await add({
    type: "model_request",
    artifacts: [{ name: "request_body", bytes: "secret-original" }],
  });
  const ref = (await store.read("thread-a")).records[0]!.artifacts[0]!.ref;
  await writeFile(path.join(directory, "artifacts", ref.sha256), "corrupt");
  const index = await reader.control({ action: "list", threadId: "thread-a" });
  assert.equal(index.artifactVerification, "on-read");
  const read = await reader.control({
    action: "read",
    threadId: "thread-a",
    id: receipt.recordId!,
  });
  assert.equal(read.completeness, "incomplete");
  assert.equal(read.page!.availability, "unavailable");
  assert.equal(read.issues[0]!.kind, "artifact_unavailable");
});

test("explicit EOF with missing captured chunks is incomplete, not an empty response", async (t) => {
  const { reader, add } = await fixture(t);
  const request = await add({
    type: "model_request",
    data: { transportAttempt: 1 },
  });
  await add({
    type: "model_response_end",
    data: {
      transportAttempt: 1,
      completeness: "complete",
      bytes: 12,
      chunks: 1,
    },
  });
  const record = (
    await reader.control({ action: "list", threadId: "thread-a" })
  ).records![0]!;
  assert.equal(record.responseCapture, "incomplete");
  const page = (
    await reader.control({
      action: "read",
      threadId: "thread-a",
      id: request.recordId!,
      view: "output",
    })
  ).page!;
  assert.equal(page.availability, "unavailable");
});

test("large originals use bounded verified byte ranges, never full artifact materialization", async (t) => {
  const { store, add } = await fixture(t);
  const body = '{"input":"' + "x".repeat(5 * 1024 * 1024) + '"}';
  const receipt = await add({
    type: "model_request",
    artifacts: [{ name: "request_body", bytes: body }],
  });
  const ranges: number[] = [];
  const reader = new ModelRequestDebugStore(
    {
      read: store.read.bind(store),
      async readArtifact() {
        throw new Error("full artifact read forbidden by test");
      },
      async readArtifactRange(ref, offset, limit) {
        ranges.push(limit);
        return store.readArtifactRange(ref, offset, limit);
      },
    },
    { pageCharacters: 97 },
  );
  const page = (
    await reader.control({
      action: "read",
      threadId: "thread-a",
      id: receipt.recordId!,
    })
  ).page!;
  assert.equal(page.availability, "available");
  assert.equal(page.offsetUnit, "bytes");
  assert.equal(page.totalBytes, Buffer.byteLength(body));
  assert.equal(page.totalCharacters, null);
  assert.equal(page.text, body.slice(0, 97));
  assert.equal(page.endOffset, 97);
  assert(ranges.every((x) => x <= 97));
  const structure = (
    await reader.control({
      action: "read",
      threadId: "thread-a",
      id: receipt.recordId!,
      view: "messages",
    })
  ).page!;
  assert.equal(structure.availability, "unavailable");
  assert.match(structure.text, /4 MiB/u);
});
test("zero-byte artifacts still verify ownership and existence", async (t) => {
  const { store, directory, add } = await fixture(t);
  const receipt = await add({
    type: "model_request",
    artifacts: [{ name: "request_body", bytes: "" }],
  });
  const ref = (await store.read("thread-a")).records[0]!.artifacts[0]!.ref;
  await rm(path.join(directory, "artifacts", ref.sha256));
  const reader = new ModelRequestDebugStore(store);
  const page = (
    await reader.control({
      action: "read",
      threadId: "thread-a",
      id: receipt.recordId!,
    })
  ).page!;
  assert.equal(page.availability, "unavailable");
});

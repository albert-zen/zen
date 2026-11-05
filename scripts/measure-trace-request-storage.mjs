// Synthetic only. Run each source/case in a fresh process for a separate RSS peak:
// node --import tsx scripts/measure-trace-request-storage.mjs ./src/trace.ts growing
// A baseline source path lets the identical fixture measure an older checkout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const source = path.resolve(process.argv[2] ?? "./src/trace.ts");
const scenario = process.argv[3] ?? "growing";
assert.ok(
  [
    "growing",
    "short",
    "shifted",
    "compressed",
    "tool",
    "images",
    "legacy",
  ].includes(scenario),
);
const { FileTraceStore } = await import(pathToFileURL(source).href);
const root = await mkdtemp(
  path.join(os.tmpdir(), "zen-trace-storage-measure-"),
);
const times = { write: [], full: [], range: [] };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function text(index) {
  let result = "";
  for (let part = 0; result.length < 2048; part++)
    result += sha(`${index}:${part}`);
  return result.slice(0, 2048);
}
function percentiles(values) {
  values.sort((a, b) => a - b);
  return {
    p50: values[Math.ceil(values.length * 0.5) - 1],
    p95: values[Math.ceil(values.length * 0.95) - 1],
  };
}
async function measure(kind, fn) {
  const start = performance.now();
  const value = await fn();
  times[kind].push(performance.now() - start);
  return value;
}
async function inventory(directory, prefix = "", result = {}) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory())
      await inventory(filename, `${prefix}${entry.name}/`, result);
    else {
      const metadata = await stat(filename);
      const type =
        prefix
          .split("/")[0]
          ?.match(/\.(request-text-v1|text-v1|request-v1|image-v1)$/)?.[1] ??
        (prefix.startsWith("threads/") ? "records" : "raw");
      const total = (result[type] ??= { files: 0, logical: 0, allocated: 0 });
      total.files++;
      total.logical += metadata.size;
      total.allocated += metadata.blocks * 512;
    }
  }
  return result;
}
try {
  const store = new FileTraceStore(root);
  const count = scenario === "growing" ? 128 : scenario === "short" ? 8 : 32;
  const messages = [];
  const bodies = [];
  const checkpoints = [];
  for (let index = 0; index < count; index++) {
    messages.push({ role: "user", content: text(index) });
    let object = { messages };
    if (scenario === "shifted")
      object = {
        changing: text(index).slice(0, index * 17 + 1),
        messages: Array.from({ length: 64 }, (_, i) => ({
          role: "user",
          content: text(i),
        })),
      };
    if (scenario === "compressed")
      object = {
        compressed: gzipSync(
          Buffer.from(
            Array.from({ length: 80 }, (_, i) => text(index * 80 + i)).join(""),
          ),
        ).toString("base64"),
      };
    if (scenario === "images")
      object = {
        image: `data:image/png;base64,${Buffer.alloc(180002, 0xed).toString("base64")}`,
        messages,
      };
    const body = Buffer.from(JSON.stringify(object));
    bodies.push(body);
    const event = {
      threadId: `request-${index}`,
      type: scenario === "tool" ? "tool_result_observed" : "model_request",
      artifacts: [
        { name: "request_body", bytes: body, mediaType: "application/json" },
      ],
    };
    if (scenario === "legacy")
      assert.equal(
        (
          await store.record({
            ...event,
            threadId: `legacy-${index}`,
            type: "tool_result_observed",
          })
        ).durability,
        "durable",
      );
    assert.equal(
      (await measure("write", () => store.record(event))).durability,
      "durable",
    );
    if ([31, 63, 127].includes(index))
      checkpoints.push({
        requests: index + 1,
        artifacts: await inventory(path.join(root, "artifacts")),
      });
  }
  const reader = new FileTraceStore(root);
  for (const [index, body] of bodies.entries()) {
    const read = await reader.read(`request-${index}`, {
      verifyArtifacts: false,
    });
    assert.equal(read.completeness, "complete");
    const ref = read.records[0].artifacts[0].ref;
    assert.deepEqual(ref, {
      sha256: sha(body),
      byteLength: body.length,
      mediaType: "application/json",
    });
    assert.deepEqual(
      await measure("full", () => reader.readArtifact(ref)),
      body,
    );
    assert.deepEqual(
      await measure("range", () => reader.readArtifactRange(ref, 65533, 4096)),
      body.subarray(65533, 65533 + 4096),
    );
  }
  console.log(
    JSON.stringify({
      scenario,
      source,
      platform: process.platform,
      node: process.version,
      requests: count,
      rawBodyBytes: bodies.reduce((sum, body) => sum + body.length, 0),
      artifacts: await inventory(path.join(root, "artifacts")),
      records: await inventory(path.join(root, "threads"), "threads/"),
      checkpoints,
      milliseconds: Object.fromEntries(
        Object.entries(times).map(([kind, values]) => [
          kind,
          percentiles(values),
        ]),
      ),
      processPeakRssKiB: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

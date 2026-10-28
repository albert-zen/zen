import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createImGatewayDiagnosticSink } from "../src/main/im-gateway-diagnostics.js";

test("IM gateway owner log preserves causal errors and bounded stderr without configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "im-gateway-diagnostic-"));
  try {
    const sink = createImGatewayDiagnosticSink(root);
    await sink({
      stage: "startup",
      error: new Error("migration blocked", {
        cause: new Error("synthetic table layout mismatch"),
      }),
      stderr: "synthetic traceback\n",
    });
    const file = path.join(root, "diagnostics", "im-gateway.jsonl");
    const raw = await readFile(file, "utf8");
    const event = JSON.parse(raw);
    assert.match(event.detail, /synthetic table layout mismatch/);
    assert.equal(event.stderr, "synthetic traceback\n");
    assert.deepEqual(Object.keys(event), [
      "timestamp",
      "stage",
      "detail",
      "stderr",
    ]);
    if (process.platform !== "win32")
      assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  MAC_BOUND_TARGET_SOURCE,
  runProcess,
} from "../src/main/capabilities/computer-provider.js";

test(
  "native capture progress contains only static stages, monotonic time and thread affinity",
  { skip: process.platform !== "darwin", timeout: 90000 },
  async (t) => {
    const start = MAC_BOUND_TARGET_SOURCE.indexOf("enum NativeCaptureStage:"),
      end = MAC_BOUND_TARGET_SOURCE.indexOf(
        "struct CaptureImageBudgetExceeded",
        start,
      );
    assert.ok(
      start > 0 && end > start,
      "bounded native capture phase diagnostics must exist",
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "zenx-capture-progress-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = path.join(dir, "fixture.swift"),
      binary = path.join(dir, "fixture");
    await writeFile(
      source,
      "import Foundation\nimport Dispatch\n" +
        MAC_BOUND_TARGET_SOURCE.slice(
          MAC_BOUND_TARGET_SOURCE.indexOf("let nativeOutputLock ="),
          MAC_BOUND_TARGET_SOURCE.indexOf("typealias WindowLocationSetter"),
        ) +
        MAC_BOUND_TARGET_SOURCE.slice(start, end) +
        '\ncaptureProgress(.contentRequested)\ncaptureProgress(.callbackEntered)\ncaptureProgress(.metadataReady)\ncaptureProgress(.slsBefore)\ncaptureProgress(.slsReturned)\ncaptureProgress(.completed)\ncaptureProgress(.slsBefore, "7f77bccb-b9bc-4138-8cd3-d279806dbbb2")\ncaptureProgress(.slsReturned, "7f77bccb-b9bc-4138-8cd3-d279806dbbb2")\ncaptureProgress(.completed, "03507002-6b77-47a8-bdaa-737b7b54ed98")\ncaptureProgress(.completed, "private target or title must never echo")\n',
    );
    await runProcess("/usr/bin/swiftc", ["-O", source, "-o", binary], 60000);
    const { stdout, stderr } = await promisify(execFile)(binary, [], {
      timeout: 10000,
    });
    const phases = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(phases.length, 3);
    assert.ok(phases.every((value) => value.phase === "diagnostic"));
    assert.equal(
      phases[0].diagnostic.requestId,
      "7f77bccb-b9bc-4138-8cd3-d279806dbbb2",
    );
    assert.equal(
      phases[1].diagnostic.requestId,
      phases[0].diagnostic.requestId,
    );
    assert.equal(
      phases[2].diagnostic.requestId,
      "03507002-6b77-47a8-bdaa-737b7b54ed98",
    );
    const rows = stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.slice(0, 6).map((x) => x.stage),
      [
        "content-requested",
        "callback-entered",
        "metadata-ready",
        "sls-before",
        "sls-returned",
        "completed",
      ],
    );
    for (let i = 0; i < 6; i++) {
      assert.deepEqual(Object.keys(rows[i]).sort(), [
        "kind",
        "mainThread",
        "monotonicNs",
        "stage",
      ]);
      assert.equal(rows[i].kind, "native-capture-progress");
      assert.equal(rows[i].mainThread, true);
      assert.match(rows[i].monotonicNs, /^\d+$/);
      if (i)
        assert.ok(
          BigInt(rows[i].monotonicNs) >= BigInt(rows[i - 1].monotonicNs),
        );
    }
    assert.equal(rows.length, 7);
    assert.equal(rows[6].requestId, undefined);
    assert.doesNotMatch(stderr, /private target|never echo/);
    assert.ok(stderr.length < 2500);
  },
);

test(
  "native JSONL emit serializes concurrent frames without fragments",
  { skip: process.platform !== "darwin", timeout: 90000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-native-emit-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, "fixture.swift"),
      binary = path.join(directory, "fixture");
    const start = MAC_BOUND_TARGET_SOURCE.indexOf("let nativeOutputLock ="),
      end = MAC_BOUND_TARGET_SOURCE.indexOf(
        "typealias WindowLocationSetter",
        start,
      );
    assert.ok(
      start > 0 && end > start,
      "native output must own one frame lock",
    );
    await writeFile(
      source,
      "import Foundation\nimport Dispatch\n" +
        MAC_BOUND_TARGET_SOURCE.slice(start, end) +
        '\nDispatchQueue.concurrentPerform(iterations: 100) { index in emit(["index": index, "payload": String(repeating: "x", count: 1200)]) }\n',
    );
    await runProcess("/usr/bin/swiftc", ["-O", source, "-o", binary], 60000);
    const { stdout, stderr } = await promisify(execFile)(binary, [], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(stderr, "");
    const rows = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 100);
    assert.deepEqual(
      rows.map((row) => row.index).sort((a, b) => a - b),
      Array.from({ length: 100 }, (_, i) => i),
    );
    assert.ok(rows.every((row) => row.payload === "x".repeat(1200)));
  },
);

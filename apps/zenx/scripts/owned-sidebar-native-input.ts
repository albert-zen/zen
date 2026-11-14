/** CI-only adapter to the same owned native input path as Computer acceptance. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";
import {
  MAC_BOUND_TARGET_SOURCE,
  runProcess,
} from "../src/main/capabilities/computer-provider.js";
import { NativeComputerTargetTransport } from "../src/main/capabilities/computer-target-transport.js";
export async function prepareOwnedSidebarInput(directory: string) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.platform, "darwin");
  const executable = path.join(directory, "owned-sidebar-computer");
  await writeFile(executable + ".swift", MAC_BOUND_TARGET_SOURCE);
  // Observe the existing single compile; never alter its arguments, deadline,
  // cancellation, or native close handling. Do not log raw compiler output.
  const started = performance.now();
  const summary = {
    schema: 1,
    sourceSha256: createHash("sha256")
      .update(MAC_BOUND_TARGET_SOURCE)
      .digest("hex"),
    command: "/usr/bin/swiftc",
    timeoutMs: 60_000,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    loadBefore: os.loadavg(),
    loadAfter: [] as number[],
    pid: null as number | null,
    exitCode: null as number | null,
    exitSignal: null as string | null,
    stoppingObserved: false,
    closeObserved: false,
    status: "running",
    stdout: { bytes: 0, tail: Buffer.alloc(0) },
    stderr: { bytes: 0, tail: Buffer.alloc(0) },
  };
  const observeSpawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    summary.pid = child.pid ?? null;
    for (const name of ["stdout", "stderr"] as const) {
      child[name]?.on("data", (chunk: Buffer | string) => {
        try {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          summary[name].bytes += bytes.length;
          summary[name].tail = Buffer.concat([
            summary[name].tail,
            bytes.subarray(-4096),
          ]).subarray(-4096);
        } catch {
          // Passive observation must not interrupt the compiler stream.
        }
      });
    }
    child.once("close", (code, signal) => {
      summary.closeObserved = true;
      summary.exitCode = code;
      summary.exitSignal = signal;
    });
    return child;
  }) as typeof spawn;
  try {
    await runProcess(
      "/usr/bin/swiftc",
      ["-O", executable + ".swift", "-o", executable],
      60_000,
      undefined,
      undefined,
      observeSpawn,
      () => {
        summary.stoppingObserved = true;
      },
    );
    summary.status = "passed";
  } catch (error) {
    summary.status = "failed";
    throw error;
  } finally {
    // Logging is best effort and must never mask the original compile result.
    try {
      summary.elapsedMs = Math.round(performance.now() - started);
      summary.loadAfter = os.loadavg();
      const safeStream = (stream: typeof summary.stdout) => {
        const tail = stream.tail.toString("utf8");
        return {
          bytes: stream.bytes,
          retainedTailBytes: stream.tail.length,
          rawOutputOmitted: true,
          // Fixed categories only: no paths, environment, source text or messages.
          diagnosticCategories: [
            ["error", /(?:^|\n).*?\berror:/i],
            ["warning", /(?:^|\n).*?\bwarning:/i],
            ["missing-module", /no such module/i],
            ["missing-sdk", /unable to find sdk|SDK.*not found/i],
            ["compiler-crash", /please submit a bug report|stack dump/i],
            ["permission-denied", /permission denied|operation not permitted/i],
          ]
            .filter(([, pattern]) => (pattern as RegExp).test(tail))
            .map(([name]) => name),
        };
      };
      console.info(
        "OWNED_SWIFTC_DIAGNOSTICS " +
          JSON.stringify({
            ...summary,
            stdout: safeStream(summary.stdout),
            stderr: safeStream(summary.stderr),
          }),
      );
    } catch {
      // Diagnostics cannot fail the acceptance or replace a compile error.
    }
  }
  const transport = new NativeComputerTargetTransport(async () => executable);
  return {
    close: () => transport.close(),
    async click(window: BrowserWindow, point: { x: number; y: number }) {
      assert.ok(
        !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
      );
      const content = window.getContentBounds();
      assert.ok(
        point.x >= 0 &&
          point.x < content.width &&
          point.y >= 0 &&
          point.y < content.height,
      );
      const owner = "synthetic-owned-sidebar";
      const selected = (await transport.request(
        {
          operation: "select",
          owner,
          target: { pid: process.pid, windowTitle: window.getTitle() },
        },
        AbortSignal.timeout(10_000),
      )) as { bindingId: string; windowId: number; target: { pid: number } };
      assert.equal(selected.target.pid, process.pid);
      const posted = await transport.request(
        {
          operation: "click",
          owner,
          bindingId: selected.bindingId,
          x: content.x + point.x,
          y: content.y + point.y,
          button: "left",
        },
        AbortSignal.timeout(10_000),
      );
      const verified = (await transport.request(
        { operation: "verify", owner, bindingId: selected.bindingId },
        AbortSignal.timeout(10_000),
      )) as { windowId: number };
      assert.equal(verified.windowId, selected.windowId);
      return { pid: selected.target.pid, windowId: selected.windowId, posted };
    },
  };
}

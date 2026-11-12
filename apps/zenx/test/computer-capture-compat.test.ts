import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NativeImage } from "electron";
import { ElectronMacComputerBackend } from "../src/main/capabilities/computer-provider.js";

// Only platform observations are doubled. Public screenshot/capture registry,
// persisted image/hash, source metadata and action admission remain production.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAFElEQVR4nGOcZnSCARtgwipKlgQAmuIBmIICzE4AAAAASUVORK5CYII=",
  "base64",
);
for (const kind of ["old", "missing", "budget", "sck-error"] as const) {
  for (const state of ["active", "locked", "unknown"] as const) {
    test(
      `exact window screenshot ${kind}/${state}: preserve legacy read-only without background authority`,
      { skip: process.platform !== "darwin" },
      async (t) => {
        const directory = await mkdtemp(
          path.join(os.tmpdir(), "zenx-capture-compat-"),
        );
        t.after(() => rm(directory, { recursive: true, force: true }));
        const calls: string[] = [];
        const backend = new ElectronMacComputerBackend(
          directory,
          {
            async run(request) {
              assert.equal(request.operation, "sessionState");
              calls.push("session");
              return { sessionState: state };
            },
          },
          {
            captureWindowId: async (id) => {
              assert.equal(id, 17);
              calls.push("legacy-image");
              return {
                getSize: () => ({ width: 8, height: 4 }),
                toPNG: () => png,
              } as NativeImage;
            },
          },
        );
        t.after(() => backend.close());
        const binding = {
          bindingId: "b",
          windowId: 17,
          target: { pid: 7, applicationName: "Fixture", windowTitle: "Window" },
          bounds: { x: -100, y: 20, width: 400, height: 200 },
          windowLocalInputAvailable: kind === "budget" || kind === "sck-error",
          ...(kind === "missing"
            ? {}
            : { exactWindowCaptureAvailable: kind !== "old" }),
        };
        backend.targetSession.transport.request = async (request) => {
          calls.push(String(request.operation));
          if (request.operation === "select" || request.operation === "verify")
            return binding;
          if (request.operation === "capture") {
            if (kind === "sck-error") throw new Error("SCK outcome unknown");
            return { source: "legacy_required", reason: "image_budget" };
          }
          throw new Error("Unexpected native input dispatch");
        };
        const signal = new AbortController().signal,
          target = { pid: 7, windowTitle: "Window" };
        if (kind === "sck-error" || state !== "active") {
          await assert.rejects(
            backend.screenshot(target, signal, "owner"),
            kind === "sck-error"
              ? /SCK outcome unknown/
              : /active.*legacy|legacy.*active/i,
          );
          assert.equal(calls.includes("legacy-image"), false);
        } else {
          const image = (await backend.screenshot(
            target,
            signal,
            "owner",
          )) as Awaited<ReturnType<typeof backend.screenshot>> & {
            captureSource: string;
            backgroundInputEligible: boolean;
            bindingId: string;
            captureId: string;
          };
          assert.equal(image.captureSource, "legacy_desktop_capturer");
          assert.equal(image.backgroundInputEligible, false);
          assert.deepEqual(await readFile(image.artifactPath), png);
          await assert.rejects(
            backend.targetSession.backgroundClick(
              "owner",
              target,
              image.bindingId,
              image.captureId,
              1,
              1,
              signal,
            ),
            /eligible|primitive|legacy/,
          );
          assert.equal(calls.includes("backgroundClick"), false);
          assert.equal(
            calls.indexOf("session") < calls.indexOf("legacy-image"),
            true,
          );
        }
        if (kind === "old" || kind === "missing")
          assert.equal(
            calls.includes("capture"),
            false,
            "old helper never receives an unrecognized operation",
          );
        if (kind === "sck-error")
          assert.equal(
            calls.includes("session"),
            false,
            "unknown SCK result cannot initiate fallback",
          );
      },
    );
  }
}

test(
  "legacy capture that spans an unnotified OS lock cannot publish a fresh image",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-capture-lock-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    let state = "active",
      reads = 0;
    const backend = new ElectronMacComputerBackend(
      directory,
      {
        async run() {
          reads++;
          return { sessionState: state };
        },
      },
      {
        captureWindowId: async () => {
          state = "locked";
          return {
            getSize: () => ({ width: 8, height: 4 }),
            toPNG: () => png,
          } as NativeImage;
        },
      },
    );
    t.after(() => backend.close());
    backend.targetSession.transport.request = async () => ({
      bindingId: "b",
      windowId: 17,
      target: { pid: 7, applicationName: "Fixture", windowTitle: "Window" },
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      exactWindowCaptureAvailable: false,
    });
    await assert.rejects(
      backend.screenshot(
        { pid: 7, windowTitle: "Window" },
        new AbortController().signal,
        "owner",
      ),
      /fresh active session/,
    );
    assert.equal(reads, 2);
  },
);

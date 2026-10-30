import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAC_BOUND_TARGET_SOURCE,
  runProcess,
} from "../src/main/capabilities/computer-provider.js";
import { NativeComputerTargetTransport } from "../src/main/capabilities/computer-target-transport.js";

/** Hosted opt-in only: owned fixture windows; never requests or alters OS trust. */
test(
  "owned macOS receiver observes native drag and exact AX cache reacquisition",
  {
    skip:
      process.platform !== "darwin" ||
      process.env.ZENX_COMPUTER_OWNED_NATIVE_ACCEPTANCE !== "1",
    timeout: 240_000,
  },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-owned-input-"),
    );
    const evidence: Record<string, unknown> = {
      status: "running",
      scope: "owned_native_drag_and_ax_cache_reacquisition",
      captureAdmission:
        "covered separately by session tests; no screenshot captured here",
      permissionChanges: false,
      sourceRevision: process.env.GITHUB_SHA ?? "local",
    };
    let transport: NativeComputerTargetTransport | undefined;
    let closeReceiver = async () => {};
    let receiverStopped = true;
    t.after(async () => {
      await transport?.close();
      await closeReceiver();
      if (evidence.status === "running") evidence.status = "failed";
      if (process.env.ZENX_COMPUTER_OWNED_NATIVE_EVIDENCE)
        await writeFile(
          process.env.ZENX_COMPUTER_OWNED_NATIVE_EVIDENCE,
          JSON.stringify(evidence, null, 2),
        );
      // Keep the stop marker and diagnostics if the owned process did not exit.
      // Never delete its shutdown request or kill a PID claimed by stdout.
      if (receiverStopped)
        await rm(directory, { recursive: true, force: true });
      assert.ok(
        receiverStopped,
        "owned receiver did not terminate after stop request",
      );
    });
    evidence.stage = "compile-production-helper-and-owned-receiver";
    const helper = path.join(directory, "helper"),
      receiverBundle = path.join(directory, "OwnedReceiver.app"),
      receiver = path.join(
        receiverBundle,
        "Contents",
        "MacOS",
        "OwnedReceiver",
      );
    await mkdir(path.dirname(receiver), { recursive: true });
    await writeFile(
      path.join(receiverBundle, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>OwnedReceiver</string>
<key>CFBundleIdentifier</key><string>dev.zenx.owned-native-receiver</string>
<key>CFBundleName</key><string>ZenX Owned Receiver</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>LSUIElement</key><false/>
<key>LSBackgroundOnly</key><false/>
</dict></plist>`,
    );
    await writeFile(`${helper}.swift`, MAC_BOUND_TARGET_SOURCE);
    await writeFile(
      `${receiver}.swift`,
      await readFile(
        new URL(
          "../evals/browser-computer/macos-native-fixture.swift",
          import.meta.url,
        ),
      ),
    );
    await runProcess(
      "/usr/bin/swiftc",
      ["-O", `${helper}.swift`, "-o", helper],
      60_000,
    );
    await runProcess(
      "/usr/bin/swiftc",
      [`${receiver}.swift`, "-o", receiver],
      60_000,
    );
    const eventsPath = path.join(directory, "receiver.events.jsonl");
    const stderrPath = path.join(directory, "receiver.stderr");
    const stopPath = path.join(directory, "receiver.stop");
    await writeFile(eventsPath, "");
    // Launch a real registered app, explicitly without activating it. The helper
    // must still acquire foreground focus; fixture setup cannot satisfy its guard.
    const child = spawn(
      "/usr/bin/open",
      [
        "-g",
        "-n",
        "-W",
        "--stderr",
        stderrPath,
        receiverBundle,
        "--args",
        "--events-file",
        eventsPath,
        "--stop-file",
        stopPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.resume();
    const messages: Array<Record<string, any>> = [];
    const focusEvents: Array<Record<string, unknown>> = [];
    evidence.receiverFocusEvents = focusEvents;
    evidence.receiverLifecycleEvents = messages;
    let consumedLines = 0;
    const collectMessages = async () => {
      const lines = (await readFile(eventsPath, "utf8")).split("\n");
      // Leave any partial last line for the next read.
      for (; consumedLines < lines.length - 1; consumedLines++) {
        try {
          const message = JSON.parse(lines[consumedLines]!);
          messages.push(message);
          if (message.kind === "owned-focus-state" && focusEvents.length < 32)
            focusEvents.push(message);
        } catch {
          /* fixture stdout has no authority */
        }
      }
    };
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    closeReceiver = async () => {
      await writeFile(stopPath, "stop");
      const launcherStopped = await Promise.race([
        closed.then(() => child.exitCode === 0 && child.signalCode === null),
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5_000);
          timer.unref();
        }),
      ]);
      await collectMessages();
      // open's status is not the application's exit status. Require the owned
      // receiver's terminal lifecycle observation as well as the launcher's exit.
      receiverStopped =
        launcherStopped &&
        messages.some(
          (message) =>
            message.kind === "owned-receiver-terminating" ||
            message.kind === "owned-receiver-startup-failed",
        );
      evidence.launcherExit = {
        code: child.exitCode,
        signal: child.signalCode,
      };
      evidence.receiverShutdown = receiverStopped ? "exited" : "not-confirmed";
      if (!receiverStopped) {
        evidence.status = "failed";
        evidence.retainedFixtureDirectory = directory;
      }
      if (child.exitCode === null) child.kill("SIGTERM"); // only our open waiter
      await collectMessages();
      evidence.receiverStderr = await readFile(stderrPath, "utf8").catch(
        () => "",
      );
    };
    const waitFor = async (kind: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await collectMessages();
        const value = messages.find((message) => message.kind === kind);
        if (value) return value;
        assert.equal(
          child.exitCode,
          null,
          `owned receiver launcher exited before ${kind}; see receiverLifecycleEvents`,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw Error(`Owned receiver did not report ${kind}`);
    };
    evidence.stage = "owned-receiver-readiness";
    const ready = await waitFor("owned-receiver-ready");
    evidence.receiver = ready;
    assert.ok(Number.isInteger(ready.pid) && ready.pid > 0);
    assert.equal(
      await realpath(ready.bundlePath),
      await realpath(receiverBundle),
    );
    assert.ok(
      Number.isInteger(ready.frontmostPID) && ready.frontmostPID > 0,
      "initial foreground application must be observable",
    );
    assert.equal(
      ready.activationPolicy,
      0,
      "receiver must be a regular AppKit app",
    );
    assert.notEqual(
      ready.frontmostPID,
      ready.pid,
      "background launch must leave real focus acquisition to production helper",
    );
    transport = new NativeComputerTargetTransport(async () => helper);
    const signal = AbortSignal.timeout(25_000);
    const target = { pid: ready.pid, windowTitle: ready.windowTitle };
    evidence.stage = "production-helper-exact-selection";
    let selected: any;
    try {
      selected = await transport.request(
        { operation: "select", owner: "synthetic-owned", target },
        signal,
      );
    } catch (error) {
      const reason = String(error);
      if (!/Accessibility permission is not granted/.test(reason)) throw error;
      evidence.status = "blocked";
      evidence.missingCapability =
        "existing Accessibility trust for exact production helper (AXIsProcessTrusted=false)";
      evidence.nativeDelivery = "unverified";
      evidence.axReacquisition = "unverified";
      if (process.env.ZENX_REQUIRE_OS_INPUT === "1")
        throw Error(String(evidence.missingCapability));
      t.skip(String(evidence.missingCapability));
      return;
    }
    evidence.selection = {
      windowId: selected.windowId,
      target: selected.target,
      foregroundWindowInputAvailable: selected.foregroundWindowInputAvailable,
    };
    assert.equal(selected.windowId, ready.windowId);
    assert.equal(selected.target.pid, ready.pid);
    assert.equal(selected.target.bundleId, "dev.zenx.owned-native-receiver");
    evidence.stage = "native-drag-and-independent-receiver-readback";
    let receipt: unknown;
    try {
      receipt = await transport.request(
        {
          operation: "drag",
          owner: "synthetic-owned",
          bindingId: selected.bindingId,
          x: ready.dragStart.x,
          y: ready.dragStart.y,
          toX: ready.dragEnd.x,
          toY: ready.dragEnd.y,
        },
        signal,
      );
    } catch (error) {
      evidence.failure = String(error);
      throw error;
    }
    const delivered = await waitFor("owned-drag-received");
    assert.equal(delivered.pid, ready.pid);
    assert.equal(delivered.windowId, selected.windowId);
    assert.equal(delivered.windowTitle, target.windowTitle);
    assert.equal(delivered.downReceived, true);
    assert.equal(delivered.upReceived, true);
    assert.ok(
      delivered.draggedReceived > 0,
      "receiver must observe actual dragged events, not only posting receipts",
    );
    assert.ok(
      delivered.to.x - delivered.from.x > 100,
      "receiver observed actual movement across its own pad",
    );
    const verified: any = await transport.request(
      {
        operation: "verify",
        owner: "synthetic-owned",
        bindingId: selected.bindingId,
      },
      signal,
    );
    assert.equal(verified.windowId, selected.windowId);
    await collectMessages();
    assert.ok(
      focusEvents.some(
        (event) => event.isActive === true && event.isKeyWindow === true,
      ),
      "receiver independently observed actual activation and key-window ownership",
    );
    evidence.drag = {
      posted: receipt,
      received: delivered,
      sameWindowAfter: true,
    };

    // Real AX/CG reads using the production Binding implementation. Only the
    // retained AX cache is cleared to make reacquisition deterministic; no OS
    // attributes, permission checks, target matching or native ports are mocked.
    evidence.stage = "real-ax-cg-reacquisition-after-injected-cache-loss";
    const boundary = MAC_BOUND_TARGET_SOURCE.indexOf("var bindings:");
    assert.ok(boundary > 0);
    const reacquire = path.join(directory, "reacquire");
    await writeFile(
      `${reacquire}.swift`,
      MAC_BOUND_TARGET_SOURCE.slice(0, boundary) +
        `
guard AXIsProcessTrusted() else { emit(["kind": "blocked", "missingCapability": "Reacquisition helper Accessibility trust unavailable"]); exit(0) }
let selected = try Binding(["pid": Int(CommandLine.arguments[1])!, "windowTitle": CommandLine.arguments[2]])
let originalId = selected.windowId
guard selected.window != nil else { try refuse("Owned window did not expose AX before cache-loss injection") }
selected.window = nil
try selected.acquireMissingAXWindow()
try selected.verify()
guard selected.window != nil, selected.windowId == originalId else { try refuse("Reacquisition changed native target") }
emit(["kind": "owned-ax-reacquired", "windowId": selected.windowId, "pid": Int(selected.app.processIdentifier), "initialMissingAX": "injected_cache_loss"])
`,
    );
    await runProcess(
      "/usr/bin/swiftc",
      ["-O", `${reacquire}.swift`, "-o", reacquire],
      60_000,
    );
    const reacquired = JSON.parse(
      await runProcess(
        reacquire,
        [String(ready.pid), ready.windowTitle],
        10_000,
      ),
    );
    if (reacquired.kind === "blocked") {
      evidence.status = "blocked";
      evidence.missingCapability = reacquired.missingCapability;
      evidence.axReacquisition = "unverified";
      if (process.env.ZENX_REQUIRE_OS_INPUT === "1")
        throw Error(reacquired.missingCapability);
      t.skip(reacquired.missingCapability);
      return;
    }
    assert.equal(reacquired.windowId, selected.windowId);
    assert.equal(reacquired.pid, ready.pid);
    evidence.axReacquisition = reacquired;
    evidence.status = "passed";
    evidence.stage = "complete";
  },
);

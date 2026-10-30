import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
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
    const fixtureClosers: Array<() => Promise<void>> = [];
    let receiverStopped = true;
    t.after(async () => {
      await transport?.close();
      for (const close of fixtureClosers.reverse()) await close();
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
    const launchFixture = async (
      name: string,
      bundle: string,
      background: boolean,
    ) => {
      const eventsPath = path.join(directory, `${name}.events.jsonl`);
      const stderrPath = path.join(directory, `${name}.stderr`);
      const stopPath = path.join(directory, `${name}.stop`);
      const probePath = path.join(directory, `${name}.probe`);
      const fixtureEvidence: Record<string, unknown> = {};
      evidence[name] = fixtureEvidence;
      await writeFile(eventsPath, "");
      // A normal LaunchServices launch; only the second owned app is foregrounded.
      // Actual state is checked using fresh run-loop snapshots below.
      const child = spawn(
        "/usr/bin/open",
        [
          ...(background ? ["-g"] : []),
          "-n",
          "-W",
          "--stderr",
          stderrPath,
          bundle,
          "--args",
          "--window-title",
          `ZenX owned ${name} fixture`,
          "--focus-probe-file",
          probePath,
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
      fixtureEvidence.focusEvents = focusEvents;
      fixtureEvidence.lifecycleEvents = messages;
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
      fixtureClosers.push(async () => {
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
        const stopped =
          launcherStopped &&
          messages.some(
            (message) =>
              message.kind === "owned-receiver-terminating" ||
              message.kind === "owned-receiver-startup-failed",
          );
        fixtureEvidence.launcherExit = {
          code: child.exitCode,
          signal: child.signalCode,
        };
        fixtureEvidence.shutdown = stopped ? "exited" : "not-confirmed";
        receiverStopped = receiverStopped && stopped;
        if (!stopped) {
          evidence.status = "failed";
          evidence.retainedFixtureDirectory = directory;
        }
        if (child.exitCode === null) child.kill("SIGTERM"); // only our open waiter
        await collectMessages();
        fixtureEvidence.stderr = await readFile(stderrPath, "utf8").catch(
          () => "",
        );
      });
      const waitFor = async (kind: string, token?: string) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await collectMessages();
          const value = messages.find(
            (message) =>
              message.kind === kind &&
              (token === undefined || message.token === token),
          );
          if (value) return value;
          assert.equal(
            child.exitCode,
            null,
            `owned ${name} launcher exited before ${kind}; see lifecycleEvents`,
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw Error(`Owned ${name} did not report ${kind}`);
      };
      let probeSequence = 0;
      const probe = async () => {
        const token = String(++probeSequence);
        await writeFile(probePath, token);
        return waitFor("owned-focus-state", token);
      };
      return { waitFor, probe, fixtureEvidence };
    };
    const receiverFixture = await launchFixture(
      "receiver",
      receiverBundle,
      true,
    );
    const { waitFor } = receiverFixture;
    evidence.stage = "owned-receiver-readiness";
    const ready = await waitFor("owned-receiver-ready");
    receiverFixture.fixtureEvidence.ready = ready;
    assert.ok(Number.isInteger(ready.pid) && ready.pid > 0);
    assert.equal(
      await realpath(ready.bundlePath),
      await realpath(receiverBundle),
    );
    assert.equal(
      ready.activationPolicy,
      0,
      "receiver must be a regular AppKit app",
    );
    // AppKit launch may transiently report the new app as frontmost even with
    // open -g. Establish a controlled, observed foreground app instead of
    // asserting on the receiver's pre-settlement ready marker.
    evidence.stage = "owned-distractor-foreground-preflight";
    const distractorBundle = path.join(directory, "OwnedDistractor.app");
    await cp(receiverBundle, distractorBundle, { recursive: true });
    const distractorPlist = path.join(
      distractorBundle,
      "Contents",
      "Info.plist",
    );
    await writeFile(
      distractorPlist,
      (await readFile(distractorPlist, "utf8")).replace(
        "dev.zenx.owned-native-receiver",
        "dev.zenx.owned-native-distractor",
      ),
    );
    const distractorFixture = await launchFixture(
      "distractor",
      distractorBundle,
      false,
    );
    const distractorReady = await distractorFixture.waitFor(
      "owned-receiver-ready",
    );
    distractorFixture.fixtureEvidence.ready = distractorReady;
    assert.equal(
      await realpath(distractorReady.bundlePath),
      await realpath(distractorBundle),
    );
    assert.ok(Number.isInteger(distractorReady.pid) && distractorReady.pid > 0);
    assert.notEqual(distractorReady.pid, ready.pid);
    const preflightDeadline = Date.now() + 10_000;
    let preflight: {
      receiver: Record<string, any>;
      distractor: Record<string, any>;
    };
    while (true) {
      const [receiverState, distractorState] = await Promise.all([
        receiverFixture.probe(),
        distractorFixture.probe(),
      ]);
      preflight = { receiver: receiverState, distractor: distractorState };
      if (
        receiverState.frontmostPID === distractorReady.pid &&
        receiverState.isActive === false &&
        distractorState.frontmostPID === distractorReady.pid &&
        distractorState.isActive === true &&
        distractorState.isKeyWindow === true
      )
        break;
      assert.ok(
        Date.now() < preflightDeadline,
        `Owned distractor did not establish foreground ownership: ${JSON.stringify(preflight)}`,
      );
    }
    evidence.beforeAcquisition = preflight;
    assert.equal(preflight.receiver.pid, ready.pid);
    assert.equal(preflight.receiver.windowId, ready.windowId);
    assert.equal(preflight.distractor.windowId, distractorReady.windowId);
    assert.equal(preflight.distractor.pid, distractorReady.pid);
    assert.notEqual(preflight.receiver.frontmostPID, ready.pid);
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
      // Identify only the exact PID already reported by the failed CG fence.
      // Diagnostic failure cannot replace the original refusal or trigger input.
      const occluderPID = /occluderPID=(\d+),/.exec(String(error))?.[1];
      if (
        occluderPID &&
        Number(occluderPID) > 0 &&
        Number(occluderPID) <= 2_147_483_647
      ) {
        try {
          const identity = JSON.parse(
            await runProcess(receiver, ["--inspect-pid", occluderPID], 5_000),
          );
          assert.equal(identity.kind, "owned-occluder-identity");
          assert.equal(identity.pid, Number(occluderPID));
          evidence.occluderIdentity = identity;
        } catch {
          evidence.occluderIdentity = {
            pid: Number(occluderPID),
            available: false,
            reason: "exact_pid_identity_inspection_failed",
          };
        }
      }
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
    const afterAcquisition = await receiverFixture.probe();
    assert.equal(afterAcquisition.pid, ready.pid);
    assert.equal(afterAcquisition.windowId, selected.windowId);
    assert.equal(afterAcquisition.frontmostPID, ready.pid);
    assert.equal(afterAcquisition.isActive, true);
    assert.equal(afterAcquisition.isKeyWindow, true);
    evidence.afterAcquisition = afterAcquisition;
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

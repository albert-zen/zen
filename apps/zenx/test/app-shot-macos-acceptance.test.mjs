import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  AcceptanceError,
  preflight,
  fixtureIdentity,
  fixtureSize,
  labelFor,
  nonceColor,
  verifyPixels,
  verifyAccessibility,
  failedOutcome,
  initialReceipt,
  acceptanceExitCode,
  closeOwnedFixture,
} from "./fixtures/app-shot-macos-contract.mjs";

const nonce = "0123456789abcdef0123456789abcdef";
const gate = {
  platform: "darwin",
  hosted: true,
  enabled: true,
  exact: true,
  screen: "granted",
};
test("acceptance refuses unsupported backend and every ungranted permission before capture", () => {
  let captures = 0;
  for (const change of [
    { platform: "win32" },
    { hosted: false },
    { enabled: false },
    { exact: false },
    ...["unknown", "denied", "not-determined", "restricted", undefined].map(
      (screen) => ({ screen }),
    ),
  ]) {
    assert.throws(() => {
      preflight({ ...gate, ...change });
      captures++;
    }, AcceptanceError);
  }
  assert.equal(captures, 0);
  assert.doesNotThrow(() => preflight(gate));
});
const owned = {
  pid: 42,
  nonce,
  executable: "/private/owned.app/Contents/MacOS/fixture",
  bundle: "/private/owned.app",
};
const snapshot = {
  ...owned,
  windowId: 12,
  windowTitle: labelFor(nonce),
  token: "fresh",
  bounds: { x: 100, y: 100, ...fixtureSize },
};
test("fixture ownership requires fresh nonce, child PID, executable, bundle and complete geometry", () => {
  assert.equal(fixtureIdentity(snapshot, owned, "fresh").windowId, 12);
  for (const change of [
    { token: "old" },
    { nonce: "stale" },
    { pid: 43 },
    { executable: "/other" },
    { bundle: "/other" },
    { windowId: 0 },
    { windowTitle: "other" },
    { bounds: { ...snapshot.bounds, width: 1 } },
  ]) {
    assert.throws(
      () => fixtureIdentity({ ...snapshot, ...change }, owned, "fresh"),
      AcceptanceError,
    );
  }
});
function pattern() {
  const { width, height } = fixtureSize;
  const bitmap = Buffer.alloc(width * height * 4, 255);
  for (let index = 0; index < nonce.length; index++) {
    const [r, g, b] = nonceColor(nonce[index]);
    for (
      let y = 24 + Math.floor(index / 8) * 64;
      y < 72 + Math.floor(index / 8) * 64;
      y++
    )
      for (let x = 72 + (index % 8) * 64; x < 120 + (index % 8) * 64; x++) {
        const offset = (y * width + x) * 4;
        bitmap.set([b, g, r, 255], offset);
      }
  }
  return { width, height, bitmap };
}
test("actual decoded pixel dimensions and every nonce cell are required", () => {
  assert.equal(verifyPixels(pattern(), nonce).noncePattern, "verified");
  assert.throws(
    () => verifyPixels({ ...pattern(), width: 1 }, nonce),
    /dimensions/,
  );
  const wrong = pattern();
  wrong.bitmap.fill(255);
  assert.throws(() => verifyPixels(wrong, nonce), /nonce-pattern/);
  assert.throws(
    () => verifyPixels(pattern(), nonce.replace(/^0/, "1")),
    /nonce-pattern/,
  );
});
test("AX acceptance requires actual nonce label and image-coordinate geometry", () => {
  const payload = {
    format: "element-tree",
    coordinateSpace: "captured-image",
    imageSize: fixtureSize,
    root: {
      name: labelFor(nonce),
      bounds: { x: 0, y: 0, ...fixtureSize },
      children: [
        {
          name: labelFor(nonce),
          bounds: { x: 12, y: 284, width: 616, height: 24 },
          children: [],
        },
      ],
    },
  };
  const context = () =>
    `Accessibility semantic tree from this same window (read-only): ${JSON.stringify(payload)}`;
  assert.doesNotThrow(() => verifyAccessibility(context(), nonce, fixtureSize));
  payload.root.children[0].name = "other";
  assert.throws(
    () => verifyAccessibility(context(), nonce, fixtureSize),
    /label/,
  );
  payload.root.children[0].name = labelFor(nonce);
  payload.root.bounds.width = 1;
  assert.throws(
    () => verifyAccessibility(context(), nonce, fixtureSize),
    /bounds/,
  );
  assert.throws(
    () => verifyAccessibility("Screenshot only.", nonce, fixtureSize),
    /tree-missing/,
  );
});
test("fixture stop is requested and cleanup requires successful ChildProcess close", async () => {
  let requests = 0;
  let close;
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  const result = closeOwnedFixture(
    async () => {
      requests++;
    },
    closed,
    100,
  );
  await Promise.resolve();
  assert.equal(requests, 1);
  close({ code: 0, signal: null });
  assert.equal((await result).status, "passed");
  await assert.rejects(
    closeOwnedFixture(
      async () => {},
      Promise.resolve({ code: null, signal: "SIGKILL" }),
    ),
    /close-failed/,
  );
  await assert.rejects(
    closeOwnedFixture(async () => {}, new Promise(() => {}), 1),
    /timed-out/,
  );
});
test("blocked, crashed, skipped and unconfirmed branches never mean acceptance", () => {
  const receipt = initialReceipt();
  assert.equal(acceptanceExitCode(receipt), 2);
  assert.equal(receipt.fullNativeAcceptance, false);
  for (const key of ["pixels", "accessibility", "foreground", "cleanup"])
    receipt[key] = { status: "passed" };
  assert.equal(acceptanceExitCode(receipt), 0);
  receipt.foreground = { status: "blocked" };
  assert.equal(acceptanceExitCode(receipt), 2);
  receipt.cleanup = { status: "failed" };
  assert.equal(acceptanceExitCode(receipt), 1);
  assert.deepEqual(
    failedOutcome(new Error("private title and arbitrary stderr")),
    { status: "failed", reason: "native-operation-failed" },
  );
});
test("real harness preserves production worker/service and never requests grants or input", async () => {
  const main = await readFile(
    new URL("./fixtures/app-shot-macos-main.mjs", import.meta.url),
    "utf8",
  );
  const launcher = await readFile(
    new URL("../scripts/verify-app-shot-macos.mjs", import.meta.url),
    "utf8",
  );
  const swift = await readFile(
    new URL("./fixtures/app-shot-macos-owned.swift", import.meta.url),
    "utf8",
  );
  assert.match(main, /createElectronAppShotService\(\)/);
  assert.match(main, /isTrustedAccessibilityClient\(false\)/);
  assert.match(main, /getMediaAccessStatus\("screen"\)/);
  assert.match(main, /expectedIdentity: initial/g);
  assert.match(main, /service\.hasExactWindowSurfaceCapture/);
  assert.match(
    launcher,
    /stageAppShotRuntime\(root, appDirectory, "darwin", process\.arch\)/,
  );
  assert.match(launcher, /apps\/zenx\/out\/main\/app-shot-native-worker\.js/);
  assert.match(launcher, /apps\/zenx\/out\/main\/chunks/);
  assert.match(launcher, /require\("electron"\)/);
  assert.match(launcher, /stdio: "ignore"/);
  assert.match(launcher, /pid: fixture\.pid/);
  assert.doesNotMatch(
    main + launcher,
    /capturePage|askForMediaAccess|tccutil|System Settings|process\.kill\(|fixture\.kill\(/,
  );
  assert.doesNotMatch(
    swift,
    /CGWindowListCreateImage|CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions|\.activate\(/,
  );
});

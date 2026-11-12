// Built into a disposable Electron package, never loaded by normal ZenX.
import { app, nativeImage, systemPreferences } from "electron";
import { readFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createElectronAppShotService,
  sameObservedWindow,
} from "../../src/main/app-shot.js";
import {
  readMacActiveWindow,
  readMacWindowMetadata,
} from "../../src/main/app-shot-native.js";
import {
  AcceptanceError,
  preflight,
  fixtureIdentity,
  verifyPixels,
  verifyAccessibility,
  failedOutcome,
  initialReceipt,
  requireAcceptance,
} from "./app-shot-macos-contract.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sessionData = join(config.userData, "session");
mkdirSync(sessionData, { recursive: true, mode: 0o700 });
app.setPath("userData", config.userData);
app.setPath("sessionData", sessionData);
app.disableHardwareAcceleration();
const receipt = initialReceipt();
const service = createElectronAppShotService();
const signal = AbortSignal.timeout(35_000);
let initial;
let foregroundRequested = false;

async function freshFixture() {
  const token = randomBytes(16).toString("hex");
  await writeFile(config.probe, token, { mode: 0o600 });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !signal.aborted) {
    let value;
    try {
      const source = await readFile(config.snapshot, "utf8");
      requireAcceptance(source.length <= 8192, "fixture-marker-invalid");
      value = JSON.parse(source);
    } catch (error) {
      if (error instanceof AcceptanceError) throw error;
      if (error.code !== "ENOENT")
        throw new AcceptanceError("fixture-marker-invalid");
    }
    if (value?.token === token)
      return {
        identity: fixtureIdentity(value, config.owned, token),
        active: value.active === true,
      };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new AcceptanceError("fixture-probe-timed-out");
}
function checkPermissions() {
  preflight({
    platform: process.platform,
    hosted: process.env.GITHUB_ACTIONS === "true",
    enabled: process.env.ZENX_APP_SHOT_MACOS_ACCEPTANCE === "1",
    exact: service.hasExactWindowSurfaceCapture,
    screen: systemPreferences.getMediaAccessStatus("screen"),
  });
}
async function observedFixture() {
  const snapshot = await freshFixture();
  requireAcceptance(
    !initial || sameObservedWindow(initial, snapshot.identity),
    "fixture-identity-changed",
    true,
  );
  let metadata;
  try {
    metadata = await readMacWindowMetadata(snapshot.identity.windowId);
  } catch {
    throw new AcceptanceError("fixture-identity-unavailable", true);
  }
  requireAcceptance(
    sameObservedWindow(snapshot.identity, metadata),
    "fixture-identity-unavailable",
    true,
  );
  return snapshot;
}
async function foregroundOwnedFixture() {
  checkPermissions();
  await observedFixture();
  requireAcceptance(!signal.aborted, "fixture-foreground-cancelled", true);
  requireAcceptance(
    !foregroundRequested,
    "fixture-foreground-already-requested",
  );
  // This private launcher-owned path reaches only its nonce-bound child.
  // A failed/uncertain write is never retried and never permits capture.
  foregroundRequested = true;
  await writeFile(config.foregroundRequest, config.owned.nonce, {
    mode: 0o600,
    flag: "wx",
  });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !signal.aborted) {
    if ((await observedFixture()).active) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new AcceptanceError("fixture-not-foreground", true);
}
async function captureSelected(includeAccessibility) {
  checkPermissions();
  if (includeAccessibility)
    requireAcceptance(
      systemPreferences.isTrustedAccessibilityClient(false) === true,
      "accessibility-permission-unavailable",
      true,
    );
  await observedFixture();
  const sources = await service.listSources(); // Production metadata-only enumeration.
  const matches = sources.filter(
    (source) => source.title === initial.windowTitle,
  );
  requireAcceptance(matches.length === 1, "fixture-source-unavailable", true);
  return service.capture(matches[0].id, {
    includeAccessibility,
    expectedIdentity: initial,
    signal,
  });
}
async function validateShot(shot, name, accessibility = false) {
  requireAcceptance(
    shot?.mediaType === "image/png" &&
      shot.bytes?.length > 32 &&
      shot.bytes.length <= 20 * 1024 * 1024,
    "png-missing",
  );
  const bytes = Buffer.from(shot.bytes);
  const image = nativeImage.createFromBuffer(bytes);
  requireAcceptance(!image.isEmpty(), "png-decode-failed");
  const size = image.getSize();
  requireAcceptance(
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(16) === size.width &&
      bytes.readUInt32BE(20) === size.height,
    "png-dimensions-invalid",
  );
  const verified = verifyPixels(
    { ...size, bitmap: image.toBitmap() },
    config.owned.nonce,
  );
  if (accessibility)
    verifyAccessibility(shot.context, config.owned.nonce, size);
  await observedFixture();
  // Only bytes that passed the owned nonce and fresh identity fences leave scratch.
  await writeFile(join(config.artifacts, name), bytes, { mode: 0o600 });
  return {
    status: "passed",
    ...verified,
    ...(accessibility ? { label: "verified", bounds: "matched-image" } : {}),
  };
}
async function branch(key, operation) {
  try {
    receipt[key] = await operation();
  } catch (error) {
    receipt[key] = failedOutcome(error);
  }
}
async function runAcceptance() {
  try {
    await app.whenReady();
    requireAcceptance(
      Boolean(process.versions.electron) &&
        app.getAppPath() === config.appDirectory,
      "electron-package-invalid",
    );
    checkPermissions();
    initial = (await observedFixture()).identity;
    await branch("pixels", async () =>
      validateShot(await captureSelected(false), "selected.png"),
    );
    if (receipt.pixels.status === "passed") {
      await branch("accessibility", async () =>
        validateShot(await captureSelected(true), "accessibility.png", true),
      );
      await branch("foreground", async () => {
        checkPermissions();
        await foregroundOwnedFixture();
        const fresh = await observedFixture();
        requireAcceptance(fresh.active, "fixture-not-foreground", true);
        let active;
        try {
          active = await readMacActiveWindow();
        } catch {
          throw new AcceptanceError("fixture-not-foreground", true);
        }
        requireAcceptance(
          sameObservedWindow(initial, active),
          "fixture-not-foreground",
          true,
        );
        const verified = await validateShot(
          await service.captureActive({
            expectedIdentity: initial,
            includeAccessibility: false,
            signal,
          }),
          "foreground.png",
        );
        return { ...verified, activation: "owned-fixture-once" };
      });
    } else {
      receipt.accessibility = {
        status: "blocked",
        reason: "pixels-not-accepted",
      };
      receipt.foreground = { status: "blocked", reason: "pixels-not-accepted" };
    }
  } catch (error) {
    receipt.pixels = failedOutcome(error);
    receipt.accessibility = {
      status: "blocked",
      reason: "preflight-not-accepted",
    };
    receipt.foreground = {
      status: "blocked",
      reason: "preflight-not-accepted",
    };
  } finally {
    await mkdir(config.userData, { recursive: true });
    await writeFile(config.result, JSON.stringify(receipt), { mode: 0o600 });
    app.exit(0); // Launcher computes acceptance only after owned fixture close.
  }
}

// Electron waits for ESM evaluation before emitting ready. Do not await this task here.
void runAcceptance().catch(() => app.exit(1));

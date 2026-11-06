// Test-only receipts. Never serialize native error messages, titles or AX payloads.
export const fixtureSize = { width: 640, height: 320 };
export const labelFor = (nonce) => `App Shot owned ${nonce}`;
export class AcceptanceError extends Error {
  constructor(code, blocked = false) {
    super(code);
    this.code = code;
    this.blocked = blocked;
  }
}
export function requireAcceptance(condition, code, blocked = false) {
  if (!condition) throw new AcceptanceError(code, blocked);
}
export function preflight({ platform, hosted, enabled, exact, screen }) {
  requireAcceptance(
    platform === "darwin" && hosted && enabled,
    "opt-in-required",
    true,
  );
  requireAcceptance(exact === true, "exact-backend-unavailable", true);
  requireAcceptance(
    screen === "granted",
    "screen-permission-unavailable",
    true,
  );
}
export function fixtureIdentity(snapshot, owned, token) {
  requireAcceptance(snapshot?.token === token, "fixture-marker-invalid");
  requireAcceptance(
    snapshot.pid === owned.pid &&
      snapshot.nonce === owned.nonce &&
      snapshot.windowTitle === labelFor(owned.nonce) &&
      snapshot.executable === owned.executable &&
      snapshot.bundle === owned.bundle &&
      Number.isSafeInteger(snapshot.windowId) &&
      snapshot.windowId > 0 &&
      snapshot.bounds?.width === fixtureSize.width &&
      snapshot.bounds?.height === fixtureSize.height &&
      Number.isFinite(snapshot.bounds?.x) &&
      Number.isFinite(snapshot.bounds?.y),
    "fixture-identity-unavailable",
    true,
  );
  return {
    windowId: snapshot.windowId,
    windowTitle: snapshot.windowTitle,
    pid: snapshot.pid,
    bounds: snapshot.bounds,
  };
}
export function nonceColor(character) {
  const n = Number.parseInt(character, 16);
  return [40 + (n & 3) * 60, n & 4 ? 220 : 40, n & 8 ? 220 : 40];
}
// NativeImage supplies actual decoded BGRA bytes, not header-only dimensions.
export function verifyPixels({ width, height, bitmap }, nonce) {
  requireAcceptance(/^[a-f0-9]{32}$/.test(nonce), "fixture-marker-invalid");
  const scale = width / fixtureSize.width;
  requireAcceptance(
    scale >= 1 &&
      scale <= 4 &&
      height === fixtureSize.height * scale &&
      bitmap.length === width * height * 4,
    "png-dimensions-invalid",
  );
  for (let index = 0; index < nonce.length; index++) {
    const expected = nonceColor(nonce[index]);
    for (const dx of [-8, 0, 8])
      for (const dy of [-8, 0, 8]) {
        const x = Math.floor((64 + (index % 8) * 64 + 32 + dx) * scale);
        const y = Math.floor(
          (16 + Math.floor(index / 8) * 64 + 32 + dy) * scale,
        );
        const offset = (y * width + x) * 4;
        requireAcceptance(
          expected.every(
            (value, channel) =>
              Math.abs(bitmap[offset + 2 - channel] - value) <= 14,
          ) && bitmap[offset + 3] === 255,
          "png-nonce-pattern-invalid",
        );
      }
  }
  return { width, height, noncePattern: "verified" };
}
export function verifyAccessibility(context, nonce, size) {
  const line = context
    .split("\n")
    .find((value) =>
      value.startsWith("Accessibility semantic tree from this same window"),
    );
  requireAcceptance(Boolean(line), "accessibility-tree-missing");
  let tree;
  try {
    tree = JSON.parse(line.slice(line.indexOf(": ") + 2));
  } catch {
    throw new AcceptanceError("accessibility-tree-invalid");
  }
  requireAcceptance(
    tree.format === "element-tree" &&
      tree.coordinateSpace === "captured-image" &&
      tree.imageSize.width === size.width &&
      tree.imageSize.height === size.height &&
      tree.root.bounds?.x === 0 &&
      tree.root.bounds?.y === 0 &&
      tree.root.bounds?.width === size.width &&
      tree.root.bounds?.height === size.height,
    "accessibility-image-bounds-invalid",
  );
  const stack = [tree.root];
  let matched = false;
  let count = 0;
  while (stack.length && count++ < 10000) {
    const node = stack.pop();
    if (
      node !== tree.root &&
      [node.name, node.value, node.description].includes(labelFor(nonce)) &&
      node.bounds?.width > 0 &&
      node.bounds?.height > 0 &&
      node.bounds.x >= 0 &&
      node.bounds.y >= 0 &&
      node.bounds.x + node.bounds.width <= size.width &&
      node.bounds.y + node.bounds.height <= size.height
    )
      matched = true;
    stack.push(...node.children);
  }
  requireAcceptance(
    matched && stack.length === 0,
    "accessibility-label-missing",
  );
}
export function failedOutcome(error) {
  // Only this module's fixed codes are exportable. Native diagnostics stay private.
  return {
    status:
      error instanceof AcceptanceError && error.blocked ? "blocked" : "failed",
    reason:
      error instanceof AcceptanceError ? error.code : "native-operation-failed",
  };
}
export function initialReceipt() {
  return {
    schema: 1,
    scope: "owned-synthetic-macos-app-shot",
    permissionChanges: false,
    pixels: { status: "not-run" },
    accessibility: { status: "not-run" },
    foreground: { status: "not-run" },
    cleanup: { status: "not-run" },
    fullNativeAcceptance: false,
  };
}
export function acceptanceExitCode(receipt) {
  const states = [
    receipt.pixels,
    receipt.accessibility,
    receipt.foreground,
    receipt.cleanup,
  ];
  receipt.fullNativeAcceptance = states.every(
    (outcome) => outcome.status === "passed",
  );
  return receipt.fullNativeAcceptance
    ? 0
    : states.some((outcome) => outcome.status === "failed")
      ? 1
      : 2;
}

export async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new AcceptanceError("owned-process-timed-out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function closeOwnedFixture(
  requestStop,
  closed,
  milliseconds = 5000,
) {
  await requestStop();
  const outcome = await bounded(closed, milliseconds);
  requireAcceptance(
    outcome.code === 0 && outcome.signal === null,
    "fixture-close-failed",
  );
  return {
    status: "passed",
    fixtureClose: "confirmed-owned-child",
    stop: "private-file",
  };
}

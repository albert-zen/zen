import assert from "node:assert/strict";
import { BrowserInputOutcomeUnknownError } from "../../src/main/capabilities/browser-targeted-input.js";

export interface NativeFrameIdentity {
  url: string;
  processId: number;
  osProcessId: number;
  routingId: number;
}
export interface NativeInputAttempt {
  method: string;
  type: string;
  sessionId: string;
  x?: number;
  y?: number;
}
export interface NativeChildRoute {
  sessionId: string;
  parentSessionId: string;
  targetId: string;
  url: string;
}

export function assertNativeFramePlacement(
  frames: NativeFrameIdentity[],
  mode: "nested-oopif" | "nested-same-process",
  urls: string[],
): void {
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((frame) => frame.url),
    urls,
  );
  for (const frame of frames) {
    assert.ok(Number.isSafeInteger(frame.processId) && frame.processId > 0);
    assert.ok(Number.isSafeInteger(frame.osProcessId) && frame.osProcessId > 0);
  }
  assert.notEqual(frames[0]!.processId, frames[1]!.processId);
  assert.notEqual(frames[0]!.osProcessId, frames[1]!.osProcessId);
  if (mode === "nested-oopif") {
    assert.notEqual(frames[1]!.processId, frames[2]!.processId);
    assert.notEqual(frames[1]!.osProcessId, frames[2]!.osProcessId);
  } else {
    assert.equal(frames[1]!.processId, frames[2]!.processId);
    assert.equal(frames[1]!.osProcessId, frames[2]!.osProcessId);
    assert.notEqual(frames[1]!.routingId, frames[2]!.routingId);
  }
}

export function assertNativeInputRoute(
  inputs: NativeInputAttempt[],
  routes: NativeChildRoute[],
  mode: "nested-oopif" | "nested-same-process",
  urls: string[],
  kind: "click" | "key",
): void {
  const outer = routes.filter((route) => route.url === urls[1]);
  assert.equal(outer.length, 1, "One exact native outer child attachment");
  assert.equal(outer[0]!.parentSessionId, "");
  assert.ok(outer[0]!.sessionId && outer[0]!.targetId);
  const leaf = routes.filter((route) => route.url === urls[2]);
  if (mode === "nested-oopif") {
    assert.equal(leaf.length, 1, "One exact nested native child attachment");
    assert.equal(leaf[0]!.parentSessionId, outer[0]!.sessionId);
    assert.notEqual(leaf[0]!.sessionId, outer[0]!.sessionId);
  } else assert.equal(leaf.length, 0, "Same-renderer leaf has no native route");
  const selected = mode === "nested-oopif" ? leaf[0]! : outer[0]!;
  assert.deepEqual(
    inputs.map(({ method, type, sessionId }) => ({ method, type, sessionId })),
    (kind === "click"
      ? ["mousePressed", "mouseReleased"]
      : ["keyDown", "keyUp"]
    ).map((type) => ({
      method:
        kind === "click"
          ? "Input.dispatchMouseEvent"
          : "Input.dispatchKeyEvent",
      type,
      sessionId: kind === "click" ? selected.sessionId : "",
    })),
  );
  if (kind === "click")
    for (const input of inputs) {
      // Canvas center (100,30); same-renderer leaf additionally has the authored
      // owner inset (45,55). Outer affine transform must not be applied twice.
      assert.ok(
        Math.abs(input.x! - (mode === "nested-oopif" ? 100 : 145)) < 0.01,
      );
      assert.ok(
        Math.abs(input.y! - (mode === "nested-oopif" ? 30 : 85)) < 0.01,
      );
    }
}

/** Scalar-only passive receipts from the synthetic native fixture transport. */
export function nativeFrameCommandReceipt(
  method: string,
  params: Record<string, unknown>,
  response: unknown,
): Record<string, unknown> | undefined {
  if (
    ![
      "Page.createIsolatedWorld",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "Runtime.evaluate",
    ].includes(method)
  )
    return;
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const text = (value: unknown, limit = 512): string | undefined =>
    typeof value === "string" ? value.slice(0, limit) : undefined;
  const result = object(response),
    runtime = object(result.result),
    exception = object(result.exceptionDetails);
  const declaration = text(params.functionDeclaration, 16_384) ?? "";
  const label = declaration.includes("const ownerEntry")
    ? "ancestor-chain"
    : declaration.includes("Browser iframe parent viewport")
      ? "owner-witness"
      : declaration.includes("closed shadow candidate")
        ? "closed-shadow-registration"
        : method;
  const value = object(runtime.value),
    snapshot = object(value.inputSnapshot ?? runtime.value);
  return {
    method,
    label,
    ...(params.contextId === undefined ? {} : { contextId: params.contextId }),
    ...(params.uniqueContextId === undefined
      ? {}
      : { uniqueContextId: text(params.uniqueContextId) }),
    ...(params.executionContextId === undefined
      ? {}
      : { executionContextId: params.executionContextId }),
    ...(params.objectId === undefined
      ? {}
      : { objectId: text(params.objectId) }),
    ...(method === "Page.createIsolatedWorld"
      ? {
          frameId: text(params.frameId),
          worldName: text(params.worldName),
          createdContextId: result.executionContextId,
        }
      : {}),
    ...(method === "DOM.resolveNode"
      ? {
          resolvedObjectId: text(object(result.object).objectId),
          nodeDescription: text(object(result.object).description, 256),
        }
      : {}),
    ...(typeof snapshot.documentKey === "string"
      ? {
          snapshot: {
            documentKey: text(snapshot.documentKey),
            localFrame: snapshot.localFrame,
            frameOwnerScanComplete: snapshot.frameOwnerScanComplete,
            frameOwnerIds: Array.isArray(snapshot.frameOwnerIds)
              ? snapshot.frameOwnerIds.slice(0, 32).map((id) => text(id, 128))
              : undefined,
            viewport: Object.fromEntries(
              [
                "width",
                "height",
                "deviceScaleFactor",
                "scrollX",
                "scrollY",
                "visualScale",
                "visualOffsetX",
                "visualOffsetY",
              ]
                .filter((key) =>
                  Number.isFinite(object(snapshot.viewport)[key]),
                )
                .map((key) => [key, object(snapshot.viewport)[key]]),
            ),
          },
        }
      : {}),
    ...(result.exceptionDetails === undefined
      ? {}
      : {
          exception: {
            text: text(exception.text),
            description: text(
              object(exception.exception).description ?? runtime.description,
              2048,
            ),
          },
        }),
  };
}

/** Search every fixture-owned native View tree; an incomplete tree is no proof. */
export function nativeViewOwnerIndices<
  T extends { readonly children: readonly T[] },
>(roots: readonly T[], target: T): number[] {
  assert.ok(
    roots.length <= 16,
    "Native window tree count exceeds fixture bound",
  );
  const seen = new Set<T>();
  const owners: number[] = [];
  const pending = roots.map((view, owner) => ({ view, owner, depth: 0 }));
  while (pending.length) {
    const { view, owner, depth } = pending.pop()!;
    assert.ok(depth <= 16, "Native view tree depth exceeds fixture bound");
    assert.ok(
      !seen.has(view),
      "Native view tree contains a cycle or duplicate",
    );
    seen.add(view);
    assert.ok(seen.size <= 128, "Native view tree size exceeds fixture bound");
    if (view === target) owners.push(owner);
    const children = view.children;
    assert.ok(
      children.length <= 128,
      "Native child count exceeds fixture bound",
    );
    for (const child of children)
      pending.push({ view: child, owner, depth: depth + 1 });
  }
  return owners;
}

export interface NativeFramePresentation {
  provider: "workspace-browser" | "electron-browser";
  webContentsId: number;
  sentinelWindowId: number;
  focusedWindowId: number | null;
  backgroundThrottling: boolean;
  viewWebContentsId?: number;
  viewVisible?: boolean;
  displays: { x: number; y: number; width: number; height: number }[];
  owners: {
    id: number;
    ownsTargetContents: boolean;
    visible: boolean;
    focused: boolean;
    focusable: boolean;
    opacity: number;
    intersectsDisplay: boolean;
    bounds: { x: number; y: number; width: number; height: number };
  }[];
}

/**
 * Electron Page Visibility is not native hiddenness when throttling is off.
 * https://www.electronjs.org/docs/latest/api/browser-window#page-visibility
 */
export function assertNativeFramePresentation(
  value: NativeFramePresentation,
  phase: "idle" | "dispatch",
): void {
  assert.equal(value.backgroundThrottling, false);
  assert.equal(value.focusedWindowId, value.sentinelWindowId);
  assert.ok(
    Number.isSafeInteger(value.webContentsId) && value.webContentsId > 0,
  );
  if (value.provider === "workspace-browser") {
    assert.equal(value.viewWebContentsId, value.webContentsId);
    if (phase === "idle") {
      assert.equal(
        value.viewVisible,
        false,
        "Unmounted target view must be natively invisible between operations",
      );
      assert.equal(
        value.owners.length,
        0,
        "No native window may retain the unmounted target outside its render lease",
      );
      return;
    }
    assert.equal(
      value.viewVisible,
      true,
      "Input uses the exact temporarily rendered view",
    );
  }
  assert.equal(
    value.owners.length,
    1,
    "Exactly one native owner may hold this target",
  );
  const owner = value.owners[0]!;
  assert.notEqual(owner.id, value.sentinelWindowId);
  assert.equal(owner.focused, false);
  assert.equal(owner.focusable, false);
  if (value.provider === "electron-browser") {
    assert.equal(owner.ownsTargetContents, true);
    assert.equal(
      owner.visible,
      false,
      "The exact Electron target window must stay hidden",
    );
  } else {
    assert.equal(
      owner.ownsTargetContents,
      false,
      "The render host lends a view, never becomes the target WebContents",
    );
    assert.equal(
      owner.opacity,
      0,
      "The Workspace render host must remain transparent",
    );
    assert.ok(value.displays.length > 0);
    assert.ok(
      [
        owner.bounds.x,
        owner.bounds.y,
        owner.bounds.width,
        owner.bounds.height,
      ].every(Number.isFinite),
    );
    assert.ok(owner.bounds.width > 0 && owner.bounds.height > 0);
    // AppKit can constrain the requested offscreen window onto a display.
    // Native alphaValue (getOpacity), not placement, proves transparency.
    // https://github.com/electron/electron/blob/v43.0.0/shell/browser/ui/cocoa/electron_ns_window.mm#L257
    // https://github.com/electron/electron/blob/v43.0.0/shell/browser/native_window_mac.mm#L1180
  }
}

/** The two production adapters expose different, exact post-dispatch boundaries. */
export function assertNativeInputQuarantineError(
  provider: "workspace-browser" | "electron-browser",
  error: unknown,
): void {
  let inputError = error;
  if (provider === "workspace-browser") {
    assert.ok(error instanceof Error);
    assert.equal(Object.getPrototypeOf(error), Error.prototype);
    assert.ok(error.cause instanceof BrowserInputOutcomeUnknownError);
    assert.equal(
      error.message,
      `Browser action outcome is unknown after dispatch: ${error.cause.message}. Inspect before continuing; do not repeat it automatically`,
    );
    inputError = error.cause;
  }
  assert.ok(inputError instanceof BrowserInputOutcomeUnknownError);
  assert.equal(inputError.inputMayRemainPressed, true);
}

/** Preserve the original boundary before any assertion can replace its error. */
export function nativeInputErrorReceipt(
  error: unknown,
): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let current = error;
  for (let depth = 0; depth < 3 && current !== undefined; depth++) {
    if (!(current instanceof Error)) {
      chain.push({ value: String(current).slice(0, 2048) });
      break;
    }
    chain.push({
      name: current.name.slice(0, 128),
      message: current.message.slice(0, 2048),
      stack: current.stack?.slice(0, 4096),
      typedInputOutcomeUnknown:
        current instanceof BrowserInputOutcomeUnknownError,
      ...(current instanceof BrowserInputOutcomeUnknownError
        ? {
            inputMayRemainPressed: current.inputMayRemainPressed,
          }
        : {}),
    });
    current = current.cause;
  }
  return chain;
}

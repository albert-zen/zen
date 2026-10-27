import {
  COMPUTER_OCR_BUDGET_MS,
  COMPUTER_OCR_MAX_IMAGE_PIXELS,
  MAC_OCR_SOURCE,
  computerOcrLanguages,
  parseComputerOcrRecognition,
  type ComputerOcrRecognition,
} from "./computer-ocr.js";
import { ComputerTargetSession } from "./computer-target-session.js";
import { NativeComputerTargetTransport } from "./computer-target-transport.js";
import type { ForegroundActivityRunner } from "../foreground-activity.js";
import type { ComputerEnvironmentPort } from "../automation-environment.js";
import { COMPUTER_PLUGIN_VERSION } from "../../../../../packages/zenx-computer-plugin/src/version.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  constants as fsConstants,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ToolInvocation } from "../../../../../src/tool.js";
import type { ZenXPluginManifestV2, ZenXCapabilityPackage } from "./types.js";
import {
  ComputerThreadObservation,
  type ComputerThreadListener,
  type ComputerThreadRequest,
} from "./computer-thread-observation.js";
import { observeComputerWindow } from "./computer-electron-observation.js";
import {
  ObservationPresentation,
  observationReadOptions,
  observationReadProperties,
  MAX_OBSERVATION_PAGE_BYTES,
} from "./observation-presentation.js";
import {
  OBSERVATION_CAPTURE,
  type ObservationCapture,
} from "./observation-capture.js";

export const COMPUTER_SHORTCUT_KEYS = [
  ...Array.from("abcdefghijklmnopqrstuvwxyz0123456789"),
  "enter",
  "escape",
  "tab",
  "backspace",
  "space",
  "arrowUp",
  "arrowDown",
  "arrowLeft",
  "arrowRight",
];

export interface ComputerTarget {
  pid?: number;
  applicationId?: string;
  bundleId?: string;
  windowTitle?: string;
}

export interface ComputerControlSelector {
  observationId: string;
  targetId: string;
}

const NATIVE_TARGETED_ACCESSIBILITY_TOOLS = [
  "computer_list_windows",
  "computer_inspect",
  "computer_press",
  "computer_set_value",
] as const;

export const COMPUTER_ACTION_PRESS = "press";
export const COMPUTER_ACTION_SET_VALUE = "set_value";
export type ComputerControlAction =
  typeof COMPUTER_ACTION_PRESS | typeof COMPUTER_ACTION_SET_VALUE;

/** Ephemeral position of a successful semantic action in its exact window. */
export interface ComputerActionPointer {
  x: number;
  y: number;
  action: ComputerControlAction;
  capturedAt: string;
  windowWidth: number;
  windowHeight: number;
  windowId?: number;
}

export interface ComputerInspection {
  [OBSERVATION_CAPTURE]?: ObservationCapture<
    ComputerInspection["controls"][number]
  >;
  platform: NodeJS.Platform;
  observationId: string;
  target: {
    pid: number;
    applicationId?: string;
    bundleId?: string;
    applicationName: string;
    windowTitle?: string;
  };
  controls: Array<{
    selector: ComputerControlSelector;
    role: string;
    title: string;
    enabled: boolean;
    actions: ComputerControlAction[];
  }>;
  truncated: boolean;
  diagnostics?: ComputerInspectionDiagnostics;
  visualTextFallback?: string;
}

export interface ComputerInspectionDiagnostics {
  visitedCount: number;
  visitLimit: number;
  visitLimitReached: boolean;
  maxDepth: number;
  maxDepthVisited: number;
  depthLimitReached: boolean;
  outputLimit: number;
  outputLimitReached: boolean;
  selectionLimit: number;
  selectionLimitReached: boolean;
  actionableCount: number;
  semanticCount: number;
  fallbackCount: number;
  encounteredWebArea: boolean;
  webAreaControlCount: number;
  webAreaActionableCount: number;
  nativeRead?: {
    status: "complete" | "partial";
    readCount: number;
    errorCount: number;
    errorCodes: number[];
    deadlineReached: boolean;
    elapsedMs: number;
    budgetMs: number;
  };
}

export interface ComputerLiveObservationFrame {
  sequence: number;
  mimeType: "image/jpeg";
  data: string;
  width: number;
  height: number;
  capturedAt: string;
  windowWidth?: number;
  windowHeight?: number;
  windowId?: number;
}

export type ComputerLiveObservationEvent =
  | {
      type: "status";
      status: "idle" | "connecting" | "live" | "unavailable" | "failed";
      message: string;
    }
  | { type: "frame"; frame: ComputerLiveObservationFrame };

export type ComputerLiveObservationListener = (
  event: ComputerLiveObservationEvent,
) => void;

export interface ComputerOcrInspection extends ComputerOcrRecognition {
  target: ComputerInspection["target"];
  bindingId: string;
  captureId: string;
  capturedAt: string;
  expiresAt: string;
  coordinateSpace: "screenshot_pixels_top_left";
  observationOnly: true;
}

export interface ZenXComputerBackend {
  /** Host-native AX implementation only; never inferred from plugin manifest capabilities. */
  readonly nativeTargetedAccessibility?: true;
  /** Explicit bundled native window-local implementation; no provider inference. */
  readonly nativeWindowInput?: true;
  /** Invalidate provider-owned native selectors after desktop state changes. */
  invalidateObservations?(): void;
  invalidateTargetObservations?(target: ComputerTarget): void;
  ocr?(
    target: ComputerTarget,
    captureId: string,
    languages: string[],
    owner: string,
    signal: AbortSignal,
  ): Promise<ComputerOcrInspection>;

  readonly targetSession?: ComputerTargetSession;
  observeWindow?(
    target: ComputerTarget,
    listener: ComputerLiveObservationListener,
  ): () => void;
  listWindows?(
    query: string | undefined,
    signal?: AbortSignal,
  ): Promise<ComputerWindowList>;
  inspect(
    target: ComputerTarget,
    signal?: AbortSignal,
  ): Promise<ComputerInspection>;
  press(
    target: ComputerTarget,
    control: ComputerControlSelector,
    signal?: AbortSignal,
    onStopping?: () => void,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
    pointer?: ComputerActionPointer;
  }>;
  setValue(
    target: ComputerTarget,
    control: ComputerControlSelector,
    value: string,
    signal?: AbortSignal,
    onStopping?: () => void,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
    characterCount: number;
    valueReadback?: {
      matchesRequested: boolean;
      source: "native_value_pattern" | "native_ax_value";
    };
    pointer?: ComputerActionPointer;
  }>;
  screenshot(
    target: ComputerTarget,
    signal?: AbortSignal,
    owner?: string,
  ): Promise<{
    artifactPath: string;
    target: ComputerInspection["target"];
    width: number;
    height: number;
    bytes: number;
    expiresAt: string;
  }>;
  foregroundClick(
    x: number,
    y: number,
    button: "left" | "right",
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<void>;
  foregroundKeyPress(
    key: ComputerKey,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<void>;
  foregroundScroll(
    deltaY: number,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<void>;
  close(): Promise<void> | void;
}

export interface ComputerWindowList {
  windows: Array<{ target: ComputerTarget; applicationName: string }>;
  truncated: boolean;
}

export function selectComputerWindows(
  targets: ComputerInspection["target"][],
  query?: string,
): ComputerWindowList {
  const matching = targets.filter(
    (target) =>
      target.windowTitle !== undefined &&
      (query === undefined ||
        `${target.pid} ${target.applicationName} ${target.windowTitle}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  return {
    windows: matching
      .slice(0, 32)
      .map(({ applicationName, ...target }) => ({ target, applicationName })),
    truncated: matching.length > 32,
  };
}

export type ComputerKey =
  | "enter"
  | "escape"
  | "tab"
  | "backspace"
  | "space"
  | "arrowUp"
  | "arrowDown"
  | "arrowLeft"
  | "arrowRight";

export const MAX_COMPUTER_INSPECTION_CONTROLS = 32;

/** Preserve source order within each tier while keeping preferred semantics visible. */
export function selectComputerInspectionControls<T>(
  controls: readonly T[],
  actionable: (control: T) => boolean,
  preferred: (control: T) => boolean = () => false,
): T[] {
  if (controls.length <= MAX_COMPUTER_INSPECTION_CONTROLS) return [...controls];
  const actionableFlags = controls.map(actionable);
  const preferredFlags = controls.map(preferred);
  const selected = new Set<number>();
  const tiers = [
    (index: number) => preferredFlags[index] && actionableFlags[index],
    (index: number) => preferredFlags[index] && !actionableFlags[index],
    (index: number) => !preferredFlags[index] && actionableFlags[index],
    (index: number) => !preferredFlags[index] && !actionableFlags[index],
  ];
  for (const tier of tiers) {
    for (let index = 0; index < controls.length; index += 1) {
      if (selected.size === MAX_COMPUTER_INSPECTION_CONTROLS) break;
      if (tier(index)) selected.add(index);
    }
  }
  return controls.filter((_, index) => selected.has(index));
}

export const computerCapabilityManifest: ZenXPluginManifestV2 = {
  schemaVersion: 2,
  id: "computer",
  name: "Computer",
  version: COMPUTER_PLUGIN_VERSION,
  description:
    "Negotiated macOS desktop operations: targeted accessibility actions where supported and explicitly labeled, cancellable foreground takeover as the reliable baseline.",
  compatibility: { zenx: ">=0.1.0 <0.2.0" },
  runtime: { type: "bundled", entry: "zenx/computer" },
  mainDocument:
    "If available, start with computer_list_windows; its query filters windows only. Otherwise use the supplied exact window target. Prefer a returned exact window ref with computer_inspect; providers without discovery accept an explicit native window target. Inspect coverage and follow nextCursor alone to read the immutable captured controls beyond the first page; native traversal omissions remain explicit and are not recoverable by paging. References express exact-fingerprint presentation continuity, not proven native object identity. Actions use exact control refs and native revalidation. Pass since with a retained observation ref for a diff; omit since or set full:true after context compaction/lost context. For retained controls, pass the control ref with an explicit latest observation ref; native action checks still decide freshness. Cursor pages do not replace the first-page diff baseline or renew action authority. Discard prior continuation pages on every new observation or first-page diff and follow its new nextCursor for tails. Prefer background-safe semantic controls.",
  provider: {
    id: "macos-desktop",
    platforms: ["darwin"],
    interactionModes: ["background_safe", "foreground_required"],
    capabilities: [
      "window.list",
      "desktop.environment.read",
      "accessibility.inspect",
      "semantic.press",
      "semantic.set_value",
      "window.capture",
      "foreground.pointer",
      "foreground.keyboard",
      "foreground.scroll",
    ],
  },
  permissions: [
    {
      id: "computer.accessibility.inspect",
      title: "Inspect a targeted app",
      description:
        "Read a bounded accessibility tree for an explicitly targeted app or window.",
      scope: "local-device",
    },
    {
      id: "computer.accessibility.act",
      title: "Act on a targeted control",
      description:
        "Perform a semantic press or set a semantic value on an explicitly selected accessibility control without global input.",
      scope: "local-device",
    },
    {
      id: "computer.window.capture",
      title: "Capture a targeted window",
      description:
        "Capture one explicitly targeted app window to a private short-lived artifact.",
      scope: "local-device",
    },
    {
      id: "computer.foreground.control",
      title: "Control the foreground desktop",
      description:
        "Use global pointer, keyboard, focus, or scrolling. ZenX exposes these as explicitly labeled, cancellable foreground takeover.",
      scope: "local-device",
    },
  ],
  tools: [
    {
      name: "computer_environment",
      description:
        "Read the current desktop session and power availability. lockedTools names this provider’s scoped capabilities while locked; re-inspect for fresh controls and treat native failures as failures. Window capture and foreground input require an active session. This read does not wake, unlock, or operate another app.",
      inputSchema: objectSchema({}, []),
      permissions: ["computer.accessibility.inspect"],
      interactionMode: "background_safe",
      capabilities: ["desktop.environment.read", "no_global_input"],
      maxOutputBytes: 4096,
    },
    {
      name: "computer_list_windows",
      description:
        "List up to 32 open desktop windows and their running applications without activating them. Pass a case-insensitive query matching application name, PID, or title to narrow truncated results. Use its returned window ref with computer_inspect; this is not a catalog of installed apps.",
      inputSchema: objectSchema(
        { query: { type: "string", minLength: 1, maxLength: 256 } },
        [],
      ),
      permissions: ["computer.accessibility.inspect"],
      interactionMode: "background_safe",
      capabilities: ["window.list", "no_global_input"],
      maxOutputBytes: 1024 * 1024,
    },
    {
      name: "computer_inspect",
      description:
        "Inspect a bounded first page of at most 32 controls in one exact app window, or follow nextCursor without recapture. Coverage separately reports available pages and native omissions; this is not a complete accessibility tree. Model callers use since with an exact observation ref to request a diff; omit it or set full:true to resync. target.windowTitle is required.",
      inputSchema: objectSchema(
        {
          target: targetSchema(),
          ...observationReadProperties,
          query: { type: "string", minLength: 1, maxLength: 128 },
          limit: { type: "integer", minimum: 1, maximum: 32 },
        },
        ["target"],
      ),
      permissions: ["computer.accessibility.inspect"],
      interactionMode: "background_safe",
      capabilities: [
        "accessibility.inspect",
        "app_targeted",
        "no_global_input",
      ],
      maxOutputBytes: MAX_OBSERVATION_PAGE_BYTES,
    },
    {
      name: "computer_press",
      description:
        "Perform a native semantic press on one control returned by computer_inspect. Does not move the pointer, type keys, or activate the target app.",
      inputSchema: objectSchema(
        {
          target: targetSchema(),
          control: controlSchema(),
          observe: { type: "boolean" },
          baseObservationId: { type: "string" },
          full: { type: "boolean" },
        },
        ["target", "control"],
      ),
      permissions: ["computer.accessibility.act"],
      interactionMode: "background_safe",
      capabilities: ["semantic.press", "app_targeted", "no_global_input"],
    },
    {
      name: "computer_set_value",
      description:
        "Set the supplied text on one editable opaque target from the latest computer_inspect observation. The value follows the ordinary tool path and host/model policy decides how it is handled.",
      inputSchema: objectSchema(
        {
          target: targetSchema(),
          control: controlSchema(),
          value: stringSchema(),
          observe: { type: "boolean" },
          baseObservationId: { type: "string" },
          full: { type: "boolean" },
        },
        ["target", "control", "value"],
      ),
      permissions: ["computer.accessibility.act"],
      interactionMode: "background_safe",
      capabilities: ["semantic.set_value", "app_targeted", "no_global_input"],
    },
    {
      name: "computer_screenshot",
      description:
        "Capture one explicit app/window target to a private five-minute PNG artifact. Returns metadata/path, never pixels in the Thread journal.",
      inputSchema: objectSchema({ target: targetSchema() }, ["target"]),
      permissions: ["computer.window.capture"],
      interactionMode: "background_safe",
      capabilities: ["window.capture", "app_targeted", "no_global_input"],
      maxOutputBytes: 4 * 1024,
    },
    ...foregroundTools(),
  ],
};

/** Native-only replacement; other providers retain their separate capability contract. */
export const boundComputerCapabilityManifest: ZenXPluginManifestV2 = {
  ...structuredClone(computerCapabilityManifest),
  version: COMPUTER_PLUGIN_VERSION,
  provider: {
    ...computerCapabilityManifest.provider!,
    capabilities: [
      ...computerCapabilityManifest.provider!.capabilities,
      "window.ocr",
      "window.background_click",
    ],
  },
  mainDocument:
    computerCapabilityManifest.mainDocument +
    " Native macOS global input requires this thread's selected target. computer_select_target or computer_screenshot selects one exact window; it does not activate it. Input activates and checks that same window after approval. Click x/y are screenshot image pixels and require its captureId, not desktop coordinates. Key/scroll/type/shortcut require the bindingId returned by select/screenshot; reuse it without a screenshot per key, so pending approval cannot silently follow a later selection. After stale geometry, closed target, cancelled or uncertain input, reselect/reobserve; never replay an uncertain action automatically. A full desktop image never selects a target. Other providers do not inherit this binding guarantee. When AX is empty or partial, explicitly capture the same window then call computer_ocr with that captureId for local visual text. OCR boxes are not accessibility controls and do not authorize semantic press. OCR never activates, wakes or unlocks the desktop.",
  permissions: [
    ...computerCapabilityManifest.permissions,
    {
      id: "computer.window.background_click",
      title: "Click inside a background window",
      description:
        "Send one left click to an exact captured window without desktop foreground or pointer takeover; application-internal focus may change.",
      scope: "local-device",
    },
  ],
  tools: [
    {
      name: "computer_background_click",
      description:
        "Left-click x/y image pixels of this thread's current exact-window screenshot without desktop activation, raising or pointer movement. Native macOS active session only; uses a runtime-checked window-local primitive and separate permission. Consumes the capture. Application-internal focus may change. Posted/release receipts do not verify application effect; never retry unknown input automatically.",
      inputSchema: objectSchema(
        {
          target: targetSchema(),
          bindingId: stringSchema(),
          captureId: stringSchema(),
          x: { type: "number" },
          y: { type: "number" },
        },
        ["target", "bindingId", "captureId", "x", "y"],
      ),
      permissions: ["computer.window.background_click"],
      interactionMode: "background_safe",
      capabilities: [
        "window.background_click",
        "app_targeted",
        "no_global_input",
        "capture_bound",
        "cancellable",
      ],
    },
    ...computerCapabilityManifest.tools.map((tool) =>
      tool.name === "computer_foreground_click"
        ? {
            ...tool,
            description:
              "FOREGROUND TAKEOVER: click image-pixel x/y in this thread's selected exact window. Requires current window screenshot captureId; validates window/focus immediately before native posting.",
            inputSchema: objectSchema(
              {
                x: { type: "number" },
                y: { type: "number" },
                button: { type: "string", enum: ["left", "right"] },
                captureId: stringSchema(),
              },
              ["x", "y", "captureId"],
            ),
          }
        : tool.name.startsWith("computer_foreground_")
          ? {
              ...tool,
              inputSchema: {
                ...tool.inputSchema,
                properties: {
                  ...(tool.inputSchema.properties as Record<string, unknown>),
                  bindingId: stringSchema(),
                },
                required: [
                  ...(tool.inputSchema.required as string[]),
                  "bindingId",
                ],
              },
            }
          : tool,
    ),
    {
      name: "computer_foreground_type",
      description:
        "FOREGROUND TAKEOVER: type up to 1024 Unicode scalars into this thread's selected exact window using Unicode keyboard events, without clipboard access. Does not guarantee application acceptance. Partial/cancelled input must not be replayed automatically; no text is echoed in the receipt.",
      inputSchema: objectSchema(
        {
          text: { type: "string", minLength: 1, maxLength: 1024 },
          bindingId: stringSchema(),
        },
        ["text", "bindingId"],
      ),
      permissions: ["computer.foreground.control"],
      interactionMode: "foreground_required",
      capabilities: [
        "global_input",
        "may_change_focus",
        "cancellable",
        "target_bound",
      ],
    },
    {
      name: "computer_foreground_shortcut",
      description:
        "FOREGROUND TAKEOVER: send one shortcut to this thread's selected exact window. key is a logical unshifted letter/digit in the current Command layout when command is present, otherwise the current base layout; modifiers apply separately. Navigation keys are layout-independent. Missing or ambiguous character mappings/input-source changes fail closed; no ANSI fallback.",
      inputSchema: objectSchema(
        {
          bindingId: stringSchema(),
          key: { type: "string", enum: COMPUTER_SHORTCUT_KEYS },
          modifiers: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: {
              type: "string",
              enum: ["command", "control", "option", "shift"],
            },
          },
        },
        ["key", "modifiers", "bindingId"],
      ),
      permissions: ["computer.foreground.control"],
      interactionMode: "foreground_required",
      capabilities: [
        "global_input",
        "may_change_focus",
        "cancellable",
        "target_bound",
      ],
    },
    {
      name: "computer_ocr",
      description:
        "Read local visual text from this thread's current exact-window screenshot, with original capture time and top-left image-pixel boxes. Explicit ten-second read, not an automatic AX fallback. Up to 96 text boxes/16 KiB text; requires an image at most 4 MP. Default languages zh-Hans then en-US; Chinese/English requests are normalized Chinese-first; returned languages report the effective order. Unsupported languages/combinations fail explicitly. Observations only, never AX controls or proof a click works. No recapture, foreground activation, wake, unlock or cloud OCR.",
      inputSchema: objectSchema(
        {
          target: targetSchema(),
          captureId: stringSchema(),
          languages: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: { type: "string", maxLength: 32 },
          },
        },
        ["target", "captureId"],
      ),
      permissions: ["computer.window.capture"],
      interactionMode: "background_safe",
      capabilities: ["window.ocr", "app_targeted", "no_global_input"],
      maxOutputBytes: 64 * 1024,
    },
    {
      name: "computer_select_target",
      description:
        "Select this thread's exact application/window for subsequent foreground input without activating it. Supply an exact listed window target; application-only targets must resolve to exactly one window.",
      inputSchema: objectSchema({ target: targetSchema() }, ["target"]),
      permissions: ["computer.accessibility.inspect"],
      interactionMode: "background_safe",
      capabilities: ["app_targeted", "no_global_input"],
    },
  ],
};

export class ComputerZenXCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest: ZenXPluginManifestV2;
  readonly #backend: ZenXComputerBackend;
  readonly #threadObservation: ComputerThreadObservation;
  readonly #presentation = new ObservationPresentation<
    ComputerInspection["controls"][number]
  >({
    itemsField: "controls",
    changesField: "controlChanges",
    pageItems: 32,
    identityKind: "exact-fingerprint-presentation",
    getId: (control) => control.selector.targetId,
    withId: (control, targetId) => ({
      ...control,
      selector: { ...control.selector, targetId },
    }),
    withObservationId: (control, observationId) => ({
      ...control,
      selector: { ...control.selector, observationId },
    }),
  });
  readonly #foregroundActivity?: ForegroundActivityRunner;
  #foregroundControlAllowed: boolean;
  #foregroundConsent = new AbortController();
  #observationGeneration = 0;
  readonly #environment?: ComputerEnvironmentPort;
  readonly #stopEnvironmentObservation?: () => void;

  constructor(
    backend: ZenXComputerBackend,
    manifest?: ZenXPluginManifestV2,
    foregroundControlAllowed = false,
    foregroundActivity?: ForegroundActivityRunner,
    environment?: ComputerEnvironmentPort,
  ) {
    this.#backend = backend;
    this.#foregroundActivity = foregroundActivity;
    this.#environment = environment;
    this.#stopEnvironmentObservation = environment?.onInvalidated(() =>
      this.invalidateObservations(),
    );
    this.#threadObservation = new ComputerThreadObservation(
      backend,
      () => !environment || environment.snapshot().sessionState === "active",
    );
    this.manifest =
      manifest ??
      (backend.targetSession
        ? boundComputerCapabilityManifest
        : computerCapabilityManifest);
    this.#foregroundControlAllowed = foregroundControlAllowed;
    if (!foregroundControlAllowed) this.#revokeForegroundConsent();
  }

  setForegroundControlAllowed(allowed: boolean): void {
    if (allowed === this.#foregroundControlAllowed) return;
    this.#foregroundControlAllowed = allowed;
    if (allowed) this.#foregroundConsent = new AbortController();
    else this.#revokeForegroundConsent();
  }

  /** Environment lock/suspend fence: retire observations without closing the provider. */
  invalidateObservations(): void {
    this.#observationGeneration++;
    this.#presentation.invalidateAll();
    this.#threadObservation.invalidateFrames();
    this.#backend.invalidateObservations?.();
    this.#backend.targetSession?.invalidateSelections();
  }

  async invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    const foregroundAtStart =
      toolName.startsWith("computer_foreground_") ||
      this.manifest.tools.some(
        (tool) =>
          tool.name === toolName &&
          tool.interactionMode === "foreground_required",
      )
        ? this.#foregroundConsent.signal
        : undefined;
    if (foregroundAtStart) this.#assertForegroundControlAllowed(toolName);
    if (this.#environment?.refresh) await this.#environment.refresh();
    foregroundAtStart?.throwIfAborted();
    invocation.signal.throwIfAborted();
    // Derive actual locked capability from the selected Host backend, never from
    // a model argument or a background_safe plugin manifest alone.
    const lockedTools =
      this.#backend.nativeTargetedAccessibility === true
        ? NATIVE_TARGETED_ACCESSIBILITY_TOOLS.filter(
            (name) =>
              !this.manifest.tools.some(
                (tool) =>
                  tool.name === name &&
                  tool.interactionMode === "foreground_required",
              ),
          )
        : [];
    if (toolName === "computer_environment") {
      const snapshot = this.#environment?.snapshot();
      return snapshot
        ? {
            ...snapshot,
            lockedUse: lockedTools.length
              ? "native-targeted-accessibility"
              : "unsupported",
            lockedTools,
          }
        : {
            platform: process.platform,
            sessionState: "unknown",
            revision: 0,
            lockedUse: "unsupported",
            lockedTools: [],
            reason: "Computer environment monitoring is unavailable",
          };
    }
    const nativeAccessibility = lockedTools.some((name) => name === toolName);
    const lease = this.#environment?.acquire(
      invocation.signal,
      nativeAccessibility
        ? "native-targeted-accessibility"
        : "interactive-desktop",
    );
    const lockedAccessibilityAction =
      nativeAccessibility &&
      this.#environment?.snapshot().sessionState === "locked" &&
      (toolName === "computer_press" || toolName === "computer_set_value");
    const admitted = lease
      ? {
          ...invocation,
          signal: lease.signal,
          arguments: lockedAccessibilityAction
            ? { ...invocation.arguments, observe: true }
            : invocation.arguments,
        }
      : invocation;
    let settle: (() => void) | undefined;
    try {
      const candidate = admitted.arguments.target;
      const explicitTarget =
        candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? requiredTarget(admitted.arguments)
          : undefined;
      const expectedBindingId = admitted.arguments.bindingId;
      const selectedTarget =
        toolName.startsWith("computer_foreground_") &&
        typeof expectedBindingId === "string" &&
        this.#backend.targetSession
          ? this.#backend.targetSession.selectedTarget(
              requiredComputerOwner(admitted),
              expectedBindingId,
            )
          : undefined;
      const target = explicitTarget ?? selectedTarget;
      settle =
        admitted.threadId && target
          ? this.#threadObservation.startActivity(
              admitted.threadId,
              admitted.callId,
              target,
              toolName.startsWith("computer_foreground_") ||
                this.manifest.tools.some(
                  (tool) =>
                    tool.name === toolName &&
                    tool.interactionMode === "foreground_required",
                )
                ? "foreground"
                : "background-window",
            )
          : undefined;
      const result = await this.#invoke(toolName, admitted);
      if (lease && this.#environment?.snapshot().revision !== lease.revision) {
        if (
          result &&
          typeof result === "object" &&
          ((result as Record<string, unknown>).actionCompleted === true ||
            (result as Record<string, unknown>).dispatch === "posted" ||
            (result as Record<string, unknown>).dispatch === "completed")
        ) {
          const { after: _after, ...completed } = result as Record<
            string,
            unknown
          >;
          return {
            ...completed,
            observationError:
              "Computer environment changed after dispatch; fresh observation required",
            nextAction:
              "Inspect the exact target; do not repeat the action automatically",
          };
        }
        throw new Error(
          "Computer environment changed before observation completed; inspect again",
        );
      }
      return result;
    } finally {
      settle?.();
      lease?.release();
    }
  }

  async #invoke(
    toolName: string,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    invocation.signal.throwIfAborted();
    const observationGeneration = this.#observationGeneration;
    if (toolName === "computer_list_windows") {
      const query = optionalString(invocation.arguments, "query");
      if (query !== undefined && query.length > 256)
        throw new Error("query is limited to 256 characters");
      if (this.#backend.listWindows === undefined)
        throw new Error(
          "This Computer provider does not support window discovery",
        );
      return await this.#backend.listWindows(query, invocation.signal);
    }
    if (toolName === "computer_select_target") {
      if (!this.#backend.targetSession)
        throw new Error(
          "This provider does not support bound target selection",
        );
      return await this.#backend.targetSession.select(
        requiredComputerOwner(invocation),
        requiredTarget(invocation.arguments),
        invocation.signal,
      );
    }
    if (toolName.startsWith("computer_foreground_")) {
      return await this.#invokeForeground(toolName, invocation);
    }
    const target = requiredTarget(invocation.arguments);
    if (toolName === "computer_background_click") {
      const session = this.#backend.targetSession;
      if (!session || this.#backend.nativeWindowInput !== true)
        throw new Error(
          "This provider does not implement window-local background click; no input dispatched",
        );
      if (
        !this.#environment ||
        this.#environment.snapshot().sessionState !== "active"
      )
        throw new Error(
          "Background click requires verified active desktop monitoring; no input dispatched",
        );
      this.#presentation.invalidate(
        JSON.stringify([
          invocation.threadId ?? null,
          computerTargetKey(target),
        ]),
      );
      this.#backend.invalidateTargetObservations?.(target);
      const receipt = await session.backgroundClick(
        requiredComputerOwner(invocation),
        target,
        requiredString(invocation.arguments, "bindingId"),
        requiredString(invocation.arguments, "captureId"),
        requiredFiniteNumber(invocation.arguments, "x"),
        requiredFiniteNumber(invocation.arguments, "y"),
        invocation.signal,
      );
      return {
        action: "background_click",
        ...(receipt as Record<string, unknown>),
      };
    }
    const key = JSON.stringify([
      invocation.threadId ?? null,
      computerTargetKey(target),
    ]);
    // Decide from the actual selected service before consuming observations or
    // dispatching either semantic mutation; stale profile metadata cannot grant
    // foreground effects, and targeted UIA is not necessarily focus-isolated.
    const foregroundRequired =
      (toolName === "computer_press" || toolName === "computer_set_value") &&
      this.manifest.tools.some(
        (tool) =>
          tool.name === toolName &&
          tool.interactionMode === "foreground_required",
      );
    let signal = invocation.signal;
    if (foregroundRequired) {
      this.#assertForegroundControlAllowed(toolName);
      signal = AbortSignal.any([signal, this.#foregroundConsent.signal]);
    }
    let result: unknown;
    switch (toolName) {
      case "computer_inspect": {
        requireScopedWindow(target, "computer_inspect");
        const options = observationReadOptions(invocation.arguments);
        if (options.cursor !== undefined) {
          if (
            invocation.arguments.query !== undefined ||
            invocation.arguments.limit !== undefined
          )
            throw new Error(
              "Cursor already binds its captured scope; omit query and limit",
            );
          result = await this.#presentation.read(
            key,
            options.cursor,
            invocation.signal,
          );
          break;
        }
        const inspected = await this.#backend.inspect(
          target,
          invocation.signal,
        );
        if (observationGeneration !== this.#observationGeneration)
          throw new Error(
            "Computer desktop state changed during inspection; inspect again",
          );
        const {
          controls,
          [OBSERVATION_CAPTURE]: captured,
          ...header
        } = inspected;
        let capture: ObservationCapture<
          ComputerInspection["controls"][number]
        > = captured ?? {
          scopeKey: computerTargetKey(inspected.target),
          entries: controls.map((value) => ({ value })),
          coverage: {
            scope: "backend-provided bounded window observation",
            sourceComplete: null,
            reasons: ["backend_capture_coverage_unknown"],
          },
        };
        const focus = computerInspectionFocus(invocation.arguments, capture);
        capture = focus.capture;
        const presentedHeader: Record<string, unknown> = {
          ...header,
          ...(focus.description === undefined
            ? {}
            : { focus: focus.description }),
        };
        result = this.#presentation.publish(
          key,
          inspected.observationId,
          presentedHeader,
          capture,
          options,
        );
        break;
      }
      case "computer_press": {
        requireScopedWindow(target, "computer_press");
        const control = requiredControl(invocation.arguments);
        const execute = async (
          signal: AbortSignal,
          onStopping?: () => void,
        ) => {
          if (foregroundRequired)
            this.#assertForegroundControlAllowed(toolName);
          const native = await this.#actionControl(
            key,
            control,
            invocation.threadId !== undefined,
            signal,
          );
          this.#presentation.invalidate(key);
          this.#backend.targetSession?.invalidateCaptures();
          return {
            ...(await this.#backend.press(target, native, signal, onStopping)),
            control,
            ...(foregroundRequired ? { impact: "foreground_takeover" } : {}),
            dispatch: "completed",
            applicationEffect: "unverified",
          };
        };
        result = foregroundRequired
          ? await this.#withForegroundActivity(invocation, signal, execute)
          : await execute(signal);
        break;
      }
      case "computer_set_value": {
        requireScopedWindow(target, "computer_set_value");
        const value = requiredString(invocation.arguments, "value", true);
        if (value.length > 4_000) {
          throw new Error("computer_set_value is limited to 4000 characters");
        }
        const control = requiredControl(invocation.arguments);
        const execute = async (
          signal: AbortSignal,
          onStopping?: () => void,
        ) => {
          if (foregroundRequired)
            this.#assertForegroundControlAllowed(toolName);
          const native = await this.#actionControl(
            key,
            control,
            invocation.threadId !== undefined,
            signal,
          );
          this.#presentation.invalidate(key);
          this.#backend.targetSession?.invalidateCaptures();
          return {
            ...(await this.#backend.setValue(
              target,
              native,
              value,
              signal,
              onStopping,
            )),
            control,
            ...(foregroundRequired ? { impact: "foreground_takeover" } : {}),
            dispatch: "completed",
            applicationEffect: "unverified",
          };
        };
        result = foregroundRequired
          ? await this.#withForegroundActivity(invocation, signal, execute)
          : await execute(signal);
        break;
      }
      case "computer_ocr":
        requireScopedWindow(target, "computer_ocr");
        if (!this.#backend.ocr)
          throw new Error(
            "Local OCR is unavailable for this Computer provider/platform",
          );
        result = await this.#backend.ocr(
          target,
          requiredString(invocation.arguments, "captureId"),
          computerOcrLanguages(invocation.arguments.languages),
          requiredComputerOwner(invocation),
          invocation.signal,
        );
        break;
      case "computer_screenshot":
        if (target.windowTitle === undefined) {
          throw new Error("computer_screenshot requires target.windowTitle");
        }
        result = await this.#backend.screenshot(
          target,
          invocation.signal,
          this.#backend.targetSession
            ? requiredComputerOwner(invocation)
            : undefined,
        );
        break;
      default:
        throw new Error(`Unsupported computer tool: ${toolName}`);
    }
    if (
      (toolName === "computer_press" || toolName === "computer_set_value") &&
      invocation.arguments.observe === true &&
      result &&
      typeof result === "object"
    ) {
      const completed = result as Record<string, unknown>;
      try {
        const inspected = await this.#backend.inspect(
          target,
          invocation.signal,
        );
        if (observationGeneration !== this.#observationGeneration)
          throw new Error("Computer desktop state changed after action");
        const {
          controls,
          [OBSERVATION_CAPTURE]: captured,
          ...header
        } = inspected;
        let capture: ObservationCapture<
          ComputerInspection["controls"][number]
        > = captured ?? {
          scopeKey: computerTargetKey(inspected.target),
          entries: controls.map((value) => ({ value })),
          coverage: {
            scope: "backend-provided bounded window observation",
            sourceComplete: null,
            reasons: ["backend_capture_coverage_unknown"],
          },
        };
        const observationOptions = observationReadOptions(invocation.arguments);
        if (observationOptions.cursor !== undefined)
          throw new Error("Action follow-up cannot continue an old cursor");
        const focused =
          observationOptions.baseObservationId === undefined &&
          observationOptions.full !== true;
        let presentedHeader: Record<string, unknown> = header;
        if (focused) {
          const view = computerActionFollowupCapture(
            capture,
            requiredControl(invocation.arguments),
          );
          capture = view.capture;
          presentedHeader = { ...header, focus: view.description };
        }
        result = {
          ...completed,
          actionCompleted: true,
          after: this.#presentation.publish(
            key,
            inspected.observationId,
            presentedHeader,
            capture,
            focused ? { full: true } : observationOptions,
          ),
        };
      } catch (error) {
        result = {
          ...completed,
          actionCompleted: true,
          observationError:
            error instanceof Error ? error.message : String(error),
          nextAction:
            "Inspect the exact window again; do not repeat the completed action automatically",
        };
      }
    }
    if (
      invocation.threadId !== undefined &&
      observationGeneration === this.#observationGeneration &&
      !invocation.signal.aborted
    ) {
      const resolved =
        result && typeof result === "object" && "target" in result
          ? ((result as { target: ComputerTarget }).target ?? target)
          : target;
      this.#threadObservation.publish(
        invocation.threadId,
        invocation.callId,
        resolved,
        toolName === "computer_press" || toolName === "computer_set_value"
          ? (result as { pointer?: ComputerActionPointer }).pointer
          : undefined,
      );
    }
    // The cursor belongs to the transient observation, never the canonical tool result.
    if (
      (toolName === "computer_press" || toolName === "computer_set_value") &&
      result &&
      typeof result === "object"
    ) {
      const { pointer: _pointer, ...canonical } = result as Record<
        string,
        unknown
      >;
      return canonical;
    }
    return result;
  }

  async #actionControl(
    key: string,
    control: ComputerControlSelector,
    owned: boolean,
    signal?: AbortSignal,
  ): Promise<ComputerControlSelector> {
    if (!owned && !this.#presentation.has(key)) return control;
    return {
      ...control,
      targetId: await this.#presentation.resolveAction(
        key,
        control.observationId,
        control.targetId,
        signal,
      ),
    };
  }

  observeThread(
    request: ComputerThreadRequest,
    listener: ComputerThreadListener,
  ): () => void {
    return this.#threadObservation.observe(request, listener);
  }

  async #invokeForeground(
    toolName: string,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    this.#assertForegroundControlAllowed(toolName);
    // Freeze intent before waiting for activity arbitration or its visible notice.
    const selectedBindingId = this.#backend.targetSession?.selectedBindingId(
      requiredComputerOwner(invocation),
    );
    if (
      this.#backend.targetSession &&
      toolName !== "computer_foreground_click" &&
      requiredString(invocation.arguments, "bindingId") !== selectedBindingId
    ) {
      throw new Error(
        "bindingId no longer matches this thread's selected target; no input dispatched",
      );
    }
    const signal = AbortSignal.any([
      invocation.signal,
      this.#foregroundConsent.signal,
    ]);
    switch (toolName) {
      case "computer_foreground_click": {
        const x = requiredFiniteNumber(invocation.arguments, "x");
        const y = requiredFiniteNumber(invocation.arguments, "y");
        const button = optionalString(invocation.arguments, "button") ?? "left";
        if (button !== "left" && button !== "right") {
          throw new Error("button must be left or right");
        }
        await this.#withForegroundActivity(
          invocation,
          signal,
          async (signal, onStopping) => {
            this.#assertForegroundControlAllowed(toolName);
            this.#presentation.invalidateAll();
            if (this.#backend.targetSession) {
              await this.#backend.targetSession.input(
                requiredComputerOwner(invocation),
                {
                  operation: "click",
                  x,
                  y,
                  button,
                  captureId: requiredString(invocation.arguments, "captureId"),
                },
                signal,
                onStopping,
                selectedBindingId,
                this.#foregroundActivity?.pointerPassthroughWindowIds?.() ?? [],
              );
              return;
            }
            await this.#backend.foregroundClick(
              x,
              y,
              button,
              signal,
              onStopping,
            );
          },
        );
        return {
          action: "click",
          x,
          y,
          button,
          impact: "foreground_takeover",
          ...(this.#backend.targetSession
            ? { dispatch: "posted", applicationEffect: "unverified" }
            : {}),
        };
      }
      case "computer_foreground_key_press": {
        const key = requiredComputerKey(invocation.arguments);
        await this.#withForegroundActivity(
          invocation,
          signal,
          async (signal, onStopping) => {
            this.#assertForegroundControlAllowed(toolName);
            this.#presentation.invalidateAll();
            if (this.#backend.targetSession) {
              await this.#backend.targetSession.input(
                requiredComputerOwner(invocation),
                { operation: "key", key },
                signal,
                onStopping,
                selectedBindingId,
              );
              return;
            }
            await this.#backend.foregroundKeyPress(key, signal, onStopping);
          },
        );
        return {
          action: "key_press",
          key,
          impact: "foreground_takeover",
          ...(this.#backend.targetSession
            ? { dispatch: "posted", applicationEffect: "unverified" }
            : {}),
        };
      }
      case "computer_foreground_type":
      case "computer_foreground_shortcut": {
        const session = this.#backend.targetSession;
        if (!session)
          throw new Error(
            "This provider does not support bound native keyboard input",
          );
        const action =
          toolName === "computer_foreground_type"
            ? {
                operation: "type" as const,
                text: requiredComputerTypingText(invocation.arguments),
              }
            : {
                operation: "shortcut" as const,
                ...requiredComputerShortcut(invocation.arguments),
              };
        await this.#withForegroundActivity(
          invocation,
          signal,
          async (signal, onStopping) => {
            this.#assertForegroundControlAllowed(toolName);
            this.#presentation.invalidateAll();
            await session.input(
              requiredComputerOwner(invocation),
              action,
              signal,
              onStopping,
              selectedBindingId,
            );
          },
        );
        return {
          action: action.operation,
          ...(action.operation === "type"
            ? { characterCount: Array.from(action.text).length }
            : { key: action.key, modifiers: action.modifiers }),
          impact: "foreground_takeover",
          dispatch: "posted",
          applicationEffect: "unverified",
        };
      }
      case "computer_foreground_scroll": {
        const deltaY = requiredFiniteNumber(invocation.arguments, "deltaY");
        if (deltaY === 0 || Math.abs(deltaY) > 10_000) {
          throw new Error(
            "deltaY must be non-zero and between -10000 and 10000",
          );
        }
        await this.#withForegroundActivity(
          invocation,
          signal,
          async (signal, onStopping) => {
            this.#assertForegroundControlAllowed(toolName);
            this.#presentation.invalidateAll();
            if (this.#backend.targetSession) {
              await this.#backend.targetSession.input(
                requiredComputerOwner(invocation),
                { operation: "scroll", deltaY },
                signal,
                onStopping,
                selectedBindingId,
                this.#foregroundActivity?.pointerPassthroughWindowIds?.() ?? [],
              );
              return;
            }
            await this.#backend.foregroundScroll(deltaY, signal, onStopping);
          },
        );
        return {
          action: "scroll",
          deltaY,
          impact: "foreground_takeover",
          ...(this.#backend.targetSession
            ? { dispatch: "posted", applicationEffect: "unverified" }
            : {}),
        };
      }
      default:
        throw new Error(`Unsupported foreground computer tool: ${toolName}`);
    }
  }

  async #withForegroundActivity<T>(
    invocation: ToolInvocation,
    signal: AbortSignal,
    operation: (signal: AbortSignal, onStopping?: () => void) => Promise<T>,
  ): Promise<T> {
    const execute = async (signal: AbortSignal, onStopping?: () => void) => {
      await foregroundTakeoverNotice(signal);
      signal.throwIfAborted();
      return await operation(signal, onStopping);
    };
    if (this.#foregroundActivity) {
      return await this.#foregroundActivity.run(
        { ...invocation, signal },
        execute,
      );
    } else {
      // Non-desktop provider tests and explicitly owned native smoke fixtures.
      return await execute(signal);
    }
  }

  #assertForegroundControlAllowed(toolName: string): void {
    if (this.#foregroundControlAllowed) return;
    throw new Error(
      `${toolName} is foreground_required; enable Foreground computer control in ZenX Settings before use`,
    );
  }

  #revokeForegroundConsent(): void {
    this.#foregroundConsent.abort(
      new Error(
        "Foreground computer control was revoked; foreground_required operation cancelled",
      ),
    );
  }

  async close(): Promise<void> {
    this.#stopEnvironmentObservation?.();
    this.#presentation.close();
    this.#threadObservation.close();
    await this.#backend.close();
  }
}

export interface ComputerControlFingerprint {
  identifier?: string;
  role?: string;
  subrole?: string;
  title?: string;
  description?: string;
  help?: string;
  frame?: string;
  actions: ComputerControlAction[];
}

interface ComputerObservation {
  observationId: string;
  targetIdentity?: string;
  targets: Map<string, ComputerControlFingerprint>;
  readOnlyReason?: string;
}

export class ComputerObservationLedger {
  readonly #latest = new Map<string, ComputerObservation>();

  /** Revokes only future actions for this exact target, never in-flight work. */
  beginObservation(targetKey: string): string {
    const observationId = randomUUID();
    this.#latest.set(targetKey, { observationId, targets: new Map() });
    return observationId;
  }

  observe(
    targetKey: string,
    fingerprints: ComputerControlFingerprint[],
    targetIdentity?: string,
    options: { pendingId?: string; readOnlyReason?: string } = {},
  ): { observationId: string; selectors: ComputerControlSelector[] } {
    if (
      options.pendingId !== undefined &&
      this.#latest.get(targetKey)?.observationId !== options.pendingId
    )
      throw new Error(
        "Computer inspection was superseded; inspect the target again",
      );
    const observationId = randomUUID();
    const targets = new Map<string, ComputerControlFingerprint>();
    const selectors = fingerprints.map((fingerprint) => {
      const targetId = randomUUID();
      targets.set(targetId, fingerprint);
      return { observationId, targetId };
    });
    this.#latest.set(targetKey, {
      observationId,
      targets,
      targetIdentity,
      ...(options.readOnlyReason === undefined
        ? {}
        : { readOnlyReason: options.readOnlyReason }),
    });
    return { observationId, selectors };
  }

  consume(
    targetKey: string,
    selector: ComputerControlSelector,
    action: ComputerControlAction,
    targetIdentity?: string,
  ): ComputerControlFingerprint {
    const observation = this.#latest.get(targetKey);
    if (
      observation === undefined ||
      observation.observationId !== selector.observationId ||
      observation.targetIdentity !== targetIdentity
    ) {
      throw new Error(
        "Computer observation is stale, unknown, or scoped to another target; inspect the target again",
      );
    }
    const fingerprint = observation.targets.get(selector.targetId);
    if (fingerprint === undefined) {
      throw new Error("Computer target ID is forged, stale, or unknown");
    }
    if (observation.readOnlyReason !== undefined)
      throw new Error(observation.readOnlyReason);
    if (
      action === COMPUTER_ACTION_PRESS &&
      !fingerprint.actions.includes(COMPUTER_ACTION_PRESS)
    ) {
      throw new Error(
        "Control no longer supports background-safe semantic press; foreground_required",
      );
    }
    if (action === COMPUTER_ACTION_SET_VALUE) {
      if (!fingerprint.actions.includes(COMPUTER_ACTION_SET_VALUE)) {
        throw new Error(
          "Control no longer supports background-safe semantic set value; foreground_required",
        );
      }
    }
    this.#latest.delete(targetKey);
    return fingerprint;
  }

  assertCurrent(targetKey: string, observationId: string): void {
    if (this.#latest.get(targetKey)?.observationId !== observationId) {
      throw new Error(
        "Computer observation is stale, consumed, or unknown; inspect the target again",
      );
    }
  }

  clear(): void {
    this.#latest.clear();
  }
}

/** Exact presentation continuity only; repeated fingerprints prove no identity. */
export function uniqueComputerCaptureEntries<T>(
  values: readonly T[],
  identities: readonly string[],
): Array<{ value: T; identity?: string }> {
  const counts = new Map<string, number>();
  for (const identity of identities) {
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return values.map((value, index) => {
    const identity = identities[index];
    return {
      value,
      ...(identity !== undefined && counts.get(identity) === 1
        ? { identity }
        : {}),
    };
  });
}

interface MacRawControl {
  selector: {
    identifier?: string;
    role?: string;
    subrole?: string;
    title?: string;
    description?: string;
    help?: string;
    frame?: string;
  };
  role: string;
  title: string;
  enabled: boolean;
  actions: string[];
  inWebArea: boolean;
}

const MAC_CONTAINER_ROLES = new Set([
  "AXWindow",
  "AXGroup",
  "AXToolbar",
  "AXScrollArea",
  "AXSplitGroup",
  "AXWebArea",
  "AXLayoutArea",
  "AXLayoutItem",
]);

function preferredMacWebControl(control: MacRawControl): boolean {
  if (!control.inWebArea) return false;
  return (
    canonicalComputerActions(control.actions).length > 0 ||
    (control.title.length > 0 && !MAC_CONTAINER_ROLES.has(control.role))
  );
}

interface MacInspectionResult {
  target: ComputerInspection["target"];
  targetContext: Record<string, string | number>;
  controls: MacRawControl[];
  truncated: boolean;
  diagnostics: Omit<
    ComputerInspectionDiagnostics,
    "selectionLimit" | "selectionLimitReached"
  >;
}

function rawControlFingerprint(
  control: MacRawControl,
): ComputerControlFingerprint {
  return {
    ...control.selector,
    actions: canonicalComputerActions(control.actions),
  };
}

function macCaptureIdentity(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

function canonicalComputerActions(
  actions: readonly string[],
): ComputerControlAction[] {
  const canonical: ComputerControlAction[] = [];
  if (actions.includes("AXPress")) canonical.push(COMPUTER_ACTION_PRESS);
  if (actions.includes("AXSetValue")) {
    canonical.push(COMPUTER_ACTION_SET_VALUE);
  }
  return canonical;
}

function semanticControlSelector(
  fingerprint: ComputerControlFingerprint,
): Record<string, string> {
  const { actions: _actions, ...selector } = fingerprint;
  return selector;
}

function computerTargetKey(target: ComputerTarget): string {
  return JSON.stringify({
    pid: target.pid ?? null,
    applicationId: target.applicationId ?? null,
    bundleId: target.bundleId ?? null,
    windowTitle: target.windowTitle ?? null,
  });
}

function computerInspectionFocus(
  args: Readonly<Record<string, unknown>>,
  capture: ObservationCapture<ComputerInspection["controls"][number]>,
): {
  capture: ObservationCapture<ComputerInspection["controls"][number]>;
  description?: {
    query?: string;
    limit?: number;
    scanned: number;
    matched: number;
  };
} {
  const query = args.query;
  if (
    query !== undefined &&
    (typeof query !== "string" || query.length < 1 || query.length > 128)
  )
    throw new Error("Computer inspect query must be 1–128 characters");
  const limit = args.limit;
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 32)
  )
    throw new Error("Computer inspect limit must be an integer from 1 to 32");
  if (query === undefined && limit === undefined) return { capture };
  const matched =
    query === undefined
      ? capture.entries
      : capture.entries.filter(({ value }) =>
          `${value.role} ${value.title}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        );
  const entries =
    limit === undefined ? matched : matched.slice(0, Number(limit));
  const limitTruncated = entries.length < matched.length;
  return {
    capture: {
      ...capture,
      scopeKey: JSON.stringify([
        capture.scopeKey,
        "computer-inspect-focus",
        query ?? null,
        limit ?? null,
      ]),
      entries,
      coverage: {
        ...capture.coverage,
        scope: `${capture.coverage.scope}; focused projection of captured controls`,
        sourceComplete: limitTruncated
          ? false
          : capture.coverage.sourceComplete,
        reasons: [
          ...capture.coverage.reasons,
          "focused_projection",
          ...(limitTruncated ? ["focus_limit"] : []),
        ],
      },
    },
    description: {
      ...(query === undefined ? {} : { query }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
      scanned: capture.entries.length,
      matched: matched.length,
    },
  };
}

/** Small, self-contained action follow-up. A fallback never claims the acted node was found. */
function computerActionFollowupCapture(
  capture: ObservationCapture<ComputerInspection["controls"][number]>,
  acted: ComputerControlSelector,
): {
  capture: ObservationCapture<ComputerInspection["controls"][number]>;
  description: {
    kind: "action-followup";
    match: "same-presented-control" | "first-captured-controls";
    scanned: number;
    returned: number;
    inspectToExpand: true;
  };
} {
  const index = capture.entries.findIndex(
    ({ value }) => value.selector.targetId === acted.targetId,
  );
  const start =
    index < 0
      ? 0
      : Math.min(
          Math.max(0, index - 2),
          Math.max(0, capture.entries.length - 5),
        );
  const entries = capture.entries.slice(start, start + 5);
  const subset = entries.length < capture.entries.length;
  return {
    capture: {
      ...capture,
      scopeKey: JSON.stringify([
        capture.scopeKey,
        "computer-action-followup",
        start,
        entries.length,
      ]),
      entries,
      coverage: {
        ...capture.coverage,
        scope: `${capture.coverage.scope}; action follow-up subset of captured controls`,
        sourceComplete: subset ? false : capture.coverage.sourceComplete,
        reasons: [
          ...capture.coverage.reasons,
          "action_followup_projection",
          ...(subset ? ["action_followup_subset"] : []),
        ],
      },
    },
    description: {
      kind: "action-followup",
      match: index < 0 ? "first-captured-controls" : "same-presented-control",
      scanned: capture.entries.length,
      returned: entries.length,
      inspectToExpand: true,
    },
  };
}

export async function retryDesktopSourceEnumeration<T>(
  getSources: () => Promise<T>,
): Promise<T> {
  try {
    return await getSources();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Failed to get sources"
    ) {
      throw new Error(
        `Window source enumeration failed: ${boundedDesktopCaptureError(error)}`,
        { cause: error },
      );
    }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  try {
    return await getSources();
  } catch (error) {
    throw new Error(
      `Window source enumeration failed after retry: ${boundedDesktopCaptureError(error)}`,
      { cause: error },
    );
  }
}

function boundedDesktopCaptureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const printable = message.replace(/[\x00-\x1f\x7f]/gu, " ").trim();
  return printable.length > 200
    ? `${printable.slice(0, 200)}…`
    : printable || "unknown error";
}

export class ElectronMacComputerBackend implements ZenXComputerBackend {
  readonly nativeTargetedAccessibility = true;
  readonly nativeWindowInput = true;
  readonly targetSession: ComputerTargetSession;
  readonly #captureScope = randomUUID();
  readonly #artifactDirectory: string;
  readonly #expiryTimers = new Set<NodeJS.Timeout>();
  readonly #accessibility: Pick<MacAccessibilityDriver, "run">;
  readonly #foregroundInput: MacForegroundInputDriver;
  readonly #observations = new ComputerObservationLedger();

  invalidateObservations(): void {
    this.#observations.clear();
  }
  invalidateTargetObservations(target: ComputerTarget): void {
    this.#observations.beginObservation(computerTargetKey(target));
  }
  #ocrExecutable?: Promise<string>;

  constructor(
    artifactDirectory = path.join(
      os.tmpdir(),
      `zenx-capability-artifacts-${String(process.pid)}`,
    ),
    accessibility?: Pick<MacAccessibilityDriver, "run">,
  ) {
    this.#artifactDirectory = path.join(artifactDirectory, randomUUID());
    this.#accessibility =
      accessibility ?? new MacAccessibilityDriver(this.#artifactDirectory);
    this.#foregroundInput = new MacForegroundInputDriver(
      this.#artifactDirectory,
    );
    let executable: Promise<string> | undefined;
    this.targetSession = new ComputerTargetSession(
      new NativeComputerTargetTransport(
        () =>
          (executable ??= resolveMacNativeHelperExecutable(
            "zenx-bound-target",
            async () => {
              await mkdir(this.#artifactDirectory, {
                recursive: true,
                mode: 0o700,
              });
              const source = path.join(
                this.#artifactDirectory,
                "zenx-bound-target.swift",
              );
              const binary = path.join(
                this.#artifactDirectory,
                "zenx-bound-target",
              );
              await writeFile(source, MAC_BOUND_TARGET_SOURCE, { mode: 0o600 });
              await runProcess(
                "/usr/bin/swiftc",
                ["-O", source, "-o", binary],
                60_000,
              );
              return binary;
            },
          )),
      ),
    );
  }

  async listWindows(
    query?: string,
    signal?: AbortSignal,
  ): Promise<ComputerWindowList> {
    requireMacOs();
    signal?.throwIfAborted();
    const targets = (await this.#accessibility.run(
      {
        operation: "listWindows",
      },
      signal,
    )) as ComputerInspection["target"][];
    signal?.throwIfAborted();
    return selectComputerWindows(targets, query);
  }

  async inspect(
    target: ComputerTarget,
    signal?: AbortSignal,
  ): Promise<ComputerInspection> {
    requireMacOs();
    signal?.throwIfAborted();
    const targetKey = computerTargetKey(target);
    const pendingId = this.#observations.beginObservation(targetKey);
    const result = (await this.#accessibility.run(
      { operation: "inspect", target },
      signal,
    )) as MacInspectionResult;
    signal?.throwIfAborted();
    const nativeRead = result.diagnostics.nativeRead;
    if (
      nativeRead === undefined ||
      !["complete", "partial"].includes(nativeRead.status) ||
      !Number.isSafeInteger(nativeRead.errorCount) ||
      nativeRead.errorCount < 0 ||
      typeof nativeRead.deadlineReached !== "boolean"
    )
      throw new Error(
        "macOS accessibility helper returned invalid inspect read diagnostics",
      );
    const readOnly =
      nativeRead.status === "partial" ||
      nativeRead.errorCount > 0 ||
      nativeRead.deadlineReached;
    const fingerprint = (
      control: MacRawControl,
    ): ComputerControlFingerprint => ({
      ...rawControlFingerprint(control),
      ...(readOnly ? { actions: [] } : {}),
    });
    const boundedControls = selectComputerInspectionControls(
      result.controls,
      (control) =>
        control.enabled && canonicalComputerActions(control.actions).length > 0,
      preferredMacWebControl,
    );
    const selected = new Set(boundedControls);
    const capturedControls = [
      ...boundedControls,
      ...result.controls.filter((control) => !selected.has(control)),
    ];
    const observation = this.#observations.observe(
      targetKey,
      capturedControls.map(fingerprint),
      undefined,
      {
        pendingId,
        ...(readOnly
          ? {
              readOnlyReason:
                "Computer inspection is partial after an AX read failure or deadline; observation only, no input dispatched. Inspect the target again explicitly.",
            }
          : {}),
      },
    );
    const controls = capturedControls.map((control, index) => ({
      selector: observation.selectors[index]!,
      role: control.role,
      title: control.title,
      enabled: control.enabled,
      actions: fingerprint(control).actions,
    }));
    const reasons = [
      ...(result.diagnostics.visitLimitReached ? ["visit_limit"] : []),
      ...(result.diagnostics.depthLimitReached ? ["depth_limit"] : []),
      ...(result.diagnostics.outputLimitReached ? ["native_output_limit"] : []),
      ...(nativeRead.errorCount > 0 ? ["ax_read_error"] : []),
      ...(nativeRead.deadlineReached ? ["inspect_deadline"] : []),
    ];
    return {
      platform: process.platform,
      observationId: observation.observationId,
      target: result.target,
      controls: controls.slice(0, boundedControls.length),
      ...(readOnly || controls.length === 0
        ? {
            visualTextFallback:
              "For self-drawn text, explicitly use computer_screenshot then computer_ocr on that capture. OCR reads visual text only, not actionable AX controls.",
          }
        : {}),
      [OBSERVATION_CAPTURE]: {
        assertCurrent: () =>
          this.#observations.assertCurrent(
            computerTargetKey(target),
            observation.observationId,
          ),
        scopeKey: JSON.stringify([
          this.#captureScope,
          macCaptureIdentity(result.targetContext),
        ]),
        entries: uniqueComputerCaptureEntries(
          controls,
          capturedControls.map((control) =>
            macCaptureIdentity({
              ...rawControlFingerprint(control),
              enabled: control.enabled,
            }),
          ),
        ),
        coverage: {
          scope: "scoped_window_accessibility_capture",
          sourceComplete: !result.truncated && !readOnly,
          reasons,
          ...(!result.truncated && !readOnly
            ? { itemTotal: controls.length }
            : {}),
        },
      },
      truncated:
        readOnly ||
        result.truncated ||
        result.controls.length > boundedControls.length,
      diagnostics: {
        ...result.diagnostics,
        nativeRead: {
          ...nativeRead,
          status: readOnly ? "partial" : "complete",
        },
        ...(readOnly ? { actionableCount: 0, webAreaActionableCount: 0 } : {}),
        selectionLimit: MAX_COMPUTER_INSPECTION_CONTROLS,
        selectionLimitReached: result.controls.length > boundedControls.length,
      },
    };
  }

  async desktopContext(): Promise<{
    pid: number;
    bundleId: string;
    applicationName: string;
  }> {
    requireMacOs();
    return (await this.#accessibility.run({ operation: "desktopContext" })) as {
      pid: number;
      bundleId: string;
      applicationName: string;
    };
  }

  async prepareForegroundInput(signal: AbortSignal): Promise<void> {
    requireMacOs();
    await this.#foregroundInput.prepare(signal);
  }

  async press(
    target: ComputerTarget,
    control: ComputerControlSelector,
    signal?: AbortSignal,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
    pointer?: ComputerActionPointer;
  }> {
    requireMacOs();
    const fingerprint = this.#observations.consume(
      computerTargetKey(target),
      control,
      COMPUTER_ACTION_PRESS,
    );
    const response = (await this.#accessibility.run(
      {
        operation: "press",
        target,
        control: semanticControlSelector(fingerprint),
      },
      signal,
    )) as {
      target: ComputerInspection["target"];
      pointer?: ComputerActionPointer;
    };
    return {
      target: response.target,
      control,
      ...(response.pointer ? { pointer: response.pointer } : {}),
    };
  }

  async setValue(
    target: ComputerTarget,
    control: ComputerControlSelector,
    value: string,
    signal?: AbortSignal,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
    characterCount: number;
    pointer?: ComputerActionPointer;
  }> {
    requireMacOs();
    const fingerprint = this.#observations.consume(
      computerTargetKey(target),
      control,
      COMPUTER_ACTION_SET_VALUE,
    );
    const response = (await this.#accessibility.run(
      {
        operation: "setValue",
        target,
        control: semanticControlSelector(fingerprint),
        value,
      },
      signal,
    )) as {
      target: ComputerInspection["target"];
      characterCount: number;
      pointer?: ComputerActionPointer;
    };
    return { ...response, control };
  }

  async screenshot(
    target: ComputerTarget,
    signal = new AbortController().signal,
    owner?: string,
  ): Promise<{
    artifactPath: string;
    target: ComputerInspection["target"];
    width: number;
    height: number;
    bytes: number;
    expiresAt: string;
  }> {
    requireMacOs();
    if (owner !== undefined) {
      return await this.targetSession.capture(
        owner,
        target,
        signal,
        async (binding) => {
          const image = await this.#captureWindowId(binding.windowId);
          return await this.#saveScreenshot(binding.target, image);
        },
      );
    }
    const { target: resolvedTarget, image } = await this.#captureWindow(target);
    return await this.#saveScreenshot(resolvedTarget, image);
  }

  async ocr(
    target: ComputerTarget,
    captureId: string,
    languages: string[],
    owner: string,
    signal: AbortSignal,
  ): Promise<ComputerOcrInspection> {
    requireMacOs();
    signal.throwIfAborted();
    languages = computerOcrLanguages(languages);
    // Packaged helpers are precompiled. Explicit development compilation retains
    // the existing separate 60-second setup ceiling, never an OCR retry.
    const executable = await (this.#ocrExecutable ??=
      resolveMacNativeHelperExecutable("zenx-ocr", async () => {
        await mkdir(this.#artifactDirectory, { recursive: true, mode: 0o700 });
        const source = path.join(this.#artifactDirectory, "zenx-ocr.swift");
        const executable = path.join(this.#artifactDirectory, "zenx-ocr");
        await writeFile(source, MAC_OCR_SOURCE, { mode: 0o600 });
        await runProcess(
          "/usr/bin/swiftc",
          ["-O", source, "-o", executable],
          60_000,
          undefined,
          signal,
        );
        return executable;
      }));
    signal.throwIfAborted();
    const deadline = AbortSignal.timeout(COMPUTER_OCR_BUDGET_MS);
    const readSignal = AbortSignal.any([signal, deadline]);
    return await this.targetSession.readCapture(
      owner,
      target,
      captureId,
      readSignal,
      async (image, binding) => {
        if (
          !image.artifactPath ||
          !image.imageSha256 ||
          !image.capturedAt ||
          !image.expiresAt ||
          image.width * image.height > COMPUTER_OCR_MAX_IMAGE_PIXELS
        )
          throw new Error(
            "OCR requires an available bound screenshot of at most 4 megapixels",
          );
        const output = await runProcess(
          executable,
          [],
          COMPUTER_OCR_BUDGET_MS,
          JSON.stringify({
            imagePath: image.artifactPath,
            imageSha256: image.imageSha256,
            width: image.width,
            height: image.height,
            languages,
          }),
          readSignal,
        );
        readSignal.throwIfAborted();
        return {
          ...parseComputerOcrRecognition(output, image, languages),
          target: binding.target,
          bindingId: binding.bindingId,
          captureId,
          capturedAt: image.capturedAt,
          expiresAt: image.expiresAt,
          coordinateSpace: "screenshot_pixels_top_left",
          observationOnly: true,
        };
      },
    );
  }

  async #saveScreenshot(
    resolvedTarget: ComputerInspection["target"],
    image: import("electron").NativeImage,
  ) {
    await mkdir(this.#artifactDirectory, { recursive: true, mode: 0o700 });
    const artifactPath = path.join(
      this.#artifactDirectory,
      `${randomUUID()}.png`,
    );
    const capturedAt = new Date().toISOString();
    const png = image.toPNG();
    await writeFile(artifactPath, png, { mode: 0o600 });
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const timer = setTimeout(() => {
      this.#expiryTimers.delete(timer);
      void rm(artifactPath, { force: true });
    }, 5 * 60_000);
    timer.unref();
    this.#expiryTimers.add(timer);
    const size = image.getSize();
    return {
      artifactPath,
      target: resolvedTarget,
      width: size.width,
      height: size.height,
      bytes: png.length,
      imageSha256: createHash("sha256").update(png).digest("hex"),
      expiresAt: expiresAt.toISOString(),
      capturedAt,
    };
  }

  observeWindow(
    target: ComputerTarget,
    listener: ComputerLiveObservationListener,
  ): () => void {
    const exactWindow = this.#resolveWindow(target);
    return observeComputerWindow(async () => {
      const resolved = await exactWindow;
      const current = await this.#resolveWindow(target);
      if (current.windowId !== resolved.windowId) {
        throw new Error(
          "The selected Computer window changed; inspect the target again",
        );
      }
      return {
        image: await this.#captureWindowId(resolved.windowId),
        windowWidth: current.windowWidth,
        windowHeight: current.windowHeight,
        windowId: current.windowId,
      };
    }, listener);
  }

  async #captureWindow(target: ComputerTarget) {
    const resolved = await this.#resolveWindow(target);
    return {
      target: resolved.target,
      image: await this.#captureWindowId(resolved.windowId),
    };
  }

  async #resolveWindow(target: ComputerTarget) {
    return (await this.#accessibility.run({
      operation: "resolveWindow",
      target,
    })) as {
      target: ComputerInspection["target"];
      windowId: number;
      windowWidth: number;
      windowHeight: number;
    };
  }

  async #captureWindowId(windowId: number) {
    const { desktopCapturer } = await import("electron");
    const sources = await retryDesktopSourceEnumeration(() =>
      desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 1600, height: 1000 },
        fetchWindowIcons: false,
      }),
    );
    const source = sources.find((candidate) =>
      candidate.id.startsWith(`window:${String(windowId)}:`),
    );
    if (source === undefined || source.thumbnail.isEmpty())
      throw new Error(
        "The targeted window is not available for scoped capture; grant Screen Recording permission and ensure the window is on-screen",
      );
    return source.thumbnail;
  }

  async foregroundClick(
    x: number,
    y: number,
    button: "left" | "right",
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<void> {
    requireMacOs();
    const { screen } = await import("electron");
    const onDisplay = screen
      .getAllDisplays()
      .some(
        ({ bounds }) =>
          x >= bounds.x &&
          y >= bounds.y &&
          x < bounds.x + bounds.width &&
          y < bounds.y + bounds.height,
      );
    if (!onDisplay) {
      throw new Error(
        `Foreground click point ${String(x)},${String(y)} is outside every display`,
      );
    }
    await this.#foregroundInput.run(
      { operation: "click", x: Math.round(x), y: Math.round(y), button },
      signal,
      onStopping,
    );
  }

  async foregroundKeyPress(
    key: ComputerKey,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<void> {
    requireMacOs();
    await this.#foregroundInput.run(
      { operation: "key", key },
      signal,
      onStopping,
    );
  }

  async foregroundScroll(
    deltaY: number,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<void> {
    requireMacOs();
    await this.#foregroundInput.run(
      { operation: "scroll", deltaY },
      signal,
      onStopping,
    );
  }

  async close(): Promise<void> {
    await this.targetSession.close();
    this.#observations.clear();
    for (const timer of this.#expiryTimers) clearTimeout(timer);
    this.#expiryTimers.clear();
    await rm(this.#artifactDirectory, { recursive: true, force: true });
  }
}

export class MacForegroundInputDriver {
  readonly #directory: string;
  readonly #compileHelper: () => Promise<string>;
  readonly #runProcess: typeof runProcess;
  #executable: Promise<string> | undefined;

  constructor(
    directory: string,
    dependencies: {
      compile?: () => Promise<string>;
      runProcess?: typeof runProcess;
    } = {},
  ) {
    this.#directory = directory;
    this.#compileHelper =
      dependencies.compile ??
      (() =>
        resolveMacNativeHelperExecutable("zenx-foreground-input", () =>
          this.#compile(),
        ));
    this.#runProcess = dependencies.runProcess ?? runProcess;
  }

  async run(
    request: Record<string, unknown>,
    signal: AbortSignal,
    onStopping?: () => void,
  ): Promise<void> {
    signal.throwIfAborted();
    if (request.operation === "scroll") {
      const deltaY = request.deltaY;
      if (
        typeof deltaY !== "number" ||
        !Number.isFinite(deltaY) ||
        Math.abs(deltaY) > 10_000 ||
        Math.round(deltaY) === 0
      ) {
        throw new Error(
          "macOS scroll deltaY must round to a non-zero pixel amount between -10000 and 10000",
        );
      }
      request = { ...request, deltaY: Math.round(deltaY) };
    }
    const executable = await (this.#executable ??= this.#compileHelper());
    signal.throwIfAborted();
    await this.#runProcess(
      executable,
      [],
      10_000,
      JSON.stringify(request),
      signal,
      undefined,
      onStopping,
    );
  }

  async prepare(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await (this.#executable ??= this.#compileHelper());
    signal.throwIfAborted();
  }

  async #compile(): Promise<string> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const sourcePath = path.join(
      this.#directory,
      "zenx-foreground-input.swift",
    );
    const executablePath = path.join(this.#directory, "zenx-foreground-input");
    await writeFile(sourcePath, MAC_FOREGROUND_INPUT_SOURCE, {
      encoding: "utf8",
      mode: 0o600,
    });
    await runProcess(
      "/usr/bin/swiftc",
      ["-O", sourcePath, "-o", executablePath],
      60_000,
    );
    return executablePath;
  }
}

const MAC_ACCESSIBILITY_TIMEOUT_MS = 10_000;
const MAC_INSPECT_RESULT_RESERVE_MS = 250;

export class MacAccessibilityDriver {
  readonly #directory: string;
  readonly #compileHelper: () => Promise<string>;
  readonly #runProcess: typeof runProcess;
  #executable: Promise<string> | undefined;

  constructor(
    directory: string,
    dependencies: {
      compile?: () => Promise<string>;
      runProcess?: typeof runProcess;
    } = {},
  ) {
    this.#directory = directory;
    this.#compileHelper =
      dependencies.compile ??
      (() =>
        resolveMacNativeHelperExecutable("zenx-accessibility", () =>
          this.#compile(),
        ));
    this.#runProcess = dependencies.runProcess ?? runProcess;
  }

  async sessionState(
    signal?: AbortSignal,
  ): Promise<"active" | "locked" | "unknown"> {
    const observed = (await this.run(
      { operation: "sessionState" },
      signal,
    )) as { sessionState?: unknown };
    return observed.sessionState === "active" ||
      observed.sessionState === "locked"
      ? observed.sessionState
      : "unknown";
  }

  async run(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const executable = await (this.#executable ??= this.#compileHelper());
    signal?.throwIfAborted();
    if (request.operation === "inspect") {
      request = {
        ...request,
        inspectDeadlineUnixMs:
          Date.now() +
          MAC_ACCESSIBILITY_TIMEOUT_MS -
          MAC_INSPECT_RESULT_RESERVE_MS,
      };
    }
    const output = await this.#runProcess(
      executable,
      [],
      MAC_ACCESSIBILITY_TIMEOUT_MS,
      JSON.stringify(request),
      signal,
    );
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new Error("macOS accessibility helper returned invalid JSON");
    }
  }

  async #compile(): Promise<string> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const sourcePath = path.join(this.#directory, "zenx-accessibility.swift");
    const executablePath = path.join(this.#directory, "zenx-accessibility");
    await writeFile(sourcePath, MAC_ACCESSIBILITY_SOURCE, {
      encoding: "utf8",
      mode: 0o600,
    });
    await runProcess(
      "/usr/bin/swiftc",
      ["-O", sourcePath, "-o", executablePath],
      60_000,
    );
    return executablePath;
  }
}

export async function resolveMacNativeHelperExecutable(
  helperName:
    | "zenx-accessibility"
    | "zenx-foreground-input"
    | "zenx-bound-target"
    | "zenx-ocr",
  compileDevelopmentHelper: () => Promise<string>,
  runtime: {
    resourcesPath?: string;
    defaultApp?: boolean;
  } = process as typeof process & {
    resourcesPath?: string;
    defaultApp?: boolean;
  },
  assertExecutable: (path: string, mode: number) => Promise<void> = access,
): Promise<string> {
  if (runtime.resourcesPath !== undefined && runtime.defaultApp !== true) {
    const executable = path.join(
      runtime.resourcesPath,
      "native-helpers",
      helperName,
    );
    try {
      await assertExecutable(executable, fsConstants.X_OK);
    } catch (error) {
      throw new Error(
        `Packaged macOS Computer helper is missing or not executable: ${executable}`,
        { cause: error },
      );
    }
    return executable;
  }
  return await compileDevelopmentHelper();
}

export const MAC_ACCESSIBILITY_SOURCE = `import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\\n").utf8))
  exit(1)
}

func failAccessibilityDenied() -> Never {
  fail("macOS Accessibility denied for helper at " + CommandLine.arguments[0] + ". If the current ZenX.app is already enabled in System Settings > Privacy & Security > Accessibility, remove the old ZenX entry, add the current ZenX.app again, and relaunch ZenX.")
}

func dictionary(_ value: Any?, _ name: String) -> [String: Any] {
  guard let result = value as? [String: Any] else { fail(name + " must be an object") }
  return result
}

func string(_ value: Any?) -> String? {
  guard let value = value as? String, !value.isEmpty else { return nil }
  return value
}

// Only inspect owns this budget. Other operations retain their existing reads
// and mutation contracts; the parent still owns the unchanged 10-second limit.
final class InspectReadBudget {
  let now: () -> TimeInterval
  let started: TimeInterval
  let deadline: TimeInterval
  var readCount = 0
  var errorCount = 0
  var errorCodes: [Int] = []
  var deadlineReached = false
  init(seconds: TimeInterval, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    let start = now()
    self.now = now
    self.started = start
    self.deadline = start + max(0, min(9.75, seconds))
  }
  convenience init(deadlineUnixMs: Double, wallNow: () -> TimeInterval = { Date().timeIntervalSince1970 }, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    self.init(seconds: deadlineUnixMs / 1000 - wallNow(), now: now)
  }
  func available() -> Bool {
    if now() >= deadline { deadlineReached = true }
    return !deadlineReached
  }
  func record(_ error: AXError, absent: [AXError] = []) -> Bool {
    _ = available()
    if error == .success { return true }
    if error == .apiDisabled { failAccessibilityDenied() }
    if !absent.contains(error) {
      errorCount += 1
      let code = Int(error.rawValue)
      if errorCodes.count < 8 && !errorCodes.contains(code) { errorCodes.append(code) }
    }
    return false
  }
  func begin(_ element: AXUIElement) -> Bool {
    guard available() else { return false }
    // AX timeouts are object-local, not inherited from the application object.
    // Never reset the deadline or give each child a fresh full-operation budget.
    let remaining = deadline - now()
    guard remaining > 0 else { deadlineReached = true; return false }
    let timeout = Float(remaining).nextDown
    guard timeout > 0 else { deadlineReached = true; return false }
    let configured = AXUIElementSetMessagingTimeout(element, timeout)
    guard record(configured), available() else { return false }
    readCount += 1
    return true
  }
  var partial: Bool { _ = available(); return deadlineReached || errorCount > 0 }
  func diagnostics() -> [String: Any] {
    return ["status": partial ? "partial" : "complete", "readCount": readCount,
      "errorCount": errorCount, "errorCodes": errorCodes, "deadlineReached": deadlineReached,
      "elapsedMs": max(0, (now() - started) * 1000), "budgetMs": max(0, (deadline - started) * 1000)]
  }
  func requireResolvedTarget() {
    if partial {
      fail("AX inspect could not resolve the exact target; read errors " + String(describing: errorCodes) +
        (deadlineReached ? "; inspect deadline reached" : "") + "; no observation or action authority returned")
    }
  }
}
var inspectReadBudget: InspectReadBudget?

func beginAXRead(_ element: AXUIElement) -> Bool {
  return inspectReadBudget?.begin(element) ?? true
}
func acceptAXRead(_ error: AXError, absent: [AXError] = []) -> Bool {
  return inspectReadBudget?.record(error, absent: absent) ?? (error == .success)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  guard beginAXRead(element) else { return nil }
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
  guard acceptAXRead(error, absent: [.attributeUnsupported, .noValue]),
        let value else { return nil }
  return value
}

func textAttribute(_ element: AXUIElement, _ name: String) -> String {
  return attribute(element, name) as? String ?? ""
}

func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool {
  return attribute(element, name) as? Bool ?? false
}

func elementArrayCount(_ element: AXUIElement, _ name: String) -> CFIndex? {
  guard beginAXRead(element) else { return nil }
  var count: CFIndex = 0
  let error = AXUIElementGetAttributeValueCount(element, name as CFString, &count)
  guard acceptAXRead(error, absent: [.attributeUnsupported, .noValue]) else { return nil }
  return max(0, count)
}

func elementArrayAttribute(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
  guard let count = elementArrayCount(element, name), count > 0 else { return [] }
  // inspect window discovery is bounded too, but cannot select from an omitted
  // tail that might contain another matching window.
  if inspectReadBudget != nil && count > 1024 {
    fail("AX inspect target window list exceeds the bounded read; exact target unresolved")
  }
  return elementArrayValues(element, name, count: count)
}

func elementArrayValues(_ element: AXUIElement, _ name: String, count: CFIndex) -> [AXUIElement] {
  guard count > 0, beginAXRead(element) else { return [] }
  var values: CFArray?
  let error = AXUIElementCopyAttributeValues(element, name as CFString, 0, count, &values)
  guard acceptAXRead(error, absent: [.attributeUnsupported, .noValue]),
        let array = values else { return [] }
  return (0..<min(count, CFArrayGetCount(array))).compactMap { index in
    guard let pointer = CFArrayGetValueAtIndex(array, index) else { return nil }
    return unsafeBitCast(pointer, to: AXUIElement.self)
  }
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let raw = attribute(element, name),
        CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
  return unsafeBitCast(raw, to: AXUIElement.self)
}

func actions(_ element: AXUIElement) -> [String] {
  guard beginAXRead(element) else { return [] }
  var names: CFArray?
  let error = AXUIElementCopyActionNames(element, &names)
  guard acceptAXRead(error, absent: [.actionUnsupported, .noValue]) else { return [] }
  return (names as? [String] ?? []).sorted()
}

func isSettable(_ element: AXUIElement, _ name: String) -> Bool {
  guard beginAXRead(element) else { return false }
  var settable: DarwinBoolean = false
  let error = AXUIElementIsAttributeSettable(element, name as CFString, &settable)
  return acceptAXRead(error, absent: [.attributeUnsupported, .noValue]) && settable.boolValue
}

func elementFrame(_ element: AXUIElement) -> CGRect? {
  guard let rawPosition = attribute(element, kAXPositionAttribute),
        let rawSize = attribute(element, kAXSizeAttribute),
        CFGetTypeID(rawPosition) == AXValueGetTypeID(),
        CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
  let positionValue = unsafeBitCast(rawPosition, to: AXValue.self)
  let sizeValue = unsafeBitCast(rawSize, to: AXValue.self)
  var position = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(positionValue, .cgPoint, &position),
        AXValueGetValue(sizeValue, .cgSize, &size),
        position.x.isFinite, position.y.isFinite,
        size.width.isFinite, size.height.isFinite,
        size.width > 0, size.height > 0 else { return nil }
  return CGRect(origin: position, size: size)
}

func actionPointer(_ element: AXUIElement, _ window: AXUIElement?, _ action: String) -> [String: Any]? {
  guard let window,
        let controlFrame = elementFrame(element),
        let windowFrame = elementFrame(window) else { return nil }
  let center = CGPoint(x: controlFrame.midX, y: controlFrame.midY)
  guard windowFrame.contains(center) else { return nil }
  let x = (center.x - windowFrame.minX) / windowFrame.width
  let y = (center.y - windowFrame.minY) / windowFrame.height
  guard x.isFinite, y.isFinite, x >= 0, x <= 1, y >= 0, y <= 1 else { return nil }
  let timestamp = ISO8601DateFormatter()
  timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  var pointer: [String: Any] = [
    "x": x, "y": y, "action": action,
    "capturedAt": timestamp.string(from: Date()),
    "windowWidth": windowFrame.width, "windowHeight": windowFrame.height
  ]
  if let windowId = uniqueActionWindowId(window, windowFrame) {
    pointer["windowId"] = windowId
  }
  return pointer
}

func frameFingerprint(_ element: AXUIElement) -> String {
  guard let frame = elementFrame(element) else { return "" }
  return String(format: "%.1f,%.1f,%.1f,%.1f", frame.origin.x, frame.origin.y, frame.size.width, frame.size.height)
}

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let raw = try? JSONSerialization.jsonObject(with: data),
      let request = raw as? [String: Any] else { fail("request must be JSON") }
let operation = string(request["operation"]) ?? ""
if operation == "inspect" {
  guard let deadline = request["inspectDeadlineUnixMs"] as? Double, deadline.isFinite else {
    fail("AX inspect requires the original host deadline")
  }
  inspectReadBudget = InspectReadBudget(deadlineUnixMs: deadline)
}
if operation == "sessionState" {
  // A locked macOS session can report Electron idle=active at process startup.
  // Read only this user's console session; do not infer from frontmost app/title.
  var state = "unknown"
  if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
     let onConsole = session[kCGSessionOnConsoleKey as String] as? Bool {
    if let locked = session["CGSSessionScreenIsLocked"] as? Bool, locked {
      state = "locked"
    } else if onConsole {
      state = "active"
    }
  }
  let output = try! JSONSerialization.data(withJSONObject: ["sessionState": state])
  FileHandle.standardOutput.write(output)
  exit(0)
}
if operation == "desktopContext" {
  guard let frontmost = NSWorkspace.shared.frontmostApplication else { fail("frontmost application is unavailable") }
  let response: [String: Any] = [
    "pid": Int(frontmost.processIdentifier),
    "bundleId": frontmost.bundleIdentifier ?? "",
    "applicationName": frontmost.localizedName ?? ""
  ]
  guard let output = try? JSONSerialization.data(withJSONObject: response) else { fail("could not encode response") }
  FileHandle.standardOutput.write(output)
  exit(0)
}
guard AXIsProcessTrusted() else {
  failAccessibilityDenied()
}
if operation == "listWindows" {
  var targets: [[String: Any]] = []
  for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    // Chromium publishes its current AX window surface on demand. Requesting
    // the application role before AXWindows keeps list and inspect consistent.
    _ = textAttribute(element, kAXRoleAttribute)
    for window in elementArrayAttribute(element, kAXWindowsAttribute) {
      var target: [String: Any] = [
        "pid": Int(app.processIdentifier),
        "applicationName": app.localizedName ?? "",
        "windowTitle": textAttribute(window, kAXTitleAttribute)
      ]
      if let bundleId = app.bundleIdentifier { target["bundleId"] = bundleId }
      targets.append(target)
    }
  }
  guard let output = try? JSONSerialization.data(withJSONObject: targets) else { fail("could not encode windows") }
  FileHandle.standardOutput.write(output)
  exit(0)
}
let targetRequest = dictionary(request["target"], "target")

let running: NSRunningApplication
if let pidNumber = targetRequest["pid"] as? NSNumber {
  guard let candidate = NSRunningApplication(processIdentifier: pid_t(pidNumber.int32Value)) else {
    fail("target pid is not running")
  }
  running = candidate
} else if let bundleId = string(targetRequest["bundleId"]) {
  guard let candidate = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
    fail("target bundleId is not running")
  }
  running = candidate
} else {
  fail("target requires pid or bundleId")
}
if let expectedBundle = string(targetRequest["bundleId"]), running.bundleIdentifier != expectedBundle {
  fail("target pid and bundleId identify different applications")
}

let appElement = AXUIElementCreateApplication(running.processIdentifier)
// Chromium enables its native macOS accessibility surface on demand when an
// assistive client requests the application role. Query it before resolving
// windows so the first scoped inspection can include the web-area subtree.
_ = textAttribute(appElement, kAXRoleAttribute)
let requestedWindowTitle = string(targetRequest["windowTitle"])
var windows = elementArrayAttribute(appElement, kAXWindowsAttribute)
if let focused = elementAttribute(appElement, kAXFocusedWindowAttribute) { windows.append(focused) }
if let main = elementAttribute(appElement, kAXMainWindowAttribute) { windows.append(main) }
let selectedWindow: AXUIElement?
if let title = requestedWindowTitle {
  var matchingWindows: [AXUIElement] = []
  for window in windows where textAttribute(window, kAXRoleAttribute) == kAXWindowRole && textAttribute(window, kAXTitleAttribute) == title {
    if !matchingWindows.contains(where: { CFEqual($0, window) }) {
      matchingWindows.append(window)
    }
  }
  inspectReadBudget?.requireResolvedTarget()
  if matchingWindows.isEmpty {
    fail("target window was not found as a scoped AXWindow")
  }
  if matchingWindows.count != 1 {
    fail("target window title is ambiguous; choose a uniquely titled window")
  }
  selectedWindow = matchingWindows[0]
} else {
  selectedWindow = nil
}
let root = selectedWindow ?? appElement
inspectReadBudget?.requireResolvedTarget()
var resolvedTarget: [String: Any] = [
  "pid": Int(running.processIdentifier),
  "bundleId": running.bundleIdentifier ?? "",
  "applicationName": running.localizedName ?? ""
]
if let title = requestedWindowTitle { resolvedTarget["windowTitle"] = title }

func children(_ element: AXUIElement) -> [AXUIElement] {
  let direct = elementArrayAttribute(element, kAXChildrenAttribute)
  if !direct.isEmpty { return direct }
  return elementArrayAttribute(element, "AXChildrenInNavigationOrder")
}

func inspectChildren(_ element: AXUIElement, limit: Int) -> (elements: [AXUIElement], omitted: Bool) {
  for name in [kAXChildrenAttribute, "AXChildrenInNavigationOrder"] {
    let errors = inspectReadBudget?.errorCount ?? 0
    let count = elementArrayCount(element, name)
    // Unsupported/absent children may use the existing navigation-order source;
    // an actual failure never masquerades as absence or triggers that fallback.
    if (inspectReadBudget?.errorCount ?? 0) != errors || !(inspectReadBudget?.available() ?? true) {
      return ([], false)
    }
    guard let count, count > 0 else { continue }
    let requested = min(count, max(0, limit))
    return (elementArrayValues(element, name, count: requested), count > requested)
  }
  return ([], false)
}

func supportsTextValue(_ element: AXUIElement) -> Bool {
  let role = textAttribute(element, kAXRoleAttribute)
  return ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) &&
    isSettable(element, kAXValueAttribute)
}

func supportedActions(_ element: AXUIElement) -> [String] {
  var result = actions(element)
  if supportsTextValue(element) { result.append("AXSetValue") }
  return Array(Set(result)).sorted()
}

func displayLabel(_ element: AXUIElement) -> String {
  for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXIdentifierAttribute] {
    let value = textAttribute(element, name)
    if !value.isEmpty { return value }
  }
  // Static text exposes its displayed content through AXValue. Do not read
  // editable or secure-field values as labels, or add values to selectors.
  if textAttribute(element, kAXRoleAttribute) == kAXStaticTextRole {
    return textAttribute(element, kAXValueAttribute)
  }
  return ""
}

func isContainerRole(_ role: String) -> Bool {
  return [
    kAXWindowRole,
    kAXGroupRole,
    kAXToolbarRole,
    kAXScrollAreaRole,
    kAXSplitGroupRole,
    "AXWebArea",
    "AXLayoutArea",
    "AXLayoutItem"
  ].contains(role)
}

func selector(_ element: AXUIElement) -> [String: String] {
  var result: [String: String] = [:]
  let identifier = textAttribute(element, kAXIdentifierAttribute)
  let role = textAttribute(element, kAXRoleAttribute)
  let subrole = textAttribute(element, kAXSubroleAttribute)
  let title = textAttribute(element, kAXTitleAttribute)
  let description = textAttribute(element, kAXDescriptionAttribute)
  let help = textAttribute(element, kAXHelpAttribute)
  let frame = frameFingerprint(element)
  if !identifier.isEmpty { result["identifier"] = identifier }
  if !role.isEmpty { result["role"] = role }
  if !subrole.isEmpty { result["subrole"] = subrole }
  if !title.isEmpty { result["title"] = title }
  if !description.isEmpty { result["description"] = description }
  if !help.isEmpty { result["help"] = help }
  if !frame.isEmpty { result["frame"] = frame }
  return result
}

func matches(_ element: AXUIElement, _ wanted: [String: Any]) -> Bool {
  if let value = string(wanted["identifier"]), textAttribute(element, kAXIdentifierAttribute) != value { return false }
  if let value = string(wanted["role"]), textAttribute(element, kAXRoleAttribute) != value { return false }
  if let value = string(wanted["subrole"]), textAttribute(element, kAXSubroleAttribute) != value { return false }
  if let value = string(wanted["title"]), textAttribute(element, kAXTitleAttribute) != value { return false }
  if let value = string(wanted["description"]), textAttribute(element, kAXDescriptionAttribute) != value { return false }
  if let value = string(wanted["help"]), textAttribute(element, kAXHelpAttribute) != value { return false }
  if let value = string(wanted["frame"]), frameFingerprint(element) != value { return false }
  return string(wanted["identifier"]) != nil || string(wanted["role"]) != nil || string(wanted["subrole"]) != nil || string(wanted["title"]) != nil || string(wanted["description"]) != nil || string(wanted["help"]) != nil || string(wanted["frame"]) != nil
}

struct WalkEntry {
  let element: AXUIElement
  let inWebArea: Bool
}

struct WalkResult {
  let entries: [WalkEntry]
  var elements: [AXUIElement] { entries.map { $0.element } }
  let visitLimit: Int
  let visitLimitReached: Bool
  let maxDepth: Int
  let maxDepthVisited: Int
  let depthLimitReached: Bool
}

func walk(_ root: AXUIElement, visitLimit: Int = 1024, maxDepth: Int = 24, visit: ((WalkEntry) -> Void)? = nil) -> WalkResult {
  var queue: [(AXUIElement, Int, Bool)] = [(root, 0, false)]
  var result: [WalkEntry] = []
  var cursor = 0
  var maxDepthVisited = 0
  var depthLimitReached = false
  var childrenOmitted = false
  while cursor < queue.count && result.count < visitLimit && (inspectReadBudget?.available() ?? true) {
    let (element, depth, inheritedWebArea) = queue[cursor]
    cursor += 1
    let roleErrors = inspectReadBudget?.errorCount ?? 0
    let inWebArea = inheritedWebArea || textAttribute(element, kAXRoleAttribute) == "AXWebArea"
    if let budget = inspectReadBudget {
      // A failed ancestry read is not evidence of a non-web subtree. Do not
      // retry it through the row collector or propagate an invented false bit.
      if budget.errorCount != roleErrors || !budget.available() { continue }
    }
    let entry = WalkEntry(element: element, inWebArea: inWebArea)
    result.append(entry)
    visit?(entry)
    maxDepthVisited = max(maxDepthVisited, depth)
    if inspectReadBudget != nil {
      let descendants = inspectChildren(element, limit: depth < maxDepth ? visitLimit - queue.count : 0)
      if depth < maxDepth {
        queue.append(contentsOf: descendants.elements.map { ($0, depth + 1, inWebArea) })
        childrenOmitted = childrenOmitted || descendants.omitted
      } else {
        depthLimitReached = depthLimitReached || descendants.omitted
      }
    } else {
      let descendants = children(element)
      if depth < maxDepth {
        queue.append(contentsOf: descendants.map { ($0, depth + 1, inWebArea) })
      } else if !descendants.isEmpty {
        depthLimitReached = true
      }
    }
  }
  return WalkResult(
    entries: result,
    visitLimit: visitLimit,
    visitLimitReached: childrenOmitted || (result.count >= visitLimit && cursor < queue.count),
    maxDepth: maxDepth,
    maxDepthVisited: maxDepthVisited,
    depthLimitReached: depthLimitReached
  )
}

func cgWindowBounds(_ entry: [String: Any]) -> CGRect? {
  guard let raw = entry[kCGWindowBounds as String] as? [String: Any],
        let x = (raw["X"] as? NSNumber)?.doubleValue,
        let y = (raw["Y"] as? NSNumber)?.doubleValue,
        let width = (raw["Width"] as? NSNumber)?.doubleValue,
        let height = (raw["Height"] as? NSNumber)?.doubleValue,
        x.isFinite, y.isFinite, width.isFinite, height.isFinite,
        width > 0, height > 0 else { return nil }
  return CGRect(x: x, y: y, width: width, height: height)
}

func windowBoundsMatch(_ candidate: CGRect, _ expected: CGRect, tolerance: CGFloat = 24) -> Bool {
  return abs(candidate.origin.x - expected.origin.x) <= tolerance &&
    abs(candidate.origin.y - expected.origin.y) <= tolerance &&
    abs(candidate.size.width - expected.size.width) <= tolerance &&
    abs(candidate.size.height - expected.size.height) <= tolerance
}

func uniqueActionWindowId(_ window: AXUIElement, _ bounds: CGRect) -> Int? {
  let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let geometryMatches = info.filter { entry in
    guard (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == running.processIdentifier,
          (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          let candidate = cgWindowBounds(entry) else { return false }
    return windowBoundsMatch(candidate, bounds)
  }
  let title = textAttribute(window, kAXTitleAttribute)
  let titleMatches = title.isEmpty ? [] : geometryMatches.filter {
    ($0[kCGWindowName as String] as? String ?? "") == title
  }
  let candidates = titleMatches.isEmpty ? geometryMatches : titleMatches
  guard candidates.count == 1,
        let id = (candidates[0][kCGWindowNumber as String] as? NSNumber)?.intValue,
        id > 0 else { return nil }
  return id
}

func findControl(_ wanted: [String: Any]) -> AXUIElement {
  let traversal = walk(root)
  let found = traversal.elements.filter { matches($0, wanted) }
  if found.isEmpty { fail("accessibility control was not found") }
  if found.count > 1 { fail("accessibility selector is ambiguous") }
  return found[0]
}

var response: [String: Any]
switch operation {
case "inspect":
  var actionableControls: [[String: Any]] = []
  var semanticControls: [[String: Any]] = []
  var fallbackControls: [[String: Any]] = []
  var encounteredWebArea = false
  var webAreaControlCount = 0
  var webAreaActionableCount = 0
  let traversal = walk(root, visit: { entry in
    let errors = inspectReadBudget?.errorCount ?? 0
    let element = entry.element
    let controlSelector = selector(element)
    if controlSelector.isEmpty { return }
    let role = textAttribute(element, kAXRoleAttribute)
    if role == "AXWebArea" { encounteredWebArea = true }
    let label = displayLabel(element)
    let enabled = boolAttribute(element, kAXEnabledAttribute)
    let elementActions = supportedActions(element)
    // A failed field is not an empty label/disabled control. Keep earlier fully
    // read rows, and disclose this omitted node through the partial diagnostics.
    if (inspectReadBudget?.errorCount ?? 0) != errors || !(inspectReadBudget?.available() ?? true) { return }
    if entry.inWebArea { webAreaControlCount += 1 }
    let control: [String: Any] = [
      "selector": controlSelector,
      "role": role,
      "title": label,
      "enabled": enabled,
      "actions": elementActions,
      "inWebArea": entry.inWebArea,
    ]
    if enabled && (elementActions.contains("AXPress") || elementActions.contains("AXSetValue")) {
      if entry.inWebArea { webAreaActionableCount += 1 }
      actionableControls.append(control)
    } else if !isContainerRole(role) && !label.isEmpty {
      semanticControls.append(control)
    } else {
      fallbackControls.append(control)
    }
  })
  let orderedControls = actionableControls + semanticControls + fallbackControls
  let outputLimit = 120
  var controls = Array(orderedControls.prefix(outputLimit))
  let outputLimitReached = orderedControls.count > controls.count
  var targetContext: [String: Any] = [
    "pid": Int(running.processIdentifier),
    "bundleId": running.bundleIdentifier ?? "",
    "windowTitle": requestedWindowTitle ?? ""
  ]
  if let launchDate = running.launchDate {
    targetContext["launchTime"] = launchDate.timeIntervalSince1970
  }
  if let selectedWindow {
    targetContext["windowFrame"] = frameFingerprint(selectedWindow)
    if let bounds = elementFrame(selectedWindow),
       let windowId = uniqueActionWindowId(selectedWindow, bounds) {
      targetContext["windowId"] = windowId
    }
  }
  let nativeRead = inspectReadBudget!.diagnostics()
  let readPartial = nativeRead["status"] as? String == "partial"
  if readPartial {
    for index in controls.indices { controls[index]["actions"] = [String]() }
  }
  response = [
    "target": resolvedTarget,
    "targetContext": targetContext,
    "controls": controls,
    "truncated": readPartial || traversal.visitLimitReached || traversal.depthLimitReached || outputLimitReached,
    "diagnostics": [
      "visitedCount": traversal.elements.count,
      "visitLimit": traversal.visitLimit,
      "visitLimitReached": traversal.visitLimitReached,
      "maxDepth": traversal.maxDepth,
      "maxDepthVisited": traversal.maxDepthVisited,
      "depthLimitReached": traversal.depthLimitReached,
      "outputLimit": outputLimit,
      "outputLimitReached": outputLimitReached,
      "actionableCount": readPartial ? 0 : actionableControls.count,
      "semanticCount": semanticControls.count,
      "fallbackCount": fallbackControls.count,
      "encounteredWebArea": encounteredWebArea,
      "webAreaControlCount": webAreaControlCount,
      "webAreaActionableCount": readPartial ? 0 : webAreaActionableCount,
      "nativeRead": nativeRead
    ]
  ]
case "press":
  let wanted = dictionary(request["control"], "control")
  let element = findControl(wanted)
  guard actions(element).contains(kAXPressAction) else { fail("control does not support background-safe AXPress; foreground_required") }
  let pointer = actionPointer(element, selectedWindow, "press")
  let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
  guard error == .success else { fail("AXPress failed with error " + String(error.rawValue)) }
  response = ["target": resolvedTarget, "control": selector(element)]
  if let pointer { response["pointer"] = pointer }
case "setValue":
  let wanted = dictionary(request["control"], "control")
  guard let value = request["value"] as? String else { fail("value must be a string") }
  let element = findControl(wanted)
  guard supportsTextValue(element) else {
    fail("control does not support background-safe AXValue; foreground_required")
  }
  let pointer = actionPointer(element, selectedWindow, "set_value")
  let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
  guard error == .success else { fail("AXValue failed with error " + String(error.rawValue)) }
  response = ["target": resolvedTarget, "control": selector(element), "characterCount": value.count]
  // Read the exact element immediately after the acknowledged mutation. Return
  // only equality, never the current value; neither equality nor ACK proves save.
  var actualValue: CFTypeRef?
  let readError = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &actualValue)
  if readError == .success, let actualValue, CFGetTypeID(actualValue) == CFStringGetTypeID() {
    response["valueReadback"] = ["matchesRequested": (actualValue as! String) == value, "source": "native_ax_value"]
  } else {
    response["valueReadbackError"] = "AXValue readback unavailable, error " + String(readError.rawValue)
  }
  if let pointer { response["pointer"] = pointer }
case "resolveWindow":
  guard let title = requestedWindowTitle else { fail("windowTitle is required") }
  guard let selectedWindow, let selectedBounds = elementFrame(selectedWindow) else {
    fail("target AXWindow has no valid bounds for scoped capture")
  }
  let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let candidates = info.compactMap { entry -> ([String: Any], CGRect)? in
    guard (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == running.processIdentifier,
          (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          let bounds = cgWindowBounds(entry) else { return nil }
    return (entry, bounds)
  }
  let titleMatches = candidates.filter {
    ($0.0[kCGWindowName as String] as? String ?? "") == title
  }
  let scopedCandidates = titleMatches.isEmpty ? candidates : titleMatches
  let window: [String: Any]
  if titleMatches.count == 1 {
    window = titleMatches[0].0
  } else {
    let geometryMatches = scopedCandidates.filter {
      windowBoundsMatch($0.1, selectedBounds)
    }
    if geometryMatches.count > 1 {
      fail("target window mapping is ambiguous for scoped capture")
    }
    guard let matched = geometryMatches.first else {
      fail("target window is not available for scoped capture")
    }
    window = matched.0
  }
  guard let number = window[kCGWindowNumber as String] as? NSNumber else {
    fail("target window has no CGWindow identifier for scoped capture")
  }
  response = [
    "target": resolvedTarget, "windowId": number,
    "windowWidth": selectedBounds.width, "windowHeight": selectedBounds.height
  ]
default:
  fail("unsupported accessibility operation")
}

guard let output = try? JSONSerialization.data(withJSONObject: response) else { fail("could not encode response") }
FileHandle.standardOutput.write(output)
`;

export const MAC_FOREGROUND_INPUT_SOURCE = `import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\\n").utf8))
  exit(1)
}

guard AXIsProcessTrusted() else {
  fail("macOS Accessibility denied for helper at " + CommandLine.arguments[0] + ". If the current ZenX.app is already enabled in System Settings > Privacy & Security > Accessibility, remove the old ZenX entry, add the current ZenX.app again, and relaunch ZenX.")
}
let data = FileHandle.standardInput.readDataToEndOfFile()
guard let raw = try? JSONSerialization.jsonObject(with: data),
      let request = raw as? [String: Any],
      let operation = request["operation"] as? String else { fail("request must be JSON") }

let keyCodes: [String: CGKeyCode] = [
  "enter": 36, "escape": 53, "tab": 48, "backspace": 51, "space": 49,
  "arrowUp": 126, "arrowDown": 125, "arrowLeft": 123, "arrowRight": 124
]

func postKey(_ code: CGKeyCode) {
  // Preserve construction timing: native event metadata reflects creation time.
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) else {
    fail("could not construct keyboard press; no events dispatched")
  }
  down.post(tap: .cghidEventTap)
  usleep(20_000)
  guard let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
    fail("could not construct keyboard release; input partially dispatched; outcome unknown; do not retry automatically")
  }
  up.post(tap: .cghidEventTap)
}

switch operation {
case "click":
  guard let x = (request["x"] as? NSNumber)?.doubleValue,
        let y = (request["y"] as? NSNumber)?.doubleValue,
        let buttonName = request["button"] as? String else { fail("invalid click request") }
  let point = CGPoint(x: x, y: y)
  let right = buttonName == "right"
  let button: CGMouseButton = right ? .right : .left
  let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
  guard let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button) else {
    fail("could not construct mouse movement; no events dispatched")
  }
  moveEvent.post(tap: .cghidEventTap)
  guard let downEvent = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button) else {
    fail("could not construct mouse press; pointer movement dispatched; outcome unknown; do not retry automatically")
  }
  downEvent.post(tap: .cghidEventTap)
  usleep(30_000)
  guard let upEvent = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button) else {
    fail("could not construct mouse release; input partially dispatched; outcome unknown; do not retry automatically")
  }
  upEvent.post(tap: .cghidEventTap)
case "key":
  guard let key = request["key"] as? String, let code = keyCodes[key] else { fail("unsupported key") }
  postKey(code)
case "scroll":
  guard let number = request["deltaY"] as? NSNumber,
        number.doubleValue.isFinite,
        number.doubleValue.rounded() == number.doubleValue,
        number.doubleValue != 0,
        abs(number.doubleValue) <= 10000 else { fail("invalid scroll request") }
  let delta = number.int32Value
  guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -delta, wheel2: 0, wheel3: 0) else {
    fail("could not construct scroll input; no events dispatched")
  }
  event.post(tap: .cghidEventTap)
default:
  fail("unsupported foreground input operation")
}
`;

export async function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: string,
  signal?: AbortSignal,
  spawnProcess: typeof spawn = spawn,
  onStopping?: () => void,
): Promise<string> {
  signal?.throwIfAborted();
  return await new Promise<string>((resolve, reject) => {
    const child = spawnProcess(command, args, {
      shell: false,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let spawned = child.pid !== undefined;
    let terminationRequested = false;
    let failure: unknown;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const requestTermination = (reason: unknown): void => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      failure = reason;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        onStopping?.();
      } catch {
        /* Presentation cannot prevent termination. */
      }
      // kill() acknowledges sending a signal, not process termination. Even a
      // false return, throw or post-spawn error must retain the invocation until
      // native close. There is no timer that fabricates a stopped helper.
      try {
        child.kill("SIGKILL");
      } catch {
        /* The original failure is retained. */
      }
    };
    const timer = setTimeout(
      () =>
        requestTermination(
          new Error(
            `${path.basename(command)} timed out after ${String(timeoutMs)}ms`,
          ),
        ),
      timeoutMs,
    );
    const abort = (): void =>
      requestTermination(
        signal?.reason ??
          new DOMException(
            "The foreground operation was cancelled",
            "AbortError",
          ),
      );
    child.once("spawn", () => {
      spawned = true;
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!terminationRequested) stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!terminationRequested) stderr.push(chunk);
    });
    child.once("error", (error) => {
      if (!spawned && !terminationRequested) finish(() => reject(error));
      else requestTermination(error);
    });
    child.once("close", (code, exitSignal) => {
      finish(() => {
        if (terminationRequested) reject(failure);
        else if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
        else
          reject(
            new Error(
              `${path.basename(command)} failed (${exitSignal ?? String(code)}): ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 2048)}`,
            ),
          );
      });
    });
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin?.once("error", requestTermination);
    try {
      if (stdin !== undefined) child.stdin?.end(stdin, "utf8");
    } catch (error) {
      requestTermination(error);
    }
    if (signal?.aborted === true) abort();
  });
}

function foregroundTools(): ZenXPluginManifestV2["tools"] {
  const shared = {
    permissions: ["computer.foreground.control"],
    interactionMode: "foreground_required" as const,
    capabilities: ["global_input", "may_change_focus", "cancellable"],
  };
  return [
    {
      ...shared,
      name: "computer_foreground_click",
      description:
        "FOREGROUND TAKEOVER: move and click the real global pointer. ZenX shows the running tool before input begins; Stop cancels it.",
      inputSchema: objectSchema(
        {
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left", "right"] },
        },
        ["x", "y"],
      ),
    },
    {
      ...shared,
      name: "computer_foreground_key_press",
      description:
        "FOREGROUND TAKEOVER: press one allowlisted key in the focused control. Stop cancels the running operation.",
      inputSchema: objectSchema(
        {
          key: {
            type: "string",
            enum: [
              "enter",
              "escape",
              "tab",
              "backspace",
              "space",
              "arrowUp",
              "arrowDown",
              "arrowLeft",
              "arrowRight",
            ],
          },
        },
        ["key"],
      ),
    },
    {
      ...shared,
      name: "computer_foreground_scroll",
      description:
        "FOREGROUND TAKEOVER: scroll the current foreground target. Stop cancels the running operation.",
      inputSchema: objectSchema({ deltaY: { type: "number" } }, ["deltaY"]),
    },
  ];
}

function requiredTarget(arguments_: Record<string, unknown>): ComputerTarget {
  const raw = requiredObject(arguments_, "target");
  const pid = optionalPositiveInteger(raw, "pid");
  const applicationId = optionalString(raw, "applicationId");
  const bundleId = optionalString(raw, "bundleId");
  const windowTitle =
    raw.windowTitle === undefined
      ? undefined
      : requiredString(raw, "windowTitle", true);
  if (
    pid === undefined &&
    applicationId === undefined &&
    bundleId === undefined
  ) {
    throw new Error("target requires pid, applicationId, or bundleId");
  }
  if (windowTitle !== undefined && windowTitle.length > 4096) {
    throw new Error("target.windowTitle is limited to 4096 characters");
  }
  if (applicationId !== undefined && applicationId.length > 256) {
    throw new Error("target.applicationId is limited to 256 characters");
  }
  if (bundleId !== undefined && bundleId.length > 256) {
    throw new Error("target.bundleId is limited to 256 characters");
  }
  return {
    ...(pid === undefined ? {} : { pid }),
    ...(applicationId === undefined ? {} : { applicationId }),
    ...(bundleId === undefined ? {} : { bundleId }),
    ...(windowTitle === undefined ? {} : { windowTitle }),
  };
}

function requiredControl(
  arguments_: Record<string, unknown>,
): ComputerControlSelector {
  const raw = requiredObject(arguments_, "control");
  return {
    observationId: requiredOpaqueId(raw, "observationId"),
    targetId: requiredOpaqueId(raw, "targetId"),
  };
}

function requireScopedWindow(target: ComputerTarget, toolName: string): void {
  if (target.windowTitle === undefined) {
    throw new Error(
      `${toolName} requires target.windowTitle so the provider cannot inspect or act across sibling windows`,
    );
  }
}

async function foregroundTakeoverNotice(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1_000);
    const abort = (): void => {
      clearTimeout(timer);
      reject(
        signal.reason ??
          new DOMException(
            "The foreground operation was cancelled",
            "AbortError",
          ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function requiredFiniteNumber(
  arguments_: Record<string, unknown>,
  key: string,
): number {
  const value = arguments_[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function requiredComputerKey(arguments_: Record<string, unknown>): ComputerKey {
  const value = requiredString(arguments_, "key");
  if (!COMPUTER_KEYS.includes(value as ComputerKey)) {
    throw new Error(`Unsupported computer key: ${value}`);
  }
  return value as ComputerKey;
}

const COMPUTER_KEYS: readonly ComputerKey[] = [
  "enter",
  "escape",
  "tab",
  "backspace",
  "space",
  "arrowUp",
  "arrowDown",
  "arrowLeft",
  "arrowRight",
];

function requiredObject(
  arguments_: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = arguments_[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalPositiveInteger(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return candidate as number;
}

function requiredString(
  arguments_: Record<string, unknown>,
  key: string,
  allowEmpty = false,
): string {
  const value = arguments_[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  }
  return value;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return candidate;
}

function targetSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 1 },
      applicationId: stringSchema(),
      bundleId: stringSchema(),
      windowTitle: stringSchema(),
    },
    additionalProperties: false,
    anyOf: [
      { required: ["pid"] },
      { required: ["applicationId"] },
      { required: ["bundleId"] },
    ],
  };
}

function controlSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      observationId: stringSchema(),
      targetId: stringSchema(),
    },
    additionalProperties: false,
    required: ["observationId", "targetId"],
  };
}

function requiredOpaqueId(value: Record<string, unknown>, key: string): string {
  const candidate = requiredString(value, key);
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(candidate)) {
    throw new Error(`${key} must be an opaque identifier`);
  }
  return candidate;
}

function stringSchema(): Record<string, unknown> {
  return { type: "string" };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function requireMacOs(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "The bundled computer provider currently supports macOS only",
    );
  }
}

export const MAC_BOUND_TARGET_SOURCE = `import AppKit
import ApplicationServices
import Carbon
import Foundation
import Darwin

// SIGTERM cooperatively cancels this helper. No allocation or AppKit in handler.
var targetCancelled: sig_atomic_t = 0
signal(SIGTERM) { _ in targetCancelled = 1 }
func emit(_ value: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: value) {
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
  }
}
typealias WindowLocationSetter = @convention(c) (CGEvent, CGPoint) -> Void
let windowLocationLibrary = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY | RTLD_LOCAL)
let windowLocationSetter: WindowLocationSetter? = windowLocationLibrary.flatMap { dlsym($0, "CGEventSetWindowLocation") }.map { unsafeBitCast($0, to: WindowLocationSetter.self) }
func activeDesktop() throws {
  guard targetCancelled == 0 else { try refuse("Background input cancelled") }
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
        session[kCGSessionOnConsoleKey as String] as? Bool == true,
        session["CGSSessionScreenIsLocked"] as? Bool != true,
        CGDisplayIsAsleep(CGMainDisplayID()) == 0 else { try refuse("Background click requires an active unlocked desktop") }
  guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { try refuse("Background click requires existing Accessibility and post-event permission") }
}
struct DesktopFence: Equatable {
  let foreground: pid_t
  let pointer: CGPoint
  let windows: [Int]
  init() throws {
    guard let front = NSWorkspace.shared.frontmostApplication, let event = CGEvent(source: nil),
          let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { try refuse("Desktop focus/pointer/window order unavailable") }
    foreground = front.processIdentifier; pointer = event.location
    windows = rows.filter { ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue }
  }
}
func appStateEvent(_ subtype: Int16) throws -> CGEvent {
  guard let native = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, subtype: subtype, data1: 0, data2: 0), let event = native.cgEvent else { try refuse("Could not construct app-local preparation") }
  return event
}
func postToTarget(_ event: CGEvent, _ pid: pid_t) {
  event.timestamp = CGEvent(source: nil)?.timestamp ?? DispatchTime.now().uptimeNanoseconds
  event.postToPid(pid)
}


struct TargetError: Error { let message: String }
func refuse(_ message: String) throws -> Never { throw TargetError(message: message) }
func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
  return value
}
func windows(_ app: AXUIElement) -> [AXUIElement] {
  return attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
}
func frame(_ window: AXUIElement) -> CGRect? {
  guard let p = attribute(window, kAXPositionAttribute as CFString), CFGetTypeID(p) == AXValueGetTypeID(),
        let s = attribute(window, kAXSizeAttribute as CFString), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero; var size = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size),
        point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite,
        size.width > 0, size.height > 0 else { return nil }
  return CGRect(origin: point, size: size)
}
func cgId(_ app: NSRunningApplication, _ window: AXUIElement, _ bounds: CGRect) throws -> Int {
  let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let matches = entries.filter { item in
    guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier,
          (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          let raw = item[kCGWindowBounds as String] as? [String: Any],
          let x = raw["X"] as? Double, let y = raw["Y"] as? Double,
          let width = raw["Width"] as? Double, let height = raw["Height"] as? Double else { return false }
    return CGRect(x: x, y: y, width: width, height: height) == bounds
  }
  guard matches.count == 1, let id = matches[0][kCGWindowNumber as String] as? NSNumber else {
    try refuse("Window capture mapping is unavailable or ambiguous; reobserve")
  }
  return id.intValue
}
func pointerWindow(_ point: CGPoint, _ windowId: Int, _ appElement: AXUIElement, _ passthrough: Set<Int>) throws -> AXUIElement {
  // CGWindowList is front-to-back. Be conservative even for mouse-ignoring
  // overlays: foreground/focused AX state alone does not identify a pointer recipient.
  guard let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    try refuse("Pointer window ordering is unavailable")
  }
  var matched = false
  for item in entries {
    // Only main-owned, explicitly noninteractive edge indicators are exempt.
    // Same PID alone, window titles, alpha, and the interactive Stop card are not.
    if let id = item[kCGWindowNumber as String] as? NSNumber,
       passthrough.contains(id.intValue),
       (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == getppid() { continue }
    // Alpha and accessibility visibility are not proof that a window ignores
    // input. Even transparent containing windows are conservatively occluders.
    guard let raw = item[kCGWindowBounds as String] as? [String: Any],
          let x = raw["X"] as? Double, let y = raw["Y"] as? Double,
          let width = raw["Width"] as? Double, let height = raw["Height"] as? Double,
          x.isFinite, y.isFinite, width.isFinite, height.isFinite, width >= 0, height >= 0 else { try refuse("Pointer occlusion geometry is unavailable") }
    if !CGRect(x: x, y: y, width: width, height: height).contains(point) { continue }
    guard (item[kCGWindowNumber as String] as? NSNumber)?.intValue == windowId else { try refuse("Selected window is occluded at the input point") }
    matched = true
    break
  }
  guard matched else { try refuse("Selected window is not the visible pointer recipient") }
  var hit: AXUIElement?
  guard AXUIElementCopyElementAtPosition(appElement, Float(point.x), Float(point.y), &hit) == .success,
        let hit else { try refuse("Pointer recipient is unavailable") }
  if attribute(hit, kAXRoleAttribute as CFString) as? String == kAXWindowRole as String { return hit }
  guard let window = attribute(hit, kAXWindowAttribute as CFString), CFGetTypeID(window) == AXUIElementGetTypeID() else { try refuse("Pointer recipient window is ambiguous") }
  return window as! AXUIElement
}
final class Binding {
  let id = UUID().uuidString
  let app: NSRunningApplication
  let appElement: AXUIElement
  let window: AXUIElement
  let launch: Date
  let bounds: CGRect
  let windowId: Int
  let title: String
  init(_ target: [String: Any]) throws {
    let apps = NSWorkspace.shared.runningApplications.filter { app in
      if let pid = target["pid"] as? NSNumber, app.processIdentifier != pid.int32Value { return false }
      if let bundle = (target["bundleId"] ?? target["applicationId"]) as? String, app.bundleIdentifier != bundle { return false }
      return target["pid"] != nil || target["bundleId"] != nil || target["applicationId"] != nil
    }
    guard apps.count == 1, let app = apps.first, let launch = app.launchDate, !app.isTerminated else { try refuse("Application target is missing or ambiguous") }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    let candidates = windows(element).filter { window in
      guard let requested = target["windowTitle"] as? String else { return true }
      return attribute(window, kAXTitleAttribute as CFString) as? String == requested
    }
    // Application-only selection is permitted only when it has one unambiguous window.
    guard candidates.count == 1, let window = candidates.first, let bounds = frame(window) else { try refuse("Select one exact available window") }
    self.app = app; self.appElement = element; self.window = window; self.launch = launch; self.bounds = bounds
    self.windowId = try cgId(app, window, bounds)
    self.title = attribute(window, kAXTitleAttribute as CFString) as? String ?? ""
  }
  func verify() throws {
    guard !app.isTerminated, let current = NSRunningApplication(processIdentifier: app.processIdentifier), current.launchDate == launch,
          windows(appElement).contains(where: { CFEqual($0, window) }) else { try refuse("Selected window or application ended; reselect target") }
    guard frame(window) == bounds else { try refuse("Window geometry changed; recapture or reselect before input") }
    guard try cgId(app, window, bounds) == windowId else { try refuse("Window capture identity changed; reobserve") }
  }
  func focused() -> Bool {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
          let focused = attribute(appElement, kAXFocusedWindowAttribute as CFString), CFGetTypeID(focused) == AXUIElementGetTypeID() else { return false }
    return CFEqual(focused, window)
  }
  func activate() throws {
    try verify()
    guard app.activate(options: [.activateIgnoringOtherApps]) else { try refuse("Could not activate selected application") }
    guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { try refuse("Could not raise selected window") }
    for _ in 0..<30 {
      try verify()
      if focused() { return }
      usleep(10_000)
    }
    try refuse("Selected window did not acquire foreground focus; no input dispatched")
  }
  func fence() throws {
    try verify()
    guard focused() else { try refuse("Foreground focus changed; reobserve target") }
  }
  func pointerFence(_ point: CGPoint, _ passthrough: Set<Int>) throws {
    guard CFEqual(try pointerWindow(point, windowId, appElement, passthrough), window) else { try refuse("Pointer recipient is not the selected window") }
  }
  func receipt() -> [String: Any] {
    return ["bindingId": id, "windowId": windowId, "windowLocalInputAvailable": windowLocationSetter != nil,
      "target": ["pid": Int(app.processIdentifier), "applicationName": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "windowTitle": title],
      "bounds": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height]]
  }
}
// Only this operation uses PID-scoped window-local packets. Foreground input below
// retains its explicit global/activation semantics; there is no fallback between them.
func backgroundClickPair(_ binding: Binding, _ request: [String: Any], _ posted: inout Int) throws {
  var downPosted = false
  var preparationPosted = false
  var release: CGEvent?
  var deactivation: CGEvent?
  defer {
    // Once down is possible, neither cancellation nor a stale window can skip up.
    if downPosted, let release { postToTarget(release, binding.app.processIdentifier); posted += 1 }
    if preparationPosted, let deactivation { postToTarget(deactivation, binding.app.processIdentifier) }
    emit(["phase": "backgroundSettled", "release": downPosted ? "posted" : "not_needed"])
  }
  try activeDesktop()
  guard let setter = windowLocationSetter else { try refuse("Window-local input primitive unavailable") }
  guard let x = request["x"] as? Double, let y = request["y"] as? Double, x.isFinite, y.isFinite,
        binding.bounds.contains(CGPoint(x: x, y: y)) else { try refuse("Invalid bound background click point") }
  try binding.verify()
  guard attribute(binding.window, kAXTitleAttribute as CFString) as? String == binding.title else { try refuse("Window title changed; recapture before background input") }
  let baseline = try DesktopFence()
  guard baseline.windows.contains(binding.windowId) else { try refuse("Selected window is not currently observable") }
  let global = CGPoint(x: x, y: y)
  let local = CGPoint(x: x - binding.bounds.minX, y: y - binding.bounds.minY)
  let cocoa = CGPoint(x: local.x, y: binding.bounds.height - local.y)
  func mouse(_ type: NSEvent.EventType) throws -> CGEvent {
    guard let native = NSEvent.mouseEvent(with: type, location: cocoa, modifierFlags: [], timestamp: 0, windowNumber: binding.windowId, context: nil, eventNumber: 1, clickCount: 1, pressure: 1), let event = native.cgEvent else { try refuse("Could not construct window-local mouse pair") }
    event.flags = []; event.location = global
    event.setIntegerValueField(.mouseEventButtonNumber, value: 0)
    event.setIntegerValueField(.mouseEventClickState, value: 1)
    // Source-observed value; macOS exposes no public semantic name for value 3.
    event.setIntegerValueField(.mouseEventSubtype, value: 3)
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(binding.windowId))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(binding.windowId))
    setter(event, local)
    guard event.location == global else { try refuse("Window-local coordinate preparation changed global point") }
    return event
  }
  let down = try mouse(.leftMouseDown)
  release = try mouse(.leftMouseUp)
  // Preparation changes only the target application's internal focus belief. It
  // must not change OS foreground, pointer or external Z; those remain fenced.
  if baseline.foreground != binding.app.processIdentifier {
    let activation = try appStateEvent(1)
    deactivation = try appStateEvent(2)
    try activeDesktop(); try binding.verify()
    guard try DesktopFence() == baseline else { try refuse("Desktop changed before app-local preparation") }
    postToTarget(activation, binding.app.processIdentifier); preparationPosted = true
    usleep(30_000)
  }
  try activeDesktop(); try binding.verify()
  guard try DesktopFence() == baseline else { try refuse("Desktop changed before background input") }
  // Both events are prebuilt; there are no AX/IPC/await calls between down and
  // its unconditional deferred up, even if SIGTERM interrupts the short wait.
  emit(["phase": "backgroundPairStarted"])
  downPosted = true
  postToTarget(down, binding.app.processIdentifier); posted += 1
  usleep(30_000)
}

func backgroundClick(_ binding: Binding, _ request: [String: Any], _ posted: inout Int) throws {
  let baseline = try DesktopFence()
  try backgroundClickPair(binding, request, &posted)
  usleep(30_000)
  try activeDesktop()
  guard try DesktopFence() == baseline else { try refuse("Desktop focus/pointer/window order changed after background posting") }
}

struct KeyboardLayout {
  let id: String
  let translate: (CGKeyCode, Bool) throws -> String
}
func readKeyboardLayout() throws -> KeyboardLayout {
  guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let active = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
        let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData),
        let rawId = TISGetInputSourceProperty(source, kTISPropertyInputSourceID),
        let activeId = TISGetInputSourceProperty(active, kTISPropertyInputSourceID) else { try refuse("Current keyboard layout is unavailable; no ANSI fallback") }
  let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
  let id = (Unmanaged<CFString>.fromOpaque(rawId).takeUnretainedValue() as String) + ":" + (Unmanaged<CFString>.fromOpaque(activeId).takeUnretainedValue() as String)
  let keyboardType = UInt32(LMGetKbdType())
  return KeyboardLayout(id: id + ":" + String(keyboardType), translate: { code, command in
    guard let bytes = CFDataGetBytePtr(data) else { try refuse("Keyboard layout data is unavailable") }
    let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
    var dead: UInt32 = 0
    var length = 0
    var output = [UniChar](repeating: 0, count: 8)
    let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), command ? UInt32(cmdKey) >> 8 : 0,
      keyboardType, OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, output.count, &length, &output)
    guard status == noErr, dead == 0 else { return "" }
    return String(utf16CodeUnits: output, count: length)
  })
}
func resolveShortcut(_ key: String, _ modifiers: [String]) throws -> (CGKeyCode, CGEventFlags, String?) {
  guard !modifiers.isEmpty, modifiers.count <= 4, Set(modifiers).count == modifiers.count,
        modifiers.allSatisfy({ ["command", "control", "option", "shift"].contains($0) }) else { try refuse("Invalid shortcut modifiers") }
  var flags: CGEventFlags = []
  if modifiers.contains("command") { flags.insert(.maskCommand) }
  if modifiers.contains("control") { flags.insert(.maskControl) }
  if modifiers.contains("option") { flags.insert(.maskAlternate) }
  if modifiers.contains("shift") { flags.insert(.maskShift) }
  if let code = keyCodes[key] { return (code, flags, nil) }
  guard key.utf8.count == 1, "abcdefghijklmnopqrstuvwxyz0123456789".contains(key) else { try refuse("Unsupported logical shortcut key") }
  let layout = try readKeyboardLayout()
  var matches: [CGKeyCode] = []
  // Logical base key under the current Command layout when Command is present.
  // Other modifiers apply separately; do not search Option/dead-key output text.
  for code in CGKeyCode(0)...CGKeyCode(63) {
    if try layout.translate(code, modifiers.contains("command")).lowercased() == key { matches.append(code) }
  }
  guard matches.count == 1 else { try refuse("Logical shortcut key has no unique mapping in current keyboard layout") }
  return (matches[0], flags, layout.id)
}
func unicodeChunks(_ text: String) throws -> [[UniChar]] {
  guard !text.isEmpty, text.unicodeScalars.count <= 1024 else { try refuse("Typing requires 1 to 1024 Unicode scalars") }
  var chunks: [[UniChar]] = []; var current: [UniChar] = []
  for scalar in text.unicodeScalars {
    let units = Array(String(scalar).utf16)
    if current.count + units.count > 16 { chunks.append(current); current = [] }
    current.append(contentsOf: units)
  }
  if !current.isEmpty { chunks.append(current) }
  return chunks
}

let keyCodes: [String: CGKeyCode] = ["enter":36, "escape":53, "tab":48, "backspace":51, "space":49, "arrowUp":126, "arrowDown":125, "arrowLeft":123, "arrowRight":124]
var bindings: [String: Binding] = [:]
while let line = readLine() {
  var posted = 0
  var owner = ""
  var expectedBindingId: String?
  var reply: [String: Any]
  do {
    guard AXIsProcessTrusted() else { try refuse("macOS Accessibility permission is not granted") }
    guard let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let operation = request["operation"] as? String, let requestedOwner = request["owner"] as? String, !requestedOwner.isEmpty else { try refuse("Invalid target request") }
    owner = requestedOwner
    expectedBindingId = request["bindingId"] as? String
    if operation == "select" {
      bindings.removeValue(forKey: owner)
      guard bindings.count < 32, let target = request["target"] as? [String: Any] else { try refuse("Target capacity reached or target missing") }
      let binding = try Binding(target)
      bindings[owner] = binding
      reply = ["result": binding.receipt()]
    } else {
      guard let binding = bindings[owner], request["bindingId"] as? String == binding.id else { try refuse("Target binding expired; select again") }
      try binding.verify()
      if operation == "verify" { reply = ["result": binding.receipt()] }
      else if operation == "backgroundClick" {
        try backgroundClick(binding, request, &posted)
        reply = ["result": ["dispatch": "posted", "applicationEffect": "unverified", "release": "posted", "internalFocusMayChange": true]]
      }
      else {
        // All target activation occurs after the host's approval and foreground arbitration.
        try binding.activate()
        var shortcutFence: (() throws -> Void)?
        var pointerPoint: CGPoint?
        let passthroughIds = request["pointerPassthroughWindowIds"] as? [Int] ?? []
        guard passthroughIds.count <= 64, passthroughIds.allSatisfy({ $0 > 0 }) else { try refuse("Invalid foreground indicator identity") }
        let passthrough = Set(passthroughIds)
        func post(_ event: CGEvent?) throws {
          guard let event else { try refuse("Could not construct native input") }
          try binding.fence()
          try shortcutFence?()
          if let pointerPoint { try binding.pointerFence(pointerPoint, passthrough) }
          event.post(tap: .cghidEventTap)
          posted += 1
        }
        switch operation {
        case "click":
          guard let x = request["x"] as? Double, let y = request["y"] as? Double, x.isFinite, y.isFinite,
                let buttonName = request["button"] as? String, ["left", "right"].contains(buttonName),
                binding.bounds.contains(CGPoint(x: x, y: y)) else { try refuse("Invalid bound click point") }
          let point = CGPoint(x: x, y: y); let right = buttonName == "right"; let button: CGMouseButton = right ? .right : .left
          pointerPoint = point
          try post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button))
          try post(CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: point, mouseButton: button))
          usleep(30_000)
          try post(CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: button))
        case "key":
          guard let key = request["key"] as? String, let code = keyCodes[key] else { try refuse("Unsupported bound key") }
          try post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true))
          usleep(20_000)
          try post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false))
        case "type":
          guard let text = request["text"] as? String else { try refuse("Typing text is required") }
          let chunks = try unicodeChunks(text)
          for units in chunks {
            for down in [true, false] {
              let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
              event?.flags = []
              units.withUnsafeBufferPointer { buffer in
                event?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
              }
              try post(event)
              if down { usleep(5_000) }
            }
          }
        case "shortcut":
          guard let key = request["key"] as? String, let modifiers = request["modifiers"] as? [String] else { try refuse("Shortcut key and modifiers are required") }
          let (code, flags, layoutId) = try resolveShortcut(key, modifiers)
          shortcutFence = {
            let fresh = try resolveShortcut(key, modifiers)
            guard fresh.0 == code, fresh.1 == flags, fresh.2 == layoutId else { try refuse("Keyboard input source or mapping changed; reobserve before shortcut") }
          }
          let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
          down?.flags = flags
          try post(down)
          usleep(20_000)
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
          up?.flags = flags
          try post(up)
        case "scroll":
          guard let value = request["deltaY"] as? Double, value.isFinite, abs(value) <= 10000, value.rounded() != 0 else { try refuse("Invalid scroll pixels") }
          let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -Int32(value.rounded()), wheel2: 0, wheel3: 0)
          event?.location = CGPoint(x: binding.bounds.midX, y: binding.bounds.midY)
          pointerPoint = CGPoint(x: binding.bounds.midX, y: binding.bounds.midY)
          try post(event)
        default: try refuse("Unsupported bound operation")
        }
        reply = ["result": ["dispatch": "posted", "applicationEffect": "unverified"]]
      }
    }
  } catch {
    // A stale request must not revoke a newer selection for the same owner.
    if let expectedBindingId, bindings[owner]?.id == expectedBindingId {
      bindings.removeValue(forKey: owner)
    }
    let message = (error as? TargetError)?.message ?? "Invalid native target request"
    let outcome = posted == 0 ? "; no input dispatched" : "; input partially dispatched; outcome unknown; do not retry automatically"
    reply = ["error": message + outcome]
  }
  if let output = try? JSONSerialization.data(withJSONObject: reply) {
    FileHandle.standardOutput.write(output); FileHandle.standardOutput.write(Data([10]))
  } else { exit(1) }
  if targetCancelled != 0 { exit(0) }
}
`;

function requiredComputerOwner(invocation: ToolInvocation): string {
  if (!invocation.threadId)
    throw new Error("Bound Computer input requires a host-owned threadId");
  return invocation.threadId;
}

function requiredComputerTypingText(
  arguments_: Record<string, unknown>,
): string {
  const text = requiredString(arguments_, "text");
  if (Array.from(text).length > 1024 || /[\uD800-\uDFFF]/u.test(text))
    throw new Error("text must contain 1 to 1024 well-formed Unicode scalars");
  return text;
}
function requiredComputerShortcut(arguments_: Record<string, unknown>): {
  key: string;
  modifiers: string[];
} {
  const key = requiredString(arguments_, "key");
  const modifiers = arguments_.modifiers;
  if (
    !COMPUTER_SHORTCUT_KEYS.includes(key) ||
    !Array.isArray(modifiers) ||
    modifiers.length < 1 ||
    modifiers.length > 4 ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.every(
      (value): value is string =>
        typeof value === "string" &&
        ["command", "control", "option", "shift"].includes(value),
    )
  )
    throw new Error("Unsupported shortcut key or modifiers");
  return { key, modifiers };
}

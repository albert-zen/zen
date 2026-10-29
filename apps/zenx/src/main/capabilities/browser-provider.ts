import {
  attachBrowserModelTargets,
  readBrowserModelRoute,
  type BrowserModelRoute,
} from "./model-browser-metadata.js";
import { BROWSER_PLUGIN_VERSION } from "../../../../../packages/zenx-browser-plugin/src/version.js";
import { withBrowserOperationOrder } from "./browser-operation-order.js";
import {
  assertBrowserInputSnapshot,
  browserInputKeys,
  browserInputKey,
  browserInputProbeScript,
  browserInputSnapshotScript,
  browserTargetedInputPolicy,
  dispatchBrowserTargetedInput,
  requireBrowserInputSnapshot,
  includesBrowserInputSnapshot,
  resolveBrowserInputEvidence,
  type BrowserInputKey,
  type BrowserInputObservation,
  type BrowserInputViewport,
} from "./browser-targeted-input.js";
import { observeElectronPage } from "./browser-electron-observation.js";
import {
  ObservationPresentation,
  observationReadOptions,
  observationReadProperties,
  MAX_OBSERVATION_PAGE_BYTES,
  type ObservationReadOptions,
} from "./observation-presentation.js";
import {
  OBSERVATION_CAPTURE,
  MAX_OBSERVATION_CAPTURE_ITEMS,
  MAX_OBSERVATION_CAPTURE_TEXT,
  type ObservationCapture,
} from "./observation-capture.js";
import {
  BrowserThreadObservation,
  type BrowserThreadRequest,
  type BrowserThreadListener,
} from "./browser-thread-observation.js";
import { randomUUID } from "node:crypto";
import {
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import {
  boundedBrowserQuery,
  focusCapturedTargets,
  searchCapturedTargets,
} from "../../../../../packages/zenx-browser-plugin/src/model-observation.js";

import type { BrowserWindow, Session } from "electron";

import type { ToolInvocation } from "../../../../../src/tool.js";
import type { ZenXPluginManifestV2, ZenXCapabilityPackage } from "./types.js";

export interface BrowserTabGrouping {
  status: "grouped" | "failed" | "unavailable" | "unknown";
  groupId?: number;
  reason?: string;
}

export interface BrowserTabSummary {
  sessionId: string;
  tabId: string;
  title: string;
  url: string;
  loading: boolean;
  /** Optional visual grouping outcome for an agent-created external tab; not authority. */
  grouping?: BrowserTabGrouping;
  /** Shared Workspace Browser only; other backends omit control metadata. */
  control?: "agent" | "human";
  agentActionsInFlight?: number;
  agentActionOutcomeUnknown?: boolean;
  requiresFreshObservation?: boolean;
  mutationsRequireObservation?: boolean;
}

export interface BrowserInspection extends BrowserTabSummary {
  [OBSERVATION_CAPTURE]?: ObservationCapture<
    BrowserInspection["targets"][number]
  >;
  observationId: string;
  documentVersion: number;
  visibleText: string;
  screenshot: BrowserScreenshotArtifact;
  inputViewport?: BrowserInputViewport;
  focusedInputAvailable?: boolean;
  inputPolicy?: typeof browserTargetedInputPolicy;
  targets: Array<{
    targetId: string;
    role: string;
    name: string;
    actions: BrowserTargetAction[];
    value?: string;
    checked?: boolean;
    selected?: boolean;
    options?: BrowserSelectOption[];
    optionsTruncated?: boolean;
  }>;
}

export type BrowserTargetAction = "click" | "type" | "select";

export interface BrowserSelectOption {
  value: string;
  label: string;
  selected: boolean;
  disabled: boolean;
}

export interface BrowserScreenshotArtifact {
  artifactPath: string;
  observationId: string;
  status: "captured" | "fallback";
  reason?: string;
  width: number;
  height: number;
  bytes: number;
  expiresAt: string;
}

export type BrowserLiveObservationStatus =
  "idle" | "connecting" | "live" | "unavailable" | "failed";

export interface BrowserLiveObservationFrame {
  sequence: number;
  mimeType: "image/jpeg";
  data: string;
  width: number;
  height: number;
}

export type BrowserLiveObservationEvent =
  | {
      type: "status";
      status: BrowserLiveObservationStatus;
      message: string;
      /** Bounded owner-local error fields; not a model/tool result or remote export. */
      details?: string;
    }
  | { type: "frame"; frame: BrowserLiveObservationFrame }
  | { type: "metadata"; title: string; url: string; loading?: boolean };

export type BrowserLiveObservationListener = (
  event: BrowserLiveObservationEvent,
) => void;

export interface ZenXBrowserBackend {
  /** Bind the provider's opaque session to its trusted Thread owner. */
  bindThreadSession?(sessionId: string, threadId: string): void;
  /** Read-only exact existing-target liveness; must never adopt or create targets. */
  hasTab?(sessionId: string, tabId: string): boolean | Promise<boolean>;
  /** Trusted human UI only: never include the unredacted URL in tool results. */
  readCurrentUrl?(sessionId: string, tabId: string): Promise<string>;
  scroll?(
    sessionId: string,
    tabId: string,
    observationId: string,
    direction: BrowserScrollDirection,
    pixels: number,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  observeTab?(
    sessionId: string,
    tabId: string,
    listener: BrowserLiveObservationListener,
  ): () => void;
  listTabs(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary[]>;
  open(
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  navigate(
    sessionId: string,
    tabId: string,
    url: string,
    signal?: AbortSignal,
    observationId?: string,
  ): Promise<BrowserTabSummary>;
  inspect(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<BrowserInspection>;
  click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  type(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  pointerClick?(
    sessionId: string,
    tabId: string,
    observationId: string,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  keyPress?(
    sessionId: string,
    tabId: string,
    observationId: string,
    key: BrowserInputKey,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  select?(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    option: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary>;
  closeTab(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
    observationId?: string,
  ): Promise<void> | void;
  closeSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<number> | number;
  close(): Promise<void> | void;
}

export const browserCapabilityManifest: ZenXPluginManifestV2 = {
  schemaVersion: 2,
  id: "browser",
  name: "Browser",
  version: BROWSER_PLUGIN_VERSION,
  description:
    "A dedicated ephemeral ZenX browser session with bounded DOM inspection and narrow navigation and interaction tools.",
  compatibility: { zenx: ">=0.1.0 <0.2.0" },
  runtime: { type: "bundled", entry: "zenx/browser" },
  mainDocument:
    "Browser actions observe by default with a small backend-captured subset and use exact backend-scoped refs. Use full:true for a broader self-contained capture. Inspect returns a bounded capture; query searches captured targets only, and cursor reads its immutable continuation. Pass since with a retained observation ref for a diff, or full:true after context loss. Every new observation has new action refs; diff targetChanges.replacements maps old refs to fresh refs. Discard prior continuation pages on every new observation or first-page diff and follow its new nextCursor for tails. Human takeover blocks Workspace mutations until the user returns control and a fresh inspection is made. If actionCompleted has observationError, inspect again without repeating the action. Unknown effects must not be replayed. Connected browsers require explicit connection discovery and approval; they never fall back to Workspace.",
  provider: {
    id: "electron-dedicated-browser",
    platforms: ["darwin", "win32", "linux"],
    interactionModes: ["background_safe"],
    capabilities: [
      "dedicated_profile",
      "cdp",
      "dom.inspect",
      "dom.navigate",
      "dom.interact",
    ],
  },
  permissions: [
    {
      id: "browser.tabs.read",
      title: "Inspect browser tabs",
      description:
        "List tabs and inspect bounded visible text and interactive targets.",
      scope: "browser-session",
    },
    {
      id: "browser.navigate",
      title: "Open and navigate pages",
      description:
        "Open URLs or navigate an explicitly targeted ZenX browser tab.",
      scope: "browser-session",
    },
    {
      id: "browser.interact",
      title: "Interact with pages",
      description:
        "Click, type, or select an option in an explicitly targeted visible page element, scroll the page viewport, or dispatch bounded coordinate/key input to the observed tab.",
      scope: "browser-session",
    },
  ],
  ui: {
    bundles: [
      {
        id: "main",
        apiVersion: 1,
        kind: "trusted",
        entry: "zenx/bundled/browser-ui",
      },
    ],
    surfaces: [
      {
        id: "browser-page",
        bundleId: "main",
        exportName: "browser-page",
      },
    ],
  },
  contributions: {
    pages: [
      {
        id: "browser",
        title: "Browser",
        route: "/plugins/browser/browser",
        surfaceId: "browser-page",
      },
    ],
    sidebar: [],
  },
  tools: [
    {
      name: "browser_list_tabs",
      description:
        "List bounded metadata for tabs in one explicit ZenX browser session. Cookies, storage, headers, and history are never returned.",
      inputSchema: objectSchema({ sessionId: stringSchema() }, ["sessionId"]),
      permissions: ["browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "tab_metadata.read"],
      maxOutputBytes: 8 * 1024,
    },
    {
      name: "browser_open",
      description:
        "Open an http(s) URL in a hidden tab in an explicit ephemeral ZenX browser session. Returns the new tabId without activating an app window.",
      inputSchema: objectSchema(
        {
          sessionId: stringSchema(),
          url: stringSchema(),
          observe: observationOption(),
          baseObservationId: observationReadProperties.baseObservationId,
          full: observationReadProperties.full,
        },
        ["sessionId", "url"],
      ),
      permissions: ["browser.navigate", "browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.navigate"],
      maxOutputBytes: MAX_OBSERVATION_PAGE_BYTES,
    },
    {
      name: "browser_navigate",
      description:
        "Navigate one explicit ZenX browser session/tab target to an http(s) URL.",
      inputSchema: browserTargetSchema(
        {
          url: stringSchema(),
          observationId: handoffObservationOption(),
          observe: observationOption(),
          baseObservationId: observationReadProperties.baseObservationId,
          full: observationReadProperties.full,
        },
        ["url"],
      ),
      permissions: ["browser.navigate", "browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.navigate"],
      maxOutputBytes: MAX_OBSERVATION_PAGE_BYTES,
    },
    {
      name: "browser_inspect",
      description:
        "Inspect one tab, or use nextCursor to read more of its exact captured snapshot. Coverage distinguishes unread captured data from native omissions. Omit baseObservationId or set full:true for a self-contained first page; a retained matching base allows a smaller diff. Target IDs are stable only for surviving observed DOM nodes; actions require the fresh observationId.",
      inputSchema: browserTargetSchema({
        ...observationReadProperties,
        query: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description:
            "Search role, name, and value within this backend's captured targets. Coverage names the capture scope; a miss is not a whole-page claim. Follow nextCursor for more matches from the same capture.",
        },
      }),
      permissions: ["browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.inspect"],
      maxOutputBytes: MAX_OBSERVATION_PAGE_BYTES,
    },
    {
      name: "browser_click",
      description:
        "Click one visible, clickable opaque target from the latest browser_inspect observation. Stale, forged, hidden, or changed targets fail closed.",
      inputSchema: browserTargetSchema(
        {
          observationId: stringSchema(),
          targetId: stringSchema(),
          observe: observationOption(),
          baseObservationId: observationReadProperties.baseObservationId,
          full: observationReadProperties.full,
        },
        ["observationId", "targetId"],
      ),
      permissions: ["browser.interact", "browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.click"],
      maxOutputBytes: MAX_OBSERVATION_PAGE_BYTES,
    },
    ...browserTargetedInputTools(),
    {
      name: "browser_type",
      description:
        "Replace the value in one visible, typeable opaque target from the latest browser_inspect observation, optionally submitting its form. Text is dispatched as an ordinary tool argument regardless of field metadata.",
      inputSchema: browserTargetSchema(
        {
          observe: observationOption(),
          baseObservationId: observationReadProperties.baseObservationId,
          full: observationReadProperties.full,
          observationId: stringSchema(),
          targetId: stringSchema(),
          text: stringSchema(),
          submit: { type: "boolean" },
        },
        ["observationId", "targetId", "text"],
      ),
      permissions: ["browser.interact", "browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.set_value"],
      maxOutputBytes: MAX_OBSERVATION_PAGE_BYTES,
    },
    {
      name: "browser_select",
      description:
        "Select one native option by exact value or unique exact visible label in a visible select target from the latest browser_inspect observation. Consumes the observation and fails closed if the target or option changed.",
      inputSchema: browserTargetSchema(
        {
          observe: observationOption(),
          baseObservationId: observationReadProperties.baseObservationId,
          full: observationReadProperties.full,
          observationId: stringSchema(),
          targetId: stringSchema(),
          option: stringSchema(),
        },
        ["observationId", "targetId", "option"],
      ),
      permissions: ["browser.interact", "browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.select_option"],
      maxOutputBytes: MAX_OBSERVATION_PAGE_BYTES,
    },
    {
      name: "browser_scroll",
      description:
        "Scroll the page viewport in one explicit tab using the latest browser_inspect observation. Direction is up/down/left/right and pixels is an integer from 1 to 2000. Consumes the observation; inspect again before interacting. Nested scrolling containers are not supported.",
      inputSchema: browserTargetSchema(
        {
          observe: observationOption(),
          baseObservationId: observationReadProperties.baseObservationId,
          full: observationReadProperties.full,
          observationId: stringSchema(),
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          pixels: { type: "integer", minimum: 1, maximum: 2000 },
        },
        ["observationId", "direction", "pixels"],
      ),
      permissions: ["browser.interact", "browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "dom.scroll"],
      maxOutputBytes: MAX_OBSERVATION_PAGE_BYTES,
    },
    {
      name: "browser_close",
      description:
        "Close one explicit ZenX browser tab and invalidate its latest observation.",
      inputSchema: browserTargetSchema({
        observationId: handoffObservationOption(),
      }),
      permissions: ["browser.navigate"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "tab.close"],
    },
    {
      name: "browser_close_session",
      description:
        "Close every hidden tab in one explicit ZenX browser session, clear its storage/cache, and ensure reopening the same sessionId uses a fresh partition.",
      inputSchema: objectSchema({ sessionId: stringSchema() }, ["sessionId"]),
      permissions: ["browser.navigate"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "session.close"],
    },
  ],
};

function browserTargetedInputTools(): ZenXPluginManifestV2["tools"] {
  const common = () => ({
    observationId: stringSchema(),
    observe: observationOption(),
    baseObservationId: structuredClone(
      observationReadProperties.baseObservationId,
    ),
    full: structuredClone(observationReadProperties.full),
  });
  return [
    {
      name: "browser_pointer_click",
      description:
        "Click CSS viewport coordinates in the exact observed browser tab without requesting window activation. Requires a real screenshot and inputViewport from the latest inspection. Convert screenshot pixels with x * inputViewport.width / screenshot.width and likewise y. No frames, dragging, OS input or automatic foreground fallback. Detected page, viewport, focus, or user input changes reject. Open shadow roots resolve within bounded limits; ordinary div/span containers remain supported after exact-node metadata checks, while known closed or unresolved shadow surfaces reject locally. Ordinary tab input stays targeted without selecting an active tab. Trusted input can trigger site dialogs or popups; identifiable native pickers reject and native UI requires human control, never global input or forced activation. Unknown input is never replayed.",
      inputSchema: browserTargetSchema(
        {
          ...common(),
          x: { type: "number", minimum: 0 },
          y: { type: "number", minimum: 0 },
        },
        ["observationId", "x", "y"],
      ),
      permissions: ["browser.interact", "browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "input.pointer"],
      maxOutputBytes: MAX_OBSERVATION_PAGE_BYTES,
    },
    {
      name: "browser_key_press",
      description:
        "Press one named unmodified key in the exact browser tab's already-focused observed element, without requesting window activation. Requires focusedInputAvailable and a fresh inspection; never selects a current tab or focuses an element implicitly. Open shadow focus resolves to its real node; ordinary focused contenteditable containers remain supported after exact-node metadata checks, while known closed or unresolved shadow focus is unavailable. Ordinary tab input stays targeted without selecting an active tab. Trusted input can trigger site dialogs or popups; identifiable native pickers reject and native UI requires human control, never global input or forced activation. Unknown input is never replayed.",
      inputSchema: browserTargetSchema(
        { ...common(), key: { type: "string", enum: [...browserInputKeys] } },
        ["observationId", "key"],
      ),
      permissions: ["browser.interact", "browser.tabs.read"],
      interactionMode: "background_safe",
      capabilities: ["dedicated_profile", "cdp", "input.keyboard"],
      maxOutputBytes: MAX_OBSERVATION_PAGE_BYTES,
    },
  ];
}

function optionalTargetId(
  arguments_: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  return arguments_[name] === undefined
    ? undefined
    : requiredTargetId(arguments_, name);
}

function handoffObservationOption() {
  return {
    type: "string",
    description:
      "Required for a shared Workspace tab after human takeover: pass its latest browser_inspect observationId. Missing, stale, or pre-takeover references reject. Other backends do not require this field.",
  };
}

function observationOption() {
  return {
    type: "boolean",
    description:
      "Return a fresh observation after the action; defaults to true. Set false to skip the read. A failed follow-up read never retries the completed action.",
  };
}

const BROWSER_OBSERVABLE_ACTIONS = new Set([
  "browser_open",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_scroll",
  "browser_pointer_click",
  "browser_key_press",
]);

export class BrowserZenXCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest: ZenXPluginManifestV2;
  readonly #backend: ZenXBrowserBackend;
  readonly #threadObservation: BrowserThreadObservation;
  readonly #ownsBackend: boolean;
  #closePromise: Promise<void> | undefined;
  readonly #presentation: ObservationPresentation<
    BrowserInspection["targets"][number]
  >;

  constructor(
    backend: ZenXBrowserBackend,
    manifest: ZenXPluginManifestV2 = browserCapabilityManifest,
    options: { ownsBackend?: boolean } = {},
  ) {
    this.#ownsBackend = options.ownsBackend ?? true;
    this.#backend = backend;
    this.#threadObservation = new BrowserThreadObservation(backend);
    this.#presentation = new ObservationPresentation({
      itemsField: "targets",
      changesField: "targetChanges",
      textField: "visibleText",
      pageItems: manifest.provider?.id === "playwright-cli" ? 128 : 80,
      identityKind: "dom-node",
      getId: (target) => target.targetId,
      withId: (target, targetId) => ({ ...target, targetId }),
    });
    this.manifest = manifest;
  }

  invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    return withBrowserOperationOrder(
      () => this.#invokeOrdered(toolName, invocation),
      true,
    );
  }

  async #invokeOrdered(
    toolName: string,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    const expected = readBrowserModelRoute(invocation);
    if (expected) {
      if (
        expected.sessionId !== invocation.arguments.sessionId ||
        expected.tabId !== invocation.arguments.tabId
      )
        throw Error("Browser reference does not match the exact native target");
      this.assertModelTarget(expected, invocation.threadId);
    }
    if (invocation.threadId === undefined)
      return await this.#invokeAndObserve(toolName, invocation);
    const publicSessionId = requiredTargetId(invocation.arguments, "sessionId");
    const session = this.#threadObservation.session(
      invocation.threadId,
      publicSessionId,
    );
    const settle = this.#threadObservation.operation(
      session,
      toolName,
      invocation,
    );
    let result: unknown;
    try {
      result = await this.#invokeAndObserve(toolName, {
        ...invocation,
        arguments: {
          ...invocation.arguments,
          sessionId: session.providerSessionId,
        },
      });
      this.#threadObservation.publish(
        session,
        toolName,
        result,
        typeof invocation.arguments.tabId === "string"
          ? invocation.arguments.tabId
          : undefined,
      );
      settle(false, result);
    } catch (error) {
      settle(true);
      throw error;
    }
    const project = (value: unknown) =>
      typeof value === "object" && value !== null && "sessionId" in value
        ? { ...value, sessionId: publicSessionId }
        : value;
    const projected = Array.isArray(result)
      ? result.map(project)
      : project(result);
    const metadata = this.#threadObservation.modelTargets(
      invocation.threadId,
      publicSessionId,
    );
    return projected && typeof projected === "object" && metadata
      ? attachBrowserModelTargets(projected, metadata)
      : projected;
  }

  assertModelTarget(
    route: BrowserModelRoute,
    threadId: string | undefined,
  ): void {
    this.#threadObservation.assertModelTarget(route, threadId);
  }

  observeThread(
    request: BrowserThreadRequest,
    listener: BrowserThreadListener,
  ): () => void {
    return this.#threadObservation.observe(request, listener);
  }

  async readModelTarget(
    threadId: string,
    targetId: string,
  ): Promise<BrowserModelRoute | undefined> {
    return await this.#threadObservation.readModelTarget(threadId, targetId);
  }

  async readTargetUrl(threadId: string, targetId: string): Promise<string> {
    return await this.#threadObservation.readTargetUrl(threadId, targetId);
  }

  async #invokeAndObserve(
    toolName: string,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    const observe =
      optionalBoolean(invocation.arguments, "observe") ??
      BROWSER_OBSERVABLE_ACTIONS.has(toolName);
    const options = observationReadOptions(invocation.arguments);
    if (options.cursor !== undefined && toolName !== "browser_inspect")
      throw new Error("cursor is only supported by browser_inspect");
    if (
      toolName !== "browser_inspect" &&
      !observe &&
      (options.baseObservationId !== undefined || options.full === true)
    )
      throw new Error(
        "baseObservationId/full requires browser_inspect or observe:true",
      );
    if (toolName === "browser_inspect") {
      const sessionId = requiredTargetId(invocation.arguments, "sessionId");
      const tabId = requiredTargetId(invocation.arguments, "tabId");
      const key = this.#observationKey(sessionId, tabId);
      if (options.cursor !== undefined)
        return await this.#presentation.read(
          key,
          options.cursor,
          invocation.signal,
        );
      return this.#presentInspection(
        await this.#backend.inspect(sessionId, tabId, invocation.signal),
        options,
        boundedBrowserQuery(invocation.arguments.query),
      );
    }
    const sessionId = requiredTargetId(invocation.arguments, "sessionId");
    const tabId =
      typeof invocation.arguments.tabId === "string"
        ? invocation.arguments.tabId
        : undefined;
    const key =
      tabId === undefined ? undefined : this.#observationKey(sessionId, tabId);
    if (
      key !== undefined &&
      [
        "browser_click",
        "browser_type",
        "browser_select",
        "browser_scroll",
        "browser_pointer_click",
        "browser_key_press",
      ].includes(toolName)
    ) {
      if (invocation.threadId !== undefined || this.#presentation.has(key)) {
        const observationId = requiredTargetId(
          invocation.arguments,
          "observationId",
        );
        if (
          [
            "browser_scroll",
            "browser_pointer_click",
            "browser_key_press",
          ].includes(toolName)
        )
          await this.#presentation.assertObservation(
            key,
            observationId,
            invocation.signal,
          );
        else
          invocation = {
            ...invocation,
            arguments: {
              ...invocation.arguments,
              targetId: await this.#presentation.resolveAction(
                key,
                observationId,
                requiredTargetId(invocation.arguments, "targetId"),
                invocation.signal,
              ),
            },
          };
      }
      this.#presentation.invalidate(key);
    } else if (key !== undefined && toolName === "browser_navigate")
      this.#presentation.invalidate(key);
    else if (key !== undefined && toolName === "browser_close")
      this.#presentation.forget(key);
    else if (toolName === "browser_close_session")
      this.#presentation.forgetPrefix(`${JSON.stringify(sessionId)}:`);
    const result = await this.#invoke(toolName, invocation);
    if (!observe || !BROWSER_OBSERVABLE_ACTIONS.has(toolName)) return result;
    const action = result as BrowserTabSummary;
    try {
      invocation.signal.throwIfAborted();
      const inspected = await this.#backend.inspect(
        action.sessionId,
        action.tabId,
        invocation.signal,
      );
      return this.#presentInspection(
        action.grouping === undefined
          ? inspected
          : { ...inspected, grouping: action.grouping },
        options,
        undefined,
        options.baseObservationId === undefined && options.full !== true
          ? typeof invocation.arguments.targetId === "string"
            ? invocation.arguments.targetId
            : ""
          : undefined,
      );
    } catch (error) {
      // The mutation already completed. Never turn a failed follow-up read into
      // an invitation to retry the action (which could submit the form twice).
      return {
        ...action,
        actionCompleted: true,
        observationError:
          error instanceof Error ? error.message : String(error),
        nextAction:
          "The action completed. Call browser_inspect for a fresh observation; do not repeat the action.",
      };
    }
  }

  #observationKey(sessionId: string, tabId: string): string {
    return `${JSON.stringify(sessionId)}:${JSON.stringify(tabId)}`;
  }

  #presentInspection(
    result: BrowserInspection,
    options: ObservationReadOptions,
    query?: string,
    focusTargetId?: string,
  ): Record<string, unknown> {
    const {
      targets,
      visibleText,
      [OBSERVATION_CAPTURE]: captured,
      ...header
    } = result;
    const capture: ObservationCapture<BrowserInspection["targets"][number]> =
      captured ?? {
        scopeKey: `${result.sessionId}/${result.tabId}/${result.documentVersion}`,
        entries: targets.map((value) => ({ value })),
        text: visibleText,
        coverage: {
          scope: "backend-provided bounded observation",
          sourceComplete: null,
          reasons: ["backend_capture_coverage_unknown"],
        },
      };
    const found =
      query === undefined
        ? undefined
        : searchCapturedTargets(
            capture.entries.map((entry) => entry.value),
            query,
            MAX_OBSERVATION_CAPTURE_ITEMS,
          );
    const focused =
      focusTargetId === undefined
        ? undefined
        : focusCapturedTargets(
            capture.entries.map((entry) => entry.value),
            capture.text,
            focusTargetId,
          );
    const presentedCapture =
      found === undefined
        ? focused === undefined
          ? capture
          : {
              ...capture,
              scopeKey: `${capture.scopeKey}:focused:${focusTargetId}`,
              entries: capture.entries.filter((entry) =>
                focused.targets.some(
                  (target) => target.targetId === entry.value.targetId,
                ),
              ),
              text: focused.text,
              coverage: {
                ...capture.coverage,
                scope: `focused subset of ${capture.coverage.scope}`,
                sourceComplete: false as const,
                reasons: [
                  ...capture.coverage.reasons,
                  "focused_subset_of_capture",
                ],
              },
            }
        : {
            ...capture,
            scopeKey: `${capture.scopeKey}:query:${query}`,
            entries: capture.entries.filter((entry) =>
              found.matches.some(
                (match) => match.targetId === entry.value.targetId,
              ),
            ),
            text: undefined,
            coverage: {
              ...capture.coverage,
              scope: `query within ${capture.coverage.scope}`,
              reasons: [
                ...capture.coverage.reasons,
                "query_filters_captured_targets_only",
              ],
            },
          };
    return this.#presentation.publish(
      this.#observationKey(result.sessionId, result.tabId),
      result.observationId,
      found !== undefined
        ? {
            ...header,
            search: {
              query,
              matchedCapturedTargets: found.totalMatches,
              sourceScope: capture.coverage.scope,
            },
          }
        : focused !== undefined
          ? {
              ...header,
              view: {
                kind: "focused-capture",
                sourceScope: capture.coverage.scope,
                textOffset: focused.textOffset,
              },
              nextAction:
                "Call browser_inspect on this tab with full:true for the broader bounded capture.",
            }
          : header,
      presentedCapture,
      options,
    );
  }

  async #invoke(
    toolName: string,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    const sessionId = requiredTargetId(invocation.arguments, "sessionId");
    switch (toolName) {
      case "browser_list_tabs":
        return await this.#backend.listTabs(sessionId, invocation.signal);
      case "browser_open":
        return await this.#backend.open(
          sessionId,
          safeBrowserUrl(requiredString(invocation.arguments, "url")),
          invocation.signal,
        );
      case "browser_navigate":
        return await this.#backend.navigate(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          safeBrowserUrl(requiredString(invocation.arguments, "url")),
          invocation.signal,
          optionalTargetId(invocation.arguments, "observationId"),
        );
      case "browser_inspect":
        return await this.#backend.inspect(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          invocation.signal,
        );
      case "browser_click":
        return await this.#backend.click(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          requiredTargetId(invocation.arguments, "observationId"),
          requiredTargetId(invocation.arguments, "targetId"),
          invocation.signal,
        );
      case "browser_pointer_click":
        if (this.#backend.pointerClick === undefined)
          throw new Error(
            "This browser backend does not support targeted pointer input",
          );
        return await this.#backend.pointerClick(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          requiredTargetId(invocation.arguments, "observationId"),
          invocation.arguments.x as number,
          invocation.arguments.y as number,
          invocation.signal,
        );
      case "browser_key_press":
        if (this.#backend.keyPress === undefined)
          throw new Error(
            "This browser backend does not support targeted keyboard input",
          );
        return await this.#backend.keyPress(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          requiredTargetId(invocation.arguments, "observationId"),
          browserInputKey(invocation.arguments.key),
          invocation.signal,
        );
      case "browser_type":
        return await this.#backend.type(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          requiredTargetId(invocation.arguments, "observationId"),
          requiredTargetId(invocation.arguments, "targetId"),
          requiredString(invocation.arguments, "text", true),
          optionalBoolean(invocation.arguments, "submit") ?? false,
          invocation.signal,
        );
      case "browser_select":
        if (this.#backend.select === undefined)
          throw new Error(
            "This browser backend does not support native option selection",
          );
        return await this.#backend.select(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          requiredTargetId(invocation.arguments, "observationId"),
          requiredTargetId(invocation.arguments, "targetId"),
          requiredString(invocation.arguments, "option"),
          invocation.signal,
        );
      case "browser_scroll": {
        const { direction, pixels } = browserScrollArguments(
          invocation.arguments.direction,
          invocation.arguments.pixels,
        );
        if (this.#backend.scroll === undefined)
          throw new Error("This browser backend does not support scrolling");
        return await this.#backend.scroll(
          sessionId,
          requiredTargetId(invocation.arguments, "tabId"),
          requiredTargetId(invocation.arguments, "observationId"),
          direction,
          pixels,
          invocation.signal,
        );
      }
      case "browser_close": {
        const tabId = requiredTargetId(invocation.arguments, "tabId");
        await this.#backend.closeTab(
          sessionId,
          tabId,
          invocation.signal,
          optionalTargetId(invocation.arguments, "observationId"),
        );
        return { closed: true, sessionId, tabId };
      }
      case "browser_close_session":
        return {
          closedTabs: await this.#backend.closeSession(
            sessionId,
            invocation.signal,
          ),
          sessionId,
        };
      default:
        throw new Error(`Unsupported browser tool: ${toolName}`);
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return await this.#closePromise;
    this.#presentation.close();
    const sessions = this.#threadObservation.close();
    this.#closePromise = (async () => {
      if (this.#ownsBackend) {
        await this.#backend.close();
        return;
      }
      // The app owns the shared Workspace port. Retiring a runtime generation
      // releases only that generation's opaque sessions, never another's lease.
      const results = await Promise.allSettled(
        sessions.map(async (id) => await this.#backend.closeSession(id)),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          "Browser session lease cleanup failed",
        );
    })();
    await this.#closePromise;
  }
}

interface BrowserTab {
  sessionId: string;
  tabId: string;
  window: BrowserWindow;
  incarnation: BrowserSessionIncarnation;
  documentVersion: number;
  observation?: BrowserObservation;
  inputQuarantine?: string;
  inputInFlight?: boolean;
  nativeDialogOpen?: boolean;
}

interface BrowserSessionIncarnation {
  generation: number;
  partition: string;
  pending: number;
  invalidated: boolean;
}

export interface BrowserTargetFingerprint {
  documentIdentity?: string;
  nodeIdentity?: string;
  selector: string;
  tag: string;
  role: string;
  name: string;
  type: string;
  id: string;
  fieldName: string;
  autocomplete: string;
  href: string;
  actions: BrowserTargetAction[];
  value?: string;
  checked?: boolean;
  selected?: boolean;
  options?: BrowserSelectOption[];
  optionsTruncated?: boolean;
}

/** Internal result produced only in a provider-controlled isolated world. */
export interface BrowserDomInspection {
  inputSnapshot?: unknown;
  visibleText: string;
  targets: BrowserTargetFingerprint[];
  documentIdentity?: string;
  itemTotal?: number;
  textTotal?: number;
}

export function browserDomCapture(
  inspected: BrowserDomInspection,
  projected: BrowserInspection["targets"],
  scopePrefix: string,
): ObservationCapture<BrowserInspection["targets"][number]> {
  const knownTotals =
    inspected.itemTotal !== undefined && inspected.textTotal !== undefined;
  const reasons = ["iframe-and-shadow-root-content-excluded"];
  if (!knownTotals) reasons.push("native-source-totals-unavailable");
  if (inspected.documentIdentity === undefined)
    reasons.push("native-document-identity-unavailable");
  if ((inspected.itemTotal ?? 0) > MAX_OBSERVATION_CAPTURE_ITEMS)
    reasons.push("native-target-limit");
  if ((inspected.textTotal ?? 0) > MAX_OBSERVATION_CAPTURE_TEXT)
    reasons.push("native-text-limit");
  return {
    scopeKey: JSON.stringify([scopePrefix, inspected.documentIdentity ?? null]),
    entries: projected
      .slice(0, MAX_OBSERVATION_CAPTURE_ITEMS)
      .map((value, index) => ({
        value,
        ...(inspected.documentIdentity === undefined ||
        inspected.targets[index]?.nodeIdentity === undefined
          ? {}
          : { identity: inspected.targets[index]!.nodeIdentity! }),
      })),
    text: inspected.visibleText.slice(0, MAX_OBSERVATION_CAPTURE_TEXT),
    coverage: {
      scope:
        "top-document light-DOM viewport controls and normalized body text",
      sourceComplete:
        knownTotals && inspected.documentIdentity !== undefined
          ? inspected.itemTotal! <= MAX_OBSERVATION_CAPTURE_ITEMS &&
            inspected.textTotal! <= MAX_OBSERVATION_CAPTURE_TEXT
          : null,
      reasons,
      ...(inspected.itemTotal === undefined
        ? {}
        : { itemTotal: inspected.itemTotal }),
      ...(inspected.textTotal === undefined
        ? {}
        : { textTotal: inspected.textTotal }),
    },
  };
}

export interface BrowserObservation {
  input?: BrowserInputObservation;
  id: string;
  documentVersion: number;
  documentIdentity?: string;
  targets: Map<string, BrowserTargetFingerprint>;
}

export const MAX_BROWSER_TABS_PER_SESSION = 8;
export const MAX_BROWSER_TABS_GLOBAL = 24;
export const MAX_BROWSER_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const BROWSER_SCREENSHOT_TTL_MS = 5 * 60_000;
export const MAX_BROWSER_SCREENSHOT_ARTIFACTS = 16;
export const MAX_BROWSER_SCREENSHOT_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_BROWSER_SCREENSHOT_SCOPES = 256;
const MAX_BROWSER_SCREENSHOT_WIDTH = 4096;
const MAX_BROWSER_SCREENSHOT_HEIGHT = 4096;
const MAX_BROWSER_SCREENSHOT_PIXELS = 16 * 1024 * 1024;
const MAX_BROWSER_SCREENSHOT_DECODE_BYTES = 64 * 1024 * 1024;
let activeBrowserScreenshotDecodeBytes = 0;

/** Temporary provider-owned PNGs; no screenshot bytes are part of the journal. */
export class BrowserScreenshotArtifactStore {
  readonly #rootDirectory: string;
  readonly #directory: string;
  readonly #ownsRootDirectory: boolean;
  readonly #artifacts = new Map<
    string,
    {
      scope: string;
      observationId: string;
      bytes: number;
      createdAt: number;
      timer: NodeJS.Timeout;
    }
  >();
  #directoryCreated = false;
  #closed = false;
  #totalBytes = 0;
  #operations: Promise<void> = Promise.resolve();
  #generation = 0;
  readonly #scopeGenerations = new Map<string, number>();

  constructor(directory?: string) {
    this.#rootDirectory =
      directory ??
      path.join(
        os.tmpdir(),
        `zenx-browser-artifacts-${String(process.pid)}-${randomUUID()}`,
      );
    this.#directory = path.join(this.#rootDirectory, `store-${randomUUID()}`);
    this.#ownsRootDirectory = directory === undefined;
  }

  async write(
    scope: string,
    observationId: string,
    png: Buffer,
    options: { status?: "captured" | "fallback"; reason?: string } = {},
  ): Promise<BrowserScreenshotArtifact> {
    const generation = this.#generation;
    const scopeGeneration = this.#scopeGeneration(scope);
    return await this.#enqueue(async () => {
      if (this.#closed || generation !== this.#generation) {
        throw new Error("Browser screenshot artifact store is closed");
      }
      if (scopeGeneration !== this.#scopeGeneration(scope)) {
        throw new Error(
          "Browser screenshot observation scope is no longer current",
        );
      }
      if (png.byteLength > MAX_BROWSER_SCREENSHOT_BYTES) {
        throw new Error(
          `Browser screenshot exceeded the ${String(MAX_BROWSER_SCREENSHOT_BYTES)} byte bound`,
        );
      }
      const dimensions = pngDimensions(png);
      if (!this.#directoryCreated) {
        await this.#ensureOwnedDirectory();
        this.#directoryCreated = true;
      }
      await this.#assertOwnedDirectory();
      if (
        png.byteLength > MAX_BROWSER_SCREENSHOT_TOTAL_BYTES ||
        this.#artifacts.size >= MAX_BROWSER_SCREENSHOT_ARTIFACTS ||
        this.#totalBytes + png.byteLength > MAX_BROWSER_SCREENSHOT_TOTAL_BYTES
      ) {
        await this.#evictFor(png.byteLength);
      }
      const artifactPath = path.join(this.#directory, `${randomUUID()}.png`);
      if (
        this.#closed ||
        generation !== this.#generation ||
        scopeGeneration !== this.#scopeGeneration(scope)
      ) {
        throw new Error(
          "Browser screenshot artifact store was closed during capture",
        );
      }
      const openFlags =
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
      const handle = await open(artifactPath, openFlags, 0o600);
      try {
        await this.#assertOwnedDirectory();
        await handle.writeFile(png);
        const written = await handle.stat();
        if (!written.isFile() || written.size !== png.byteLength) {
          throw new Error("Browser screenshot artifact write was not complete");
        }
      } finally {
        await handle.close();
      }
      await this.#assertOwnedDirectory();
      if (
        this.#closed ||
        generation !== this.#generation ||
        scopeGeneration !== this.#scopeGeneration(scope)
      ) {
        await rm(artifactPath, { force: true });
        throw new Error("Browser screenshot artifact store is closed");
      }
      const expiresAt = new Date(Date.now() + BROWSER_SCREENSHOT_TTL_MS);
      const timer = setTimeout(() => {
        void this.removeArtifact(artifactPath, observationId);
      }, BROWSER_SCREENSHOT_TTL_MS);
      timer.unref();
      this.#artifacts.set(artifactPath, {
        scope,
        observationId,
        bytes: png.byteLength,
        createdAt: Date.now(),
        timer,
      });
      this.#totalBytes += png.byteLength;
      const superseded = [...this.#artifacts.entries()]
        .filter(
          ([candidatePath, artifact]) =>
            candidatePath !== artifactPath &&
            (artifact.scope === scope ||
              artifact.scope.startsWith(`${scope}/`)),
        )
        .map(([candidatePath]) => candidatePath);
      await Promise.all(
        superseded.map((candidatePath) => this.#removeNow(candidatePath)),
      );
      return {
        artifactPath,
        observationId,
        status: options.status ?? "captured",
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        width: dimensions.width,
        height: dimensions.height,
        bytes: png.byteLength,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async clearScope(scope: string): Promise<void> {
    this.#incrementScopeGeneration(scope);
    await this.#enqueue(async () => {
      const paths = [...this.#artifacts.entries()]
        .filter(
          ([, artifact]) =>
            artifact.scope === scope || artifact.scope.startsWith(`${scope}/`),
        )
        .map(([artifactPath]) => artifactPath);
      await Promise.all(
        paths.map((artifactPath) => this.#removeNow(artifactPath)),
      );
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#generation += 1;
    await this.#enqueue(async () => {
      for (const artifact of this.#artifacts.values())
        clearTimeout(artifact.timer);
      const paths = [...this.#artifacts.keys()];
      this.#artifacts.clear();
      this.#totalBytes = 0;
      await Promise.all(
        paths.map((artifactPath) => rm(artifactPath, { force: true })),
      );
      if (this.#directoryCreated) {
        await rm(this.#directory, { recursive: true, force: true });
        this.#directoryCreated = false;
      }
      if (this.#ownsRootDirectory) {
        await rm(this.#rootDirectory, { recursive: true, force: true });
      }
    });
  }

  async removeArtifact(
    artifactPath: string,
    observationId: string,
  ): Promise<void> {
    await this.#enqueue(async () => {
      const artifact = this.#artifacts.get(artifactPath);
      if (artifact === undefined || artifact.observationId !== observationId)
        return;
      await this.#removeNow(artifactPath);
    });
  }

  async #removeNow(artifactPath: string): Promise<void> {
    const artifact = this.#artifacts.get(artifactPath);
    if (artifact === undefined) return;
    clearTimeout(artifact.timer);
    this.#artifacts.delete(artifactPath);
    this.#totalBytes -= artifact.bytes;
    await rm(artifactPath, { force: true });
  }

  async #ensureOwnedDirectory(): Promise<void> {
    let root: Awaited<ReturnType<typeof lstat>>;
    try {
      root = await lstat(this.#rootDirectory);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      await mkdir(this.#rootDirectory, { mode: 0o700 });
      root = await lstat(this.#rootDirectory);
    }
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error(
        "Browser screenshot artifact root must be a real directory",
      );
    }
    await chmod(this.#rootDirectory, 0o700);
    await mkdir(this.#directory, { recursive: false, mode: 0o700 });
    const child = await lstat(this.#directory);
    if (!child.isDirectory() || child.isSymbolicLink()) {
      throw new Error(
        "Browser screenshot artifact directory must be a real directory",
      );
    }
    await chmod(this.#directory, 0o700);
    await this.#assertOwnedDirectory();
  }

  async #assertOwnedDirectory(): Promise<void> {
    if (!this.#directoryCreated && !this.#directory) return;
    const root = await lstat(this.#rootDirectory);
    const child = await lstat(this.#directory);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      !child.isDirectory() ||
      child.isSymbolicLink()
    ) {
      throw new Error(
        "Browser screenshot artifact directory ownership changed",
      );
    }
    const [rootRealPath, childRealPath] = await Promise.all([
      realpath(this.#rootDirectory),
      realpath(this.#directory),
    ]);
    if (!isWithin(rootRealPath, childRealPath)) {
      throw new Error(
        "Browser screenshot artifact directory escaped its owner",
      );
    }
  }

  #scopeGeneration(scope: string): string {
    return [...this.#scopeGenerations.entries()]
      .filter(
        ([candidate]) =>
          scope === candidate || scope.startsWith(`${candidate}/`),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([candidate, generation]) => `${candidate}:${String(generation)}`)
      .join("|");
  }

  #incrementScopeGeneration(scope: string): void {
    if (
      !this.#scopeGenerations.has(scope) &&
      this.#scopeGenerations.size >= MAX_BROWSER_SCREENSHOT_SCOPES
    ) {
      throw new Error("Browser screenshot scope lifecycle bound exceeded");
    }
    this.#scopeGenerations.set(
      scope,
      (this.#scopeGenerations.get(scope) ?? 0) + 1,
    );
  }

  async #evictFor(bytes: number): Promise<void> {
    if (bytes > MAX_BROWSER_SCREENSHOT_TOTAL_BYTES) {
      throw new Error("Browser screenshot aggregate byte bound exceeded");
    }
    const candidates = [...this.#artifacts.entries()].sort(
      (left, right) => left[1].createdAt - right[1].createdAt,
    );
    while (
      this.#artifacts.size >= MAX_BROWSER_SCREENSHOT_ARTIFACTS ||
      this.#totalBytes + bytes > MAX_BROWSER_SCREENSHOT_TOTAL_BYTES
    ) {
      const candidate = candidates.shift();
      if (candidate === undefined) {
        throw new Error("Browser screenshot artifact capacity is exhausted");
      }
      await this.#removeNow(candidate[0]);
    }
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

export class ElectronBrowserBackend implements ZenXBrowserBackend {
  readonly #tabs = new Map<string, BrowserTab>();
  readonly #sessions = new Map<string, BrowserSessionIncarnation>();
  readonly #artifacts: BrowserScreenshotArtifactStore;
  #pendingGlobal = 0;
  #nextSessionGeneration = 1;
  #closing = false;

  constructor(options: { artifactDirectory?: string } = {}) {
    this.#artifacts = new BrowserScreenshotArtifactStore(
      options.artifactDirectory,
    );
  }

  observeTab(
    sessionId: string,
    tabId: string,
    listener: BrowserLiveObservationListener,
  ): () => void {
    const tab = this.#requireTab(sessionId, tabId);
    return observeElectronPage(
      {
        capture: async () => await tab.window.webContents.capturePage(),
        events: tab.window.webContents,
        metadata: () => summarizeTab(tab),
        current: () =>
          this.#closing ||
          this.#tabs.get(tabId) !== tab ||
          tab.window.isDestroyed()
            ? undefined
            : tab.documentVersion,
      },
      listener,
    );
  }

  async readCurrentUrl(sessionId: string, tabId: string): Promise<string> {
    const tab = this.#requireTab(sessionId, tabId);
    const documentVersion = tab.documentVersion;
    const assertCurrent = () => {
      this.#requireTab(sessionId, tabId);
      if (
        this.#closing ||
        this.#tabs.get(tabId) !== tab ||
        tab.incarnation.invalidated ||
        this.#sessions.get(sessionId) !== tab.incarnation ||
        tab.window.webContents.isDestroyed()
      )
        throw new Error("Browser session or target was closed during URL read");
      if (tab.documentVersion !== documentVersion)
        throw new Error("Browser document changed during URL read");
      if (tab.window.webContents.isLoading())
        throw new Error("Browser page is still loading");
    };
    assertCurrent();
    const url = tab.window.webContents.getURL();
    assertCurrent();
    return url;
  }

  async listTabs(sessionId: string): Promise<BrowserTabSummary[]> {
    assertTargetId(sessionId, "sessionId");
    return [...this.#tabs.values()]
      .filter((tab) => tab.sessionId === sessionId && !tab.window.isDestroyed())
      .map((tab) => summarizeTab(tab));
  }

  async open(sessionId: string, url: string): Promise<BrowserTabSummary> {
    assertTargetId(sessionId, "sessionId");
    const incarnation = this.#reserveOpen(sessionId);
    const tabId = randomUUID();
    try {
      const { BrowserWindow } = await import("electron");
      const window = new BrowserWindow({
        width: 1100,
        height: 760,
        minWidth: 640,
        minHeight: 480,
        show: false,
        focusable: false,
        skipTaskbar: true,
        title: "ZenX Browser",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: incarnation.partition,
          backgroundThrottling: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const tab: BrowserTab = {
        sessionId,
        tabId,
        window,
        incarnation,
        documentVersion: 0,
      };
      this.#tabs.set(tabId, tab);
      window.webContents.debugger.on("message", (_event, method) => {
        if (method === "Page.javascriptDialogOpening")
          tab.nativeDialogOpen = true;
        if (method === "Page.javascriptDialogClosed")
          tab.nativeDialogOpen = false;
      });
      window.webContents.on(
        "did-start-navigation",
        (_event, _url, isInPlace, isMainFrame) => {
          if (isMainFrame && !isInPlace) this.#invalidateDocument(tab);
        },
      );
      window.once("closed", () => {
        tab.observation = undefined;
        this.#tabs.delete(tabId);
        this.#releaseIncarnation(sessionId, incarnation);
      });
      await window.loadURL(url);
      window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand("Runtime.enable");
      await window.webContents.debugger.sendCommand("Page.enable");
      if (
        this.#closing ||
        incarnation.invalidated ||
        this.#sessions.get(sessionId) !== incarnation
      ) {
        window.destroy();
        throw new Error("Browser session was closed while its tab was opening");
      }
      return summarizeTab(tab);
    } catch (error) {
      const tab = this.#tabs.get(tabId);
      if (tab !== undefined && !tab.window.isDestroyed()) tab.window.destroy();
      throw error;
    } finally {
      this.#releaseOpen(sessionId, incarnation);
    }
  }

  async navigate(
    sessionId: string,
    tabId: string,
    url: string,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    this.#assertInputAvailable(tab);
    this.#invalidateDocument(tab);
    await tab.window.loadURL(url);
    return summarizeTab(tab);
  }

  async inspect(sessionId: string, tabId: string): Promise<BrowserInspection> {
    const tab = this.#requireTab(sessionId, tabId);
    const documentVersion = tab.documentVersion;
    const inspected = await evaluateInTab<BrowserDomInspection>(
      tab,
      browserInspectScript,
    );
    const observationId = randomUUID();
    const screenshot = await this.#captureScreenshot(tab, observationId);
    let input: BrowserInputObservation | undefined;
    if (
      inspected.inputSnapshot !== undefined &&
      screenshot.status === "captured" &&
      tab.inputQuarantine === undefined &&
      !tab.inputInFlight
    ) {
      try {
        const snapshot = requireBrowserInputSnapshot(inspected.inputSnapshot);
        const after = requireBrowserInputSnapshot(
          await evaluateInTab(tab, browserInputSnapshotScript),
        );
        assertBrowserInputSnapshot(snapshot, after);
        input = { snapshot, screenshotId: observationId };
      } catch {
        // DOM observations remain usable when the optional input snapshot cannot
        // establish an unzoomed, unchanged viewport.
      }
    }
    if (tab.documentVersion !== documentVersion) {
      await this.#artifacts.removeArtifact(
        screenshot.artifactPath,
        screenshot.observationId,
      );
      throw new Error(
        "Browser document changed during inspection; inspect again",
      );
    }
    const targets = new Map<string, BrowserTargetFingerprint>();
    const projectedTargets = inspected.targets
      .slice(0, MAX_OBSERVATION_CAPTURE_ITEMS)
      .map((target) => {
        const targetId = randomUUID();
        targets.set(targetId, target);
        return {
          targetId,
          role: target.role,
          name: target.name,
          actions: [...target.actions],
          ...(target.value === undefined ? {} : { value: target.value }),
          ...(target.checked === undefined ? {} : { checked: target.checked }),
          ...(target.selected === undefined
            ? {}
            : { selected: target.selected }),
          ...(target.options === undefined
            ? {}
            : { options: target.options.map((option) => ({ ...option })) }),
          ...(target.optionsTruncated === undefined
            ? {}
            : { optionsTruncated: target.optionsTruncated }),
        };
      });
    tab.observation = {
      ...(input === undefined ? {} : { input }),
      id: observationId,
      documentVersion: tab.documentVersion,
      ...(inspected.documentIdentity === undefined
        ? {}
        : { documentIdentity: inspected.documentIdentity }),
      targets,
    };
    return {
      ...summarizeTab(tab),
      observationId,
      documentVersion: tab.documentVersion,
      visibleText: inspected.visibleText.slice(0, 8_000),
      screenshot,
      ...(input === undefined
        ? {}
        : {
            inputViewport: input.snapshot.viewport,
            focusedInputAvailable: input.snapshot.focusId !== null,
            inputPolicy: browserTargetedInputPolicy,
          }),
      targets: projectedTargets.slice(0, 80),
      [OBSERVATION_CAPTURE]: {
        ...browserDomCapture(
          inspected,
          projectedTargets,
          `${tab.incarnation.partition}/${tab.tabId}`,
        ),
        assertCurrent: () => {
          if (
            this.#requireTab(sessionId, tabId) !== tab ||
            tab.observation?.id !== observationId ||
            tab.documentVersion !== documentVersion
          )
            throw new Error(
              "Browser observation capture is stale; inspect again",
            );
        },
      },
    };
  }

  pointerClick(
    sessionId: string,
    tabId: string,
    observationId: string,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    return this.#targetedInput(
      sessionId,
      tabId,
      observationId,
      { kind: "click", x, y },
      signal,
    );
  }

  keyPress(
    sessionId: string,
    tabId: string,
    observationId: string,
    key: BrowserInputKey,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    return this.#targetedInput(
      sessionId,
      tabId,
      observationId,
      { kind: "key", key },
      signal,
    );
  }

  async #targetedInput(
    sessionId: string,
    tabId: string,
    observationId: string,
    action:
      | { kind: "click"; x: number; y: number }
      | { kind: "key"; key: BrowserInputKey },
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    this.#assertInputAvailable(tab);
    assertBrowserObservation(
      tab.observation,
      tab.documentVersion,
      observationId,
    );
    const observation = tab.observation;
    const input = observation.input;
    if (input === undefined || input.screenshotId !== observationId)
      throw new Error(
        "A real, coherent screenshot is required for browser targeted input; inspect again",
      );
    const version = tab.documentVersion;
    let dispatched = false;
    tab.inputInFlight = true;
    try {
      await dispatchBrowserTargetedInput(
        {
          assertCurrent: () => {
            if (tab.nativeDialogOpen)
              throw new Error(
                "Browser native dialog requires human control; no automatic dialog acceptance or foreground fallback",
              );
            if (!dispatched && tab.observation !== observation)
              throw new Error(
                "Browser observation changed before targeted input",
              );
            if (
              this.#requireTab(sessionId, tabId) !== tab ||
              tab.documentVersion !== version
            )
              throw new Error(
                "Browser document or session changed during targeted input",
              );
          },
          snapshot: async () =>
            requireBrowserInputSnapshot(
              await evaluateInTab(tab, browserInputProbeScript(action)),
            ),
          beforeDispatch: () => {
            if (tab.observation !== observation)
              throw new Error(
                "Browser observation changed before targeted input",
              );
            dispatched = true;
            tab.observation = undefined;
          },
          dispatch: async (method, params, onDispatched) => {
            const pending = tab.window.webContents.debugger.sendCommand(
              method,
              params,
            );
            onDispatched();
            return await pending;
          },
          quarantine: (error) => {
            tab.inputQuarantine = error.message;
            tab.observation = undefined;
          },
        },
        input.snapshot,
        action,
        signal,
      );
      return summarizeTab(tab);
    } finally {
      tab.inputInFlight = false;
    }
  }

  #assertInputAvailable(tab: BrowserTab): void {
    if (tab.inputQuarantine !== undefined) throw new Error(tab.inputQuarantine);
    if (tab.inputInFlight)
      throw new Error(
        "Browser targeted input is already in flight; wait and inspect again",
      );
  }

  async click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    this.#assertInputAvailable(tab);
    const target = this.#requireObservedTarget(
      tab,
      observationId,
      targetId,
      "click",
    );
    tab.observation = undefined;
    const result = await evaluateInTab<{ ok: boolean; reason?: string }>(
      tab,
      browserActionScript(target, "click"),
      () => this.#assertInputAvailable(tab),
    );
    if (!result.ok) {
      throw new Error(
        `Browser click target is stale or unsafe: ${result.reason}`,
      );
    }
    await settlePage(tab.window);
    return summarizeTab(tab);
  }

  async type(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    text: string,
    submit: boolean,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    this.#assertInputAvailable(tab);
    const target = this.#requireObservedTarget(
      tab,
      observationId,
      targetId,
      "type",
    );
    tab.observation = undefined;
    const result = await evaluateInTab<{ ok: boolean; reason?: string }>(
      tab,
      browserActionScript(target, "type", text, submit),
      () => this.#assertInputAvailable(tab),
    );
    if (!result.ok) {
      throw new Error(
        `Browser type target is stale or unsafe: ${result.reason}`,
      );
    }
    await settlePage(tab.window);
    return summarizeTab(tab);
  }

  async select(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    option: string,
  ): Promise<BrowserTabSummary> {
    const tab = this.#requireTab(sessionId, tabId);
    this.#assertInputAvailable(tab);
    const target = this.#requireObservedTarget(
      tab,
      observationId,
      targetId,
      "select",
    );
    tab.observation = undefined;
    const result = await evaluateInTab<{ ok: boolean; reason?: string }>(
      tab,
      browserActionScript(target, "select", option),
      () => this.#assertInputAvailable(tab),
    );
    if (!result.ok) {
      throw new Error(
        `Browser select target is stale or unsafe: ${result.reason}`,
      );
    }
    await settlePage(tab.window);
    return summarizeTab(tab);
  }

  async scroll(
    sessionId: string,
    tabId: string,
    observationId: string,
    direction: BrowserScrollDirection,
    pixels: number,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    signal?.throwIfAborted();
    const tab = this.#requireTab(sessionId, tabId);
    this.#assertInputAvailable(tab);
    assertBrowserObservation(
      tab.observation,
      tab.documentVersion,
      observationId,
    );
    if (tab.observation.documentIdentity === undefined)
      throw new Error(
        "Browser document identity is unavailable; inspect again",
      );
    const expression = browserScrollScript(
      direction,
      pixels,
      tab.observation.documentIdentity,
    );
    tab.observation = undefined;
    // Runtime.evaluate cannot reliably stop a dispatched mutation. Keep awaiting
    // its real settlement; cancellation must not imply the page stopped moving.
    try {
      await evaluateInTab(tab, expression, () =>
        this.#assertInputAvailable(tab),
      );
    } catch (error) {
      if (signal?.aborted) {
        throw new Error(
          "Browser scroll outcome unknown after cancellation; inspect again before interacting",
          { cause: error },
        );
      }
      throw error;
    }
    if (signal?.aborted) {
      throw new Error(
        "Browser scroll outcome unknown after cancellation; inspect again before interacting",
      );
    }
    return summarizeTab(tab);
  }

  async closeTab(sessionId: string, tabId: string): Promise<void> {
    const tab = this.#requireTab(sessionId, tabId);
    tab.observation = undefined;
    this.#tabs.delete(tabId);
    if (!tab.window.isDestroyed()) tab.window.destroy();
    this.#releaseIncarnation(sessionId, tab.incarnation);
    await this.#artifacts.clearScope(`${sessionId}/${tabId}`);
  }

  async closeSession(sessionId: string): Promise<number> {
    assertTargetId(sessionId, "sessionId");
    const incarnation = this.#sessions.get(sessionId);
    if (incarnation !== undefined) incarnation.invalidated = true;
    this.#sessions.delete(sessionId);
    const tabs = [...this.#tabs.values()].filter(
      (tab) => tab.sessionId === sessionId,
    );
    const electronSessions = new Set(
      tabs.map((tab) => tab.window.webContents.session),
    );
    await Promise.all(tabs.map((tab) => this.closeTab(sessionId, tab.tabId)));
    await Promise.all([...electronSessions].map(clearElectronSession));
    await this.#artifacts.clearScope(sessionId);
    return tabs.length;
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const incarnation of this.#sessions.values()) {
      incarnation.invalidated = true;
    }
    this.#sessions.clear();
    const electronSessions = new Set(
      [...this.#tabs.values()].map((tab) => tab.window.webContents.session),
    );
    for (const tab of this.#tabs.values()) {
      tab.observation = undefined;
      if (!tab.window.isDestroyed()) tab.window.destroy();
    }
    this.#tabs.clear();
    await Promise.all([...electronSessions].map(clearElectronSession));
    await this.#artifacts.close();
  }

  async #captureScreenshot(
    tab: BrowserTab,
    observationId: string,
  ): Promise<BrowserScreenshotArtifact> {
    const image = await tab.window.webContents.capturePage();
    let png = image.toPNG();
    if (png.byteLength > MAX_BROWSER_SCREENSHOT_BYTES) {
      const size = image.getSize();
      const scale = Math.sqrt(MAX_BROWSER_SCREENSHOT_BYTES / png.byteLength);
      if (scale < 1 && size.width > 1 && size.height > 1) {
        png = image
          .resize({
            width: Math.max(1, Math.floor(size.width * scale)),
            height: Math.max(1, Math.floor(size.height * scale)),
          })
          .toPNG();
      }
    }
    return await this.#artifacts.write(
      `${tab.sessionId}/${tab.tabId}`,
      observationId,
      png,
    );
  }

  #requireTab(sessionId: string, tabId: string): BrowserTab {
    assertTargetId(sessionId, "sessionId");
    assertTargetId(tabId, "tabId");
    const tab = this.#tabs.get(tabId);
    if (
      tab === undefined ||
      tab.sessionId !== sessionId ||
      tab.window.isDestroyed()
    ) {
      throw new Error(`Unknown browser target ${sessionId}/${tabId}`);
    }
    return tab;
  }

  #requireObservedTarget(
    tab: BrowserTab,
    observationId: string,
    targetId: string,
    action: BrowserTargetAction,
  ): BrowserTargetFingerprint {
    return resolveBrowserObservedTarget(
      tab.observation,
      tab.documentVersion,
      observationId,
      targetId,
      action,
    );
  }

  #invalidateDocument(tab: BrowserTab): void {
    tab.documentVersion += 1;
    tab.observation = undefined;
  }

  #reserveOpen(sessionId: string): BrowserSessionIncarnation {
    if (this.#closing) throw new Error("ZenX browser backend is closed");
    const existing = this.#sessions.get(sessionId);
    const currentGlobal = this.#tabs.size + this.#pendingGlobal;
    const currentSession =
      [...this.#tabs.values()].filter((tab) => tab.sessionId === sessionId)
        .length + (existing?.pending ?? 0);
    assertBrowserTabCapacity(currentGlobal, currentSession);
    const incarnation = existing ?? this.#createIncarnation(sessionId);
    this.#pendingGlobal += 1;
    incarnation.pending += 1;
    return incarnation;
  }

  #releaseOpen(
    sessionId: string,
    incarnation: BrowserSessionIncarnation,
  ): void {
    this.#pendingGlobal -= 1;
    incarnation.pending -= 1;
    this.#releaseIncarnation(sessionId, incarnation);
  }

  #createIncarnation(sessionId: string): BrowserSessionIncarnation {
    if (!Number.isSafeInteger(this.#nextSessionGeneration)) {
      throw new Error("ZenX browser session generation space is exhausted");
    }
    const generation = this.#nextSessionGeneration;
    this.#nextSessionGeneration += 1;
    const incarnation = {
      generation,
      partition: browserPartitionName(sessionId, generation),
      pending: 0,
      invalidated: false,
    };
    this.#sessions.set(sessionId, incarnation);
    return incarnation;
  }

  #releaseIncarnation(
    sessionId: string,
    incarnation: BrowserSessionIncarnation,
  ): void {
    if (
      this.#sessions.get(sessionId) !== incarnation ||
      incarnation.pending > 0 ||
      [...this.#tabs.values()].some((tab) => tab.incarnation === incarnation)
    ) {
      return;
    }
    incarnation.invalidated = true;
    this.#sessions.delete(sessionId);
  }
}

export function resolveBrowserObservedTarget(
  observation: BrowserObservation | undefined,
  documentVersion: number,
  observationId: string,
  targetId: string,
  action: BrowserTargetAction,
): BrowserTargetFingerprint {
  assertBrowserObservation(observation, documentVersion, observationId);
  const target = observation.targets.get(targetId);
  if (target === undefined) {
    throw new Error("Browser target ID is forged, stale, or unknown");
  }
  if (!target.actions.includes(action)) {
    throw new Error(`Browser target does not support ${action}`);
  }
  return target;
}

export function assertBrowserObservation(
  observation: BrowserObservation | undefined,
  documentVersion: number,
  observationId: string,
): asserts observation is BrowserObservation {
  if (
    observation === undefined ||
    observation.id !== observationId ||
    observation.documentVersion !== documentVersion
  ) {
    throw new Error(
      "Browser observation is stale or unknown; inspect the current tab again",
    );
  }
}

export type BrowserScrollDirection = "up" | "down" | "left" | "right";

export function browserScrollArguments(
  direction: unknown,
  pixels: unknown,
): { direction: BrowserScrollDirection; pixels: number } {
  if (
    direction !== "up" &&
    direction !== "down" &&
    direction !== "left" &&
    direction !== "right"
  )
    throw new Error(
      "Browser scroll direction must be up, down, left, or right",
    );
  if (
    typeof pixels !== "number" ||
    !Number.isInteger(pixels) ||
    pixels < 1 ||
    pixels > 2000
  )
    throw new Error("Browser scroll pixels must be an integer from 1 to 2000");
  return { direction, pixels };
}

export function browserScrollScript(
  direction: BrowserScrollDirection,
  pixels: number,
  documentIdentity?: string,
): string {
  browserScrollArguments(direction, pixels);
  const left =
    direction === "left" ? -pixels : direction === "right" ? pixels : 0;
  const top = direction === "up" ? -pixels : direction === "down" ? pixels : 0;
  const guard =
    documentIdentity === undefined
      ? ""
      : `const registry = globalThis[Symbol.for(${JSON.stringify(browserNodeRegistryKey)})]; if (!registry || registry.document !== document || registry.incarnation + "|" + location.href !== ${JSON.stringify(documentIdentity)}) throw new Error("Browser document changed; inspect again");`;
  return `(() => { ${guard} window.scrollBy({ left: ${left}, top: ${top}, behavior: "instant" }); try { document.querySelector('[data-zenx-agent-pointer]')?.__zenxCleanup?.(); } catch { /* Visual cleanup cannot change a completed scroll. */ } return { ok: true }; })()`;
}

// A page-local visual only: no real pointer, focus, or input events.
// The closed shadow root keeps the drawing and label out of inspected content.
export const browserAgentPointerScript = `(point) => {
  try {
    if (location.href !== point.url || scrollX !== point.scrollX || scrollY !== point.scrollY || innerWidth !== point.width || innerHeight !== point.height) return;
    const { x, y } = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const old = document.querySelector('[data-zenx-agent-pointer]');
    const prior = old ? JSON.parse(old.getAttribute('data-points') || '[]') : [];
    if (old) old.__zenxCleanup?.();
    const points = [...prior, [x, y]].slice(-4);
    const host = document.createElement('div');
    host.setAttribute('data-zenx-agent-pointer', '');
    host.setAttribute('data-points', JSON.stringify(points));
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none!important;overflow:hidden;contain:layout style paint';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{pointer-events:none!important} .point{position:absolute;box-sizing:border-box;border-radius:50%;background:#4e88ff;box-shadow:0 0 0 2px #fff,0 2px 8px #16274dcc;transform:translate(-50%,-50%);animation:zenx-in .15s ease-out both}.cursor{position:absolute;width:18px;height:18px;transform:translate(-2px,-2px);filter:drop-shadow(0 1px 2px #16274d);transition:left .2s ease-out,top .2s ease-out;animation:zenx-in .15s ease-out both}.cursor path{fill:#4e88ff;stroke:#fff;stroke-width:1.7;stroke-linejoin:round}.label{position:absolute;padding:2px 5px;border-radius:4px;background:#315fc7;color:#fff;font:600 11px/15px system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 4px #16274d66}@keyframes zenx-in{from{opacity:0;scale:.6}to{opacity:1;scale:1}}@media(prefers-reduced-motion:reduce){.point,.cursor{animation:none}.cursor{transition:none}}';
    shadow.appendChild(style);
    points.forEach(([px, py], index) => {
      const dot = document.createElement('div');
      dot.className = 'point';
      const size = index === points.length - 1 ? 11 : 4 + index;
      dot.style.cssText = 'left:' + px + 'px;top:' + py + 'px;width:' + size + 'px;height:' + size + 'px;opacity:' + ((index + 1) / points.length) * .7;
      shadow.appendChild(dot);
    });
    const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    cursor.setAttribute('class', 'cursor');
    cursor.setAttribute('viewBox', '0 0 18 18');
    const previous = prior.at(-1);
    cursor.style.left = (previous ? previous[0] : x) + 'px';
    cursor.style.top = (previous ? previous[1] : y) + 'px';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2 1.5v13.3l3.8-3.5 2.7 5.2 2.7-1.4-2.7-5.1 5.1-.3z');
    cursor.appendChild(path);
    shadow.appendChild(cursor);
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = 'Agent';
    label.style.left = Math.min(x + 16, innerWidth - 44) + 'px';
    label.style.top = Math.min(y + 17, innerHeight - 20) + 'px';
    shadow.appendChild(label);
    document.documentElement.appendChild(host);
    const frame = window.requestAnimationFrame?.(() => { cursor.style.left = x + 'px'; cursor.style.top = y + 'px'; });
    if (frame === undefined) { cursor.style.left = x + 'px'; cursor.style.top = y + 'px'; }
    const route = location.href;
    const clear = () => {
      host.remove();
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
      window.clearTimeout(timer);
      window.clearInterval(routeTimer);
      if (frame !== undefined) window.cancelAnimationFrame?.(frame);
    };
    const timer = window.setTimeout(clear, 3000);
    const routeTimer = window.setInterval(() => { if (location.href !== route) clear(); }, 100);
    Object.defineProperty(host, '__zenxCleanup', { value: clear });
    window.addEventListener('scroll', clear, { capture: true });
    window.addEventListener('resize', clear);
  } catch { /* Visual feedback must never change the action result. */ }
}`;

// Both observation and action use the same name so relabelled controls fail closed.
const browserElementNameScript = `(element) => {
  const text = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
  const referenced = (element.getAttribute("aria-labelledby") ?? "").split(/\\s+/).filter(Boolean).map(id => document.getElementById(id)).filter(Boolean).map(node => text(node.textContent)).join(" ");
  const labels = element.labels ? [...element.labels].map(label => { const copy = label.cloneNode(true); copy.querySelectorAll("input,textarea,select,button").forEach(control => control.remove()); return text(copy.textContent); }).join(" ") : "";
  return (referenced || text(element.getAttribute("aria-label")) || labels || text(element.getAttribute("placeholder")) || text(element.textContent)).slice(0, 160);
}`;

// The registry is safe only in the provider's named isolated world. Never evaluate
// these scripts in the page's main world: page-owned keys are not node identity.
const browserNodeRegistryKey = "zenx.browser.observation.nodes.v1";
export const browserInspectScript = `(() => {
  const registryKey = Symbol.for(${JSON.stringify(browserNodeRegistryKey)});
  let registry = globalThis[registryKey];
  if (!registry || registry.document !== document) {
    const random = crypto.getRandomValues(new Uint32Array(4));
    registry = { document, incarnation: [...random].map(value => value.toString(16).padStart(8, "0")).join(""), next: 1, ids: new WeakMap(), current: new Map() };
    globalThis[registryKey] = registry;
  }
  const documentIdentity = registry.incarnation + "|" + location.href;
  registry.current.clear();
  const nodeIdentity = (element) => {
    let identity = registry.ids.get(element);
    if (identity === undefined) {
      if (!Number.isSafeInteger(registry.next)) throw new Error("Browser node identity space exhausted");
      identity = registry.incarnation + ":" + registry.next++;
      registry.ids.set(element, identity);
    }
    registry.current.set(identity, element);
    return identity;
  };
  // Reuse only the live style object during this inspection, never its values.
  const styles = new WeakMap();
  const styleFor = (element) => {
    let style = styles.get(element);
    if (style === undefined) {
      style = getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const visible = (element) => {
    const style = styleFor(element);
    const rect = element.getBoundingClientRect();
    return !element.hidden && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };
  const name = ${browserElementNameScript};
  const typeable = (element) => {
    if (element.hasAttribute("disabled") || element.hasAttribute("readonly")) return false;
    if (element instanceof HTMLElement && element.matches('[contenteditable]:not([contenteditable="false"])')) return true;
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    return !["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"].includes(element.type.toLowerCase());
  };
  const clickable = (element) => styleFor(element).pointerEvents !== "none" && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true" && element.matches("a[href],button,input:not([type=hidden]),select,[role=button],[tabindex]");
  const selector = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current instanceof Element && current !== document.body && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + String(siblings.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const elements = [...document.querySelectorAll("a[href],button,input,textarea,select,[contenteditable=true],[role=button],[tabindex]")]
    .filter((element) => visible(element) && (clickable(element) || typeable(element)));
  const text = (document.body?.innerText ?? "").replace(/\\s+/g, " ").trim();
  return {
    documentIdentity,
    inputSnapshot: ${browserInputSnapshotScript},
    itemTotal: elements.length,
    textTotal: text.length,
    visibleText: text.slice(0, ${MAX_OBSERVATION_CAPTURE_TEXT}),
    targets: elements.slice(0, ${MAX_OBSERVATION_CAPTURE_ITEMS}).map((element) => {
      const actions = [];
      if (clickable(element)) actions.push("click");
      if (typeable(element)) actions.push("type");
      if (element instanceof HTMLSelectElement && !element.disabled && element.options.length <= 100) actions.push("select");
      const value = element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && element.type.toLowerCase() !== "password") ? element.value : element instanceof HTMLElement && element.matches('[contenteditable]:not([contenteditable="false"])') ? element.textContent ?? "" : undefined;
      const checked = element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type.toLowerCase()) ? element.checked : element.getAttribute("aria-checked") === "true" ? true : element.getAttribute("aria-checked") === "false" ? false : undefined;
      const selected = element.getAttribute("aria-selected") === "true" ? true : element.getAttribute("aria-selected") === "false" ? false : element instanceof HTMLOptionElement ? element.selected : undefined;
      return {
        documentIdentity,
        nodeIdentity: nodeIdentity(element),
        selector: selector(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
        name: name(element),
        type: element instanceof HTMLInputElement ? element.type.toLowerCase() : "",
        id: element.id,
        fieldName: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.name : "",
        autocomplete: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.autocomplete : "",
        href: element instanceof HTMLAnchorElement ? element.getAttribute("href") ?? "" : "",
        actions,
        ...(value === undefined ? {} : { value: value.slice(0, 512) }),
        ...(checked === undefined ? {} : { checked }),
        ...(selected === undefined ? {} : { selected }),
        ...(element instanceof HTMLSelectElement ? { options: [...element.options].slice(0, 100).map(option => ({ value: option.value.slice(0, 512), label: (option.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 512), selected: option.selected, disabled: option.disabled })) } : {}),
        ...(element instanceof HTMLSelectElement ? { optionsTruncated: element.options.length > 100 } : {}),
      };
    }),
  };
})()`;

export function browserActionScript(
  target: BrowserTargetFingerprint,
  action: BrowserTargetAction,
  text = "",
  submit = false,
): string {
  const expectedDocumentIdentity = JSON.stringify(
    target.documentIdentity ?? null,
  );
  const expected = JSON.stringify({
    tag: target.tag,
    role: target.role,
    name: target.name,
    type: target.type,
    id: target.id,
    fieldName: target.fieldName,
    autocomplete: target.autocomplete,
    href: target.href,
  });
  const expectedState = JSON.stringify({
    ...(target.value === undefined ? {} : { value: target.value }),
    ...(target.checked === undefined ? {} : { checked: target.checked }),
    ...(target.selected === undefined ? {} : { selected: target.selected }),
  });
  return `(() => {
    const name = ${browserElementNameScript};
    const expectedDocumentIdentity = ${expectedDocumentIdentity};
    const registry = globalThis[Symbol.for(${JSON.stringify(browserNodeRegistryKey)})];
    if (!registry || registry.document !== document || expectedDocumentIdentity === null || registry.incarnation + "|" + location.href !== expectedDocumentIdentity) return { ok: false, reason: "document-changed" };
    const expected = ${expected};
    const expectedNodeIdentity = ${JSON.stringify(target.nodeIdentity ?? null)};
    const action = ${JSON.stringify(action)};
    const nextValue = ${JSON.stringify(text)};
    const showAgentPointer = ${browserAgentPointerScript};
  const shouldSubmit = ${JSON.stringify(submit)};
  const expectedOptions = ${JSON.stringify(target.options ?? null)};
  const expectedOptionsTruncated = ${JSON.stringify(target.optionsTruncated ?? false)};
    const element = registry.current.get(expectedNodeIdentity);
    if (!element || !element.isConnected || element.ownerDocument !== document || registry.ids.get(element) !== expectedNodeIdentity) return { ok: false, reason: "node-changed" };
    if (!(element instanceof HTMLElement)) return { ok: false, reason: "not-an-html-element" };
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (element.hidden || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return { ok: false, reason: "not-visible" };
    const actual = {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
      name: name(element),
      type: element instanceof HTMLInputElement ? element.type.toLowerCase() : "",
      id: element.id,
      fieldName: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.name : "",
      autocomplete: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.autocomplete : "",
      href: element instanceof HTMLAnchorElement ? element.getAttribute("href") ?? "" : "",
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return { ok: false, reason: "identity-changed" };
    const expectedState = ${expectedState};
    const currentValue = element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && element.type.toLowerCase() !== "password") ? element.value : element instanceof HTMLElement && element.matches('[contenteditable]:not([contenteditable="false"])') ? element.textContent ?? "" : undefined;
    const currentChecked = element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type.toLowerCase()) ? element.checked : element.getAttribute("aria-checked") === "true" ? true : element.getAttribute("aria-checked") === "false" ? false : undefined;
    const currentSelected = element.getAttribute("aria-selected") === "true" ? true : element.getAttribute("aria-selected") === "false" ? false : element instanceof HTMLOptionElement ? element.selected : undefined;
    const actualState = {
      ...(currentValue === undefined ? {} : { value: currentValue.slice(0, 512) }),
      ...(currentChecked === undefined ? {} : { checked: currentChecked }),
      ...(currentSelected === undefined ? {} : { selected: currentSelected }),
    };
    if (JSON.stringify(actualState) !== JSON.stringify(expectedState)) return { ok: false, reason: "state-changed" };
    const point = {
      x: (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2,
      y: (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2,
      url: location.href, scrollX, scrollY, width: innerWidth, height: innerHeight,
    };
    if (action === "click") {
      if (style.pointerEvents === "none" || element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || !element.matches("a[href],button,input:not([type=hidden]),select,[role=button],[tabindex]")) return { ok: false, reason: "not-clickable" };
      element.click();
      showAgentPointer(point);
      return { ok: true };
    }
    if (action === "select") {
      if (!(element instanceof HTMLSelectElement) || element.disabled) return { ok: false, reason: "not-selectable" };
      if (expectedOptions === null || expectedOptionsTruncated || element.options.length > 100) return { ok: false, reason: "options-unobserved" };
      const currentOptions = [...element.options].map(option => ({ value: option.value.slice(0, 512), label: (option.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 512), selected: option.selected, disabled: option.disabled }));
      if (currentOptions.length !== expectedOptions.length || currentOptions.some((option, index) => option.value !== expectedOptions[index].value || option.label !== expectedOptions[index].label || option.selected !== expectedOptions[index].selected || option.disabled !== expectedOptions[index].disabled)) return { ok: false, reason: "options-changed" };
      const byValue = currentOptions.filter(option => option.value === nextValue && !option.disabled);
      const byLabel = currentOptions.filter(option => option.label === nextValue && !option.disabled);
      const matches = byValue.length > 0 ? byValue : byLabel;
      if (matches.length !== 1) return { ok: false, reason: matches.length === 0 ? "option-missing" : "option-ambiguous" };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (setter === undefined) return { ok: false, reason: "value-setter-unavailable" };
      setter.call(element, matches[0].value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      showAgentPointer(point);
      return { ok: true };
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.matches('[contenteditable]:not([contenteditable="false"])'))) || element.hasAttribute("disabled") || element.hasAttribute("readonly")) return { ok: false, reason: "not-typeable" };
    if (element instanceof HTMLInputElement && ["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"].includes(element.type.toLowerCase())) return { ok: false, reason: "not-typeable" };
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      element.textContent = nextValue;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      if (shouldSubmit) element.closest("form")?.requestSubmit();
      showAgentPointer(point);
      return { ok: true };
    }
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) return { ok: false, reason: "value-setter-unavailable" };
    setter.call(element, nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    if (shouldSubmit) element.form?.requestSubmit();
    showAgentPointer(point);
    return { ok: true };
  })()`;
}

export function assertBrowserTabCapacity(
  currentGlobal: number,
  currentSession: number,
): void {
  if (currentGlobal >= MAX_BROWSER_TABS_GLOBAL) {
    throw new Error(
      `ZenX browser global tab limit (${MAX_BROWSER_TABS_GLOBAL}) reached; close a tab or session before opening another`,
    );
  }
  if (currentSession >= MAX_BROWSER_TABS_PER_SESSION) {
    throw new Error(
      `ZenX browser session tab limit (${MAX_BROWSER_TABS_PER_SESSION}) reached; close a tab before opening another`,
    );
  }
}

export function browserPartitionName(
  sessionId: string,
  generation: number,
): string {
  assertTargetId(sessionId, "sessionId");
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("Browser session generation must be a positive integer");
  }
  return `zenx-capability-${sessionId}-${String(generation)}`;
}

function summarizeTab(tab: BrowserTab): BrowserTabSummary {
  return {
    sessionId: tab.sessionId,
    tabId: tab.tabId,
    title: tab.window.getTitle().slice(0, 256),
    url: redactBrowserUrl(tab.window.webContents.getURL()),
    loading: tab.window.webContents.isLoading(),
  };
}

function safeBrowserUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ZenX browser only opens http(s) URLs");
  }
  return url.toString();
}

export function redactBrowserUrl(raw: string): string {
  if (raw.length === 0) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    return url.toString().slice(0, 2048);
  } catch {
    return "[malformed-url]";
  }
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("Browser screenshot is not a valid PNG");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawHeader = false;
  let sawData = false;
  let ended = false;
  let sawPalette = false;
  let sawImageData = false;
  let paletteEntries = 0;
  let sawTransparency = false;
  let sawPostImageData = false;
  let chunkCount = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    chunkCount += 1;
    if (chunkCount > 1024) {
      throw new Error("Browser screenshot PNG has too many chunks");
    }
    if (offset + 12 > buffer.length) {
      throw new Error("Browser screenshot PNG is truncated");
    }
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (dataEnd < dataStart || crcEnd > buffer.length) {
      throw new Error("Browser screenshot PNG chunk is truncated");
    }
    if (ended) throw new Error("Browser screenshot PNG has data after IEND");
    const data = buffer.subarray(dataStart, dataEnd);
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = crc32(Buffer.concat([type, data]));
    if (actualCrc !== expectedCrc) {
      throw new Error("Browser screenshot PNG chunk CRC is invalid");
    }
    const name = type.toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(name)) {
      throw new Error("Browser screenshot PNG chunk type is invalid");
    }
    if (
      (type[0]! & 0x20) === 0 &&
      !["IHDR", "PLTE", "IDAT", "IEND"].includes(name)
    ) {
      throw new Error(
        `Browser screenshot PNG has an unknown critical chunk ${name}`,
      );
    }
    if (!sawHeader && name !== "IHDR") {
      throw new Error("Browser screenshot PNG must begin with IHDR");
    }
    if (name === "IHDR") {
      if (sawHeader || length !== 13) {
        throw new Error("Browser screenshot PNG IHDR is invalid");
      }
      sawHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (
        width === 0 ||
        height === 0 ||
        width > MAX_BROWSER_SCREENSHOT_WIDTH ||
        height > MAX_BROWSER_SCREENSHOT_HEIGHT ||
        width * height > MAX_BROWSER_SCREENSHOT_PIXELS ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0 ||
        !validPngBitDepth(colorType, bitDepth)
      ) {
        throw new Error("Browser screenshot dimensions or IHDR are invalid");
      }
      interlace = data[12]!;
    } else if (name === "IDAT") {
      if (!sawHeader || ended || sawPostImageData)
        throw new Error("Browser screenshot PNG IDAT is invalid");
      sawImageData = true;
      sawData = true;
      idat.push(data);
    } else if (name === "PLTE") {
      if (
        sawImageData ||
        sawPalette ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 768
      ) {
        throw new Error("Browser screenshot PNG palette is invalid");
      }
      if (colorType === 0 || colorType === 4) {
        throw new Error(
          "Browser screenshot PNG palette is invalid for this color type",
        );
      }
      sawPalette = true;
      paletteEntries = length / 3;
    } else if (name === "tRNS") {
      if (
        sawImageData ||
        sawTransparency ||
        (colorType !== 3 && colorType !== 0 && colorType !== 2)
      ) {
        throw new Error("Browser screenshot PNG transparency is invalid");
      }
      sawTransparency = true;
      if (colorType === 3 && (!sawPalette || length > paletteEntries)) {
        throw new Error("Browser screenshot PNG transparency is invalid");
      }
      if (colorType === 0 && length !== 2) {
        throw new Error(
          "Browser screenshot PNG grayscale transparency is invalid",
        );
      }
      if (colorType === 2 && length !== 6) {
        throw new Error("Browser screenshot PNG RGB transparency is invalid");
      }
    } else if (name === "IEND") {
      if (!sawHeader || !sawData || length !== 0) {
        throw new Error("Browser screenshot PNG IEND is invalid");
      }
      ended = true;
    } else if (sawImageData) {
      sawPostImageData = true;
    }
    offset = crcEnd;
    if (ended) break;
  }
  if (!sawHeader || !sawData || !ended || offset !== buffer.length) {
    throw new Error("Browser screenshot PNG is incomplete");
  }
  if (colorType === 3 && !sawPalette) {
    throw new Error("Browser screenshot PNG palette is missing");
  }
  if (interlace !== 0) {
    throw new Error("Interlaced browser screenshots are unsupported");
  }
  const channels =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 3
          ? 1
          : colorType === 4
            ? 2
            : 4;
  if (
    colorType === 3 &&
    (paletteEntries === 0 || paletteEntries > 1 << bitDepth)
  ) {
    throw new Error("Browser screenshot PNG palette entries are invalid");
  }
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const decodedBytes = (rowBytes + 1) * height;
  if (decodedBytes > MAX_BROWSER_SCREENSHOT_DECODE_BYTES) {
    throw new Error("Browser screenshot decoded image exceeds the byte bound");
  }
  if (
    activeBrowserScreenshotDecodeBytes + decodedBytes >
    MAX_BROWSER_SCREENSHOT_DECODE_BYTES
  ) {
    throw new Error("Browser screenshot decode budget is exhausted");
  }
  activeBrowserScreenshotDecodeBytes += decodedBytes;
  try {
    const decoded = inflateSync(Buffer.concat(idat), {
      maxOutputLength: decodedBytes,
    });
    if (decoded.byteLength !== decodedBytes) {
      throw new Error("decoded byte count differs from image dimensions");
    }
    validatePngScanlines(
      decoded,
      width,
      height,
      rowBytes,
      channels,
      bitDepth,
      colorType,
      paletteEntries,
    );
  } catch (error) {
    throw new Error(
      `Browser screenshot PNG image data is not decodable: ${describeError(error)}`,
    );
  } finally {
    activeBrowserScreenshotDecodeBytes -= decodedBytes;
  }
  return { width, height };
}

function validatePngScanlines(
  decoded: Buffer,
  width: number,
  height: number,
  rowBytes: number,
  channels: number,
  bitDepth: number,
  colorType: number,
  paletteEntries: number,
): void {
  const bytesPerPixel = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const previous = Buffer.alloc(rowBytes);
  let offset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = decoded[offset++];
    if (filter === undefined || filter > 4) {
      throw new Error("decoded scanline filter is invalid");
    }
    const source = decoded.subarray(offset, offset + rowBytes);
    if (source.byteLength !== rowBytes)
      throw new Error("decoded scanline is truncated");
    const current = Buffer.alloc(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel]! : 0;
      const up = previous[index] ?? 0;
      const upperLeft =
        index >= bytesPerPixel ? previous[index - bytesPerPixel]! : 0;
      const value = source[index]!;
      current[index] =
        filter === 0
          ? value
          : filter === 1
            ? (value + left) & 0xff
            : filter === 2
              ? (value + up) & 0xff
              : filter === 3
                ? (value + Math.floor((left + up) / 2)) & 0xff
                : (value + paethPredictor(left, up, upperLeft)) & 0xff;
    }
    if (colorType === 3)
      validatePaletteIndices(current, width, bitDepth, paletteEntries);
    current.copy(previous);
    offset += rowBytes;
  }
  if (offset !== decoded.byteLength)
    throw new Error("decoded scanline data has a trailing payload");
}

function validatePaletteIndices(
  row: Buffer,
  width: number,
  bitDepth: number,
  paletteEntries: number,
): void {
  if (bitDepth === 8) {
    for (let index = 0; index < width; index += 1) {
      if ((row[index] ?? paletteEntries) >= paletteEntries) {
        throw new Error("decoded palette index is out of range");
      }
    }
    return;
  }
  const mask = (1 << bitDepth) - 1;
  for (let index = 0; index < width; index += 1) {
    const bit = index * bitDepth;
    const value =
      (row[Math.floor(bit / 8)]! >> (8 - bitDepth - (bit % 8))) & mask;
    if (value >= paletteEntries)
      throw new Error("decoded palette index is out of range");
  }
}

function paethPredictor(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance)
    return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function validPngBitDepth(colorType: number, bitDepth: number): boolean {
  if (![0, 2, 3, 4, 6].includes(colorType)) return false;
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  return bitDepth === 8 || bitDepth === 16;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function requiredTargetId(
  arguments_: Record<string, unknown>,
  key: string,
): string {
  const value = requiredString(arguments_, key);
  assertTargetId(value, key);
  return value;
}

function assertTargetId(value: string, key: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(value)) {
    throw new Error(`${key} must contain only letters, numbers, _ or -`);
  }
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

function optionalBoolean(
  arguments_: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = arguments_[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
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

function browserTargetSchema(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return objectSchema(
    { sessionId: stringSchema(), tabId: stringSchema(), ...properties },
    ["sessionId", "tabId", ...required],
  );
}

async function clearElectronSession(session: Session): Promise<void> {
  await Promise.all([
    session.clearStorageData(),
    session.clearCache(),
    session.clearAuthCache(),
  ]);
  session.flushStorageData();
}

async function settlePage(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    window.webContents.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function evaluateInTab<T>(
  tab: BrowserTab,
  expression: string,
  beforeDispatch?: () => void,
): Promise<T> {
  return await evaluateBrowserDocument<T>(
    tab.window.webContents.debugger,
    expression,
    beforeDispatch,
  );
}

/** Named isolated execution prevents the page from forging the node registry. */
export async function evaluateBrowserDocument<T>(
  debuggerApi: Pick<BrowserWindow["webContents"]["debugger"], "sendCommand">,
  expression: string,
  beforeDispatch?: () => void,
): Promise<T> {
  const tree = (await debuggerApi.sendCommand("Page.getFrameTree")) as {
    frameTree?: { frame?: { id?: string } };
  };
  const frameId = tree.frameTree?.frame?.id;
  if (typeof frameId !== "string" || frameId.length === 0)
    throw new Error("Browser CDP main-frame identity is unavailable");
  const world = (await debuggerApi.sendCommand("Page.createIsolatedWorld", {
    frameId,
    worldName: "zenx-browser-observation-v1",
    grantUniveralAccess: false,
  })) as { executionContextId?: number };
  if (
    !Number.isSafeInteger(world.executionContextId) ||
    world.executionContextId! <= 0
  )
    throw new Error("Browser CDP isolated execution context is unavailable");
  beforeDispatch?.();
  const response = (await debuggerApi.sendCommand("Runtime.evaluate", {
    expression,
    contextId: world.executionContextId,
    awaitPromise: true,
    returnByValue: true,
  })) as {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string };
  };
  if (response.exceptionDetails !== undefined) {
    throw new Error(
      `Browser CDP evaluation failed: ${response.exceptionDetails.text ?? response.result?.description ?? "unknown error"}`,
    );
  }
  if (includesBrowserInputSnapshot(expression)) {
    return (await resolveBrowserInputEvidence(
      response.result?.value,
      async (method, params) => {
        beforeDispatch?.();
        return await debuggerApi.sendCommand(method, {
          ...params,
          ...(method === "Runtime.evaluate"
            ? { contextId: world.executionContextId }
            : {}),
        });
      },
    )) as T;
  }
  return response.result?.value as T;
}

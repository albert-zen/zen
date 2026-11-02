import {
  BrowserEventBuffer,
  browserExtensionOperations,
  type BrowserExtensionOperation,
} from "./browser-extensions.js";
import { localErrorDetail } from "../../local-error-detail.js";
import {
  type CdpDiagnosticConnection,
  type UserBrowserCdpDiagnosticObserver,
} from "./user-browser-cdp-diagnostics.js";
import { randomUUID } from "node:crypto";
import path from "node:path";

import WebSocket from "ws";

import {
  processUserBrowserLiveFrame,
  USER_BROWSER_MAX_LIVE_FRAME_BYTES,
  type UserBrowserLiveImageDecoder,
} from "./user-browser-live-frame.js";

import {
  browserActionScript,
  browserScrollScript,
  assertBrowserObservation,
  type BrowserScrollDirection,
  browserInspectScript,
  browserDomCapture,
  redactBrowserUrl,
  resolveBrowserObservedTarget,
  BrowserScreenshotArtifactStore,
  type BrowserInspection,
  type BrowserDomInspection,
  type BrowserLiveObservationEvent,
  type BrowserLiveObservationListener,
  type BrowserScreenshotArtifact,
  type BrowserObservation,
  type BrowserTabSummary,
  type BrowserTabGrouping,
  type BrowserTargetFingerprint,
  type ZenXBrowserBackend,
} from "./browser-provider.js";
import {
  assertBrowserInputSnapshot,
  browserInputKey,
  browserInputPoint,
  browserInputProbeScript,
  browserInputSnapshotScript,
  browserTargetedInputPolicy,
  BrowserInputOutcomeUnknownError,
  dispatchBrowserTargetedInput,
  requireBrowserInputSnapshot,
  includesBrowserInputSnapshot,
  resolveBrowserInputEvidence,
  type BrowserInputKey,
  type BrowserInputObservation,
  type BrowserInputSnapshot,
  type BrowserInputViewport,
} from "./browser-targeted-input.js";
import {
  MAX_OBSERVATION_CAPTURE_ITEMS,
  OBSERVATION_CAPTURE,
} from "./observation-capture.js";

const USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS = 2_000;
// Attachment setup and the first trusted document observation have separate
// one-use windows. Neither grants arbitrary evaluation or mutation more time.
const USER_BROWSER_ATTACHMENT_SETUP_TIMEOUT_MS = 10_000;
const USER_BROWSER_FIRST_INSPECT_TIMEOUT_MS = 10_000;
const USER_BROWSER_SCREENSHOT_TIMEOUT_MS = 10_000;
const USER_BROWSER_INPUT_OBJECT_CLEANUP_TIMEOUT_MS = 500;
const USER_BROWSER_MAX_TARGET_EVIDENCE = 128;
const USER_BROWSER_MAX_DISCOVERED_TARGETS = 512;
const USER_BROWSER_MAX_OPERATION_EVIDENCE = 32;
const USER_BROWSER_MAX_BACKEND_TAINT = 64;
const USER_BROWSER_MAX_PENDING_CDP_REQUESTS = 128;
const USER_BROWSER_MAX_ACTIVE_SESSIONS = 32;
const USER_BROWSER_LATE_RESPONSE_RETENTION_MS = 5_000;
const USER_BROWSER_DOCUMENT_WORLD_NAME = "__zenx_user_browser_document__";
export const USER_BROWSER_LIVE_FRAME_INTERVAL_MS = 100;
const USER_BROWSER_LIVE_CAPTURE_INTERVAL_MS = 500;
const USER_BROWSER_MAX_LIVE_FRAME_WIDTH = 1920;
const USER_BROWSER_MAX_LIVE_FRAME_HEIGHT = 1200;
const FALLBACK_SCREENSHOT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export class UserBrowserScreenshotMalformedError extends Error {
  constructor(message = "Attached browser screenshot response was malformed") {
    super(message);
    this.name = "UserBrowserScreenshotMalformedError";
  }
}

export { USER_BROWSER_MAX_LIVE_FRAME_BYTES };

type UserBrowserCdpOutcome =
  "known-success" | "known-failure" | "outcome-unknown";

interface UserBrowserAttachmentOwner {
  logicalSessionId: string;
  logicalSessionIncarnation: number;
}

interface UserBrowserAttachmentEpoch extends UserBrowserAttachmentOwner {
  targetId: string;
  cdpSessionId?: string;
  attachAttempt: number;
  /** Original setup deadline; cached attachments never renew it. */
  setupDeadline: number;
  firstInspectClaimed: boolean;
  /** A returned reservation keeps its originally granted deadline, even expired. */
  firstInspectGrantedDeadline?: number;
  firstInspectReservation?: { deadline: number };
  attach: UserBrowserCdpOutcome;
  enable: UserBrowserCdpOutcome;
  runtimeEnable: UserBrowserCdpOutcome;
  detach: UserBrowserCdpOutcome;
  unknownEvidence: Partial<
    Record<"attach" | "enable" | "runtimeEnable" | "detach", string>
  >;
  lifecycleEvidence: string[];
  taint?: string;
  unsettledMutation?: string;
  /** Exact attachment-session dialog state; never persisted or auto-dismissed. */
  nativeDialogOpen?: boolean;
  /** Closing this exact route stops disposable observation traffic before detach. */
  observationClosing?: boolean;
}

interface ZenXUserBrowserDocumentExecutionFence extends UserBrowserAttachmentOwner {
  targetId: string;
  sessionId: string;
  attachmentEpoch: UserBrowserAttachmentEpoch;
  providerRevision: number;
  documentRevision: number;
  frameId: string;
  loaderId: string;
  url: string;
  executionContextId?: number;
}

interface UserBrowserScreencastState {
  targetId: string;
  sessionId: string;
  fence: ZenXUserBrowserDocumentExecutionFence;
  subscription: UserBrowserScreencastSubscription;
  latestFrame?: Extract<BrowserLiveObservationEvent, { type: "frame" }>;
  publishTimer?: NodeJS.Timeout;
  captureTimer?: NodeJS.Timeout;
  captureDueAt?: number;
  captureInFlight?: boolean;
  lastPublishedAt: number;
  nextSequence: number;
}

interface UserBrowserScreencastSubscription {
  targetId: string;
  owner: UserBrowserAttachmentOwner;
  listener: BrowserLiveObservationListener;
  active: boolean;
  restartQueued: boolean;
}

export interface UserBrowserCdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export interface UserBrowserTargetCreation {
  targetId: string;
  grouping: BrowserTabGrouping;
}

export interface UserBrowserCdpClient {
  extensionEvents?(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    operation: BrowserExtensionOperation,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>;

  observeTargetMetadata?(
    targetId: string,
    listener: (target: UserBrowserCdpTarget) => void,
  ): () => void;
  observeScreencast?(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    listener: BrowserLiveObservationListener,
  ): Promise<() => Promise<void>>;
  listTargets(signal?: AbortSignal): Promise<UserBrowserCdpTarget[]>;
  createTarget(
    url: string,
    signal?: AbortSignal,
    groupSessionId?: string,
  ): Promise<string | UserBrowserTargetCreation>;
  findTargetsByUrl(
    url: string,
    signal?: AbortSignal,
  ): Promise<UserBrowserCdpTarget[]>;
  navigate(
    targetId: string,
    url: string,
    owner: UserBrowserAttachmentOwner,
    signal?: AbortSignal,
    onDispatched?: () => void,
  ): Promise<void>;
  evaluateDocument(
    targetId: string,
    expression: string,
    owner: UserBrowserAttachmentOwner,
    expectedDocumentIdentity?: string,
    signal?: AbortSignal,
    onDispatched?: () => void,
    programmable?: "isolated" | "main",
  ): Promise<{ value: unknown; documentIdentity: string }>;
  targetedInput?(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    expectedDocumentIdentity: string,
    observed: BrowserInputSnapshot,
    action: UserBrowserTargetedInputAction,
    signal?: AbortSignal,
    assertCurrent?: () => void,
    onDispatched?: () => void,
  ): Promise<void>;
  captureScreenshot?(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    expectedDocumentIdentity: string,
    signal?: AbortSignal,
  ): Promise<{
    data: string;
    documentIdentity: string;
    status?: "captured" | "fallback";
    reason?: string;
  }>;
  getDocumentIdentity(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    signal?: AbortSignal,
  ): Promise<string>;
  assertDocumentCurrent?(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    expectedDocumentIdentity: string,
  ): void;
  closeCreatedTarget?(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
  ): Promise<void>;
  detachTarget(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
  ): Promise<void>;
  closureProblem(
    targetIds: readonly string[],
    owner: UserBrowserAttachmentOwner,
  ): string | undefined;
  close(): Promise<void> | void;
}

type UserBrowserTargetedInputAction =
  | { kind: "click"; x: number; y: number }
  | { kind: "key"; key: BrowserInputKey };

interface UserBrowserSession {
  id: string;
  incarnation: number;
  targetIds: Set<string>;
  createdTargetIds: Set<string>;
  uncertainTargetIds: Set<string>;
  ignoredTargetIds: Set<string>;
  operationTail: Promise<void>;
  unresolvedCreates: Map<string, Set<string>>;
  detachFailures: string[];
  taints: string[];
  closeQueued: boolean;
  detaching: boolean;
}

interface UserBrowserTabState {
  ownerSessionId: string;
  ownerSessionIncarnation: number;
  documentVersion: number;
  url: string;
  documentIdentity?: string;
  observation?: BrowserObservation;
  operation?: Promise<void>;
  detaching: boolean;
  tainted?: string;
}

class ZenXUserBrowserAttachmentEpochBoundary {
  readonly backendTaints: string[] = [];

  enqueue<T>(
    session: UserBrowserSession,
    assertCurrent: () => void,
    run: () => Promise<T>,
  ): Promise<T> {
    assertCurrent();
    const previous = session.operationTail;
    const result = (async () => {
      await previous;
      assertCurrent();
      return await run();
    })();
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    session.operationTail = settled;
    return result;
  }

  recordSessionEvidence(
    session: UserBrowserSession,
    collection: string[],
    detail: string,
    overflowDetail: string,
  ): void {
    if (collection.length < USER_BROWSER_MAX_OPERATION_EVIDENCE) {
      collection.push(detail);
      return;
    }
    this.taintSession(session, overflowDetail);
  }

  taintSession(session: UserBrowserSession, detail: string): void {
    if (session.taints.includes(detail)) return;
    if (session.taints.length < USER_BROWSER_MAX_OPERATION_EVIDENCE) {
      session.taints.push(detail);
      return;
    }
    const overflow = "session taint diagnostics exceeded their bound";
    if (!session.taints.includes(overflow)) {
      session.taints[session.taints.length - 1] = overflow;
    }
  }

  taintBackend(owner: string, detail: string): void {
    const evidence = `${owner}: ${detail}`;
    if (this.backendTaints.includes(evidence)) return;
    if (this.backendTaints.length < USER_BROWSER_MAX_BACKEND_TAINT) {
      this.backendTaints.push(evidence);
      return;
    }
    this.backendTaints[this.backendTaints.length - 1] =
      "backend taint diagnostics exceeded their bound";
  }

  throwIfSessionTainted(session: UserBrowserSession, operation: string): void {
    if (session.taints.length === 0) return;
    throw new Error(
      `User browser ${operation} outcome is unknown; provider session is tainted (${session.taints.join("; ")})`,
    );
  }

  throwIfBackendOwnerTainted(owner: string, operation: string): void {
    const evidence = this.backendTaints.filter((detail) =>
      detail.startsWith(`${owner}: `),
    );
    if (evidence.length === 0) return;
    throw new Error(
      `User browser ${operation} outcome is unknown; provider session is tainted (${evidence.join("; ")})`,
    );
  }
}

/** Opt-in Host diagnostics, containing no page text, URL or opaque node IDs. */
export interface UserBrowserInputCaptureDiagnostic {
  reason:
    | "initial-snapshot-missing"
    | "initial-snapshot-invalid"
    | "after-snapshot-invalid"
    | "snapshot-changed"
    | "screenshot-fallback"
    | "targeted-input-unavailable";
  captureStatus: "captured" | "fallback";
  before: ReturnType<typeof inputCaptureSnapshotDiagnostic>;
  after: ReturnType<typeof inputCaptureSnapshotDiagnostic>;
  documentChanged?: boolean;
  focusChanged?: boolean;
}

function inputCaptureSnapshotDiagnostic(value: unknown) {
  const raw = asRecord(value);
  const viewport = asRecord(raw?.viewport);
  const dimensions: Partial<BrowserInputViewport> = {};
  for (const key of [
    "width",
    "height",
    "deviceScaleFactor",
    "scrollX",
    "scrollY",
    "visualScale",
    "visualOffsetX",
    "visualOffsetY",
  ] as const) {
    const scalar = viewport?.[key];
    if (typeof scalar === "number" && Number.isFinite(scalar))
      dimensions[key] = scalar;
  }
  return {
    available: raw !== undefined,
    ...(typeof raw?.inputRevision === "number" &&
    Number.isSafeInteger(raw.inputRevision)
      ? { inputRevision: raw.inputRevision }
      : {}),
    ...(typeof raw?.layoutRevision === "number" &&
    Number.isSafeInteger(raw.layoutRevision)
      ? { layoutRevision: raw.layoutRevision }
      : {}),
    viewport: dimensions,
  };
}

export class UserBrowserCdpBackend implements ZenXBrowserBackend {
  readonly #client: UserBrowserCdpClient;
  readonly #onInputCaptureDiagnostic?: (
    value: UserBrowserInputCaptureDiagnostic,
  ) => void;
  readonly #sessions = new Map<string, UserBrowserSession>();
  readonly #tabs = new Map<string, UserBrowserTabState>();
  readonly #detachOperations = new Map<string, Promise<void>>();
  readonly #sessionCloseOperations = new Map<string, Promise<number>>();
  readonly #closure = new ZenXUserBrowserAttachmentEpochBoundary();
  readonly #artifacts: BrowserScreenshotArtifactStore;
  #closeOperation?: Promise<void>;
  #backendCloseQueued = false;
  #closing = false;
  #nextSessionIncarnation = 1;
  readonly #liveSubscriptions = new Set<{
    sessionId: string;
    tabId: string;
    stop: () => void;
    listener: BrowserLiveObservationListener;
  }>();
  #liveQueue: Promise<void> = Promise.resolve();

  constructor(
    client: UserBrowserCdpClient,
    options: {
      artifactDirectory?: string;
      onInputCaptureDiagnostic?: (
        value: UserBrowserInputCaptureDiagnostic,
      ) => void;
    } = {},
  ) {
    this.#client = client;
    this.#onInputCaptureDiagnostic = options.onInputCaptureDiagnostic;
    this.#artifacts = new BrowserScreenshotArtifactStore(
      options.artifactDirectory,
    );
  }

  observeTab(
    sessionId: string,
    tabId: string,
    listener: BrowserLiveObservationListener,
  ): () => void {
    const { session } = this.#sessionTab(sessionId, tabId);
    const observe = this.#client.observeScreencast;
    if (this.#backendCloseQueued || this.#closing || observe === undefined) {
      listener({
        type: "status",
        status: "unavailable",
        message: "Live observation is unavailable for this Browser provider.",
      });
      return () => {};
    }
    for (const prior of [...this.#liveSubscriptions]) {
      prior.listener({
        type: "status",
        status: "unavailable",
        message: "Live observation moved to another Browser panel.",
      });
      prior.stop();
    }
    let active = true;
    let stop: (() => Promise<void>) | undefined;
    const stopMetadata = this.#client.observeTargetMetadata?.(
      tabId,
      (target) => {
        if (active)
          listener({
            type: "metadata",
            title: target.title.slice(0, 256),
            url: redactBrowserUrl(target.url),
          });
      },
    );
    const entry = {
      sessionId,
      tabId,
      listener,
      stop: () => {
        active = false;
        stopMetadata?.();
        this.#liveSubscriptions.delete(entry);
        this.#liveQueue = this.#liveQueue
          .then(async () => {
            await stop?.();
          })
          .catch(() => undefined);
      },
    };
    this.#liveSubscriptions.add(entry);
    listener({
      type: "status",
      status: "connecting",
      message: "Connecting to this thread's browser page...",
    });
    this.#liveQueue = this.#liveQueue.then(async () => {
      if (!active) return;
      try {
        const dispose = await observe.call(
          this.#client,
          tabId,
          this.#attachmentOwner(session),
          (event) => {
            if (active) listener(event);
          },
        );
        if (!active) await dispose();
        else stop = dispose;
      } catch (error) {
        if (active)
          listener({
            type: "status",
            status: "failed",
            message: "The live browser view could not be connected.",
            details: localErrorDetail(error),
          });
      }
    });
    return entry.stop;
  }

  async hasTab(sessionId: string, tabId: string): Promise<boolean> {
    const { session, tab } = this.#sessionTab(sessionId, tabId);
    const assertCurrent = () => {
      if (this.#backendCloseQueued || session.closeQueued)
        throw new Error("User browser session is closing");
      this.#assertTabCurrent(session, tabId, tab);
    };
    assertCurrent();
    return await this.#startSessionOperation(session, async () => {
      assertCurrent();
      // Do not call listTabs: it is bounded discovery and may adopt new targets.
      const targets = await this.#client.listTargets();
      assertCurrent();
      return targets.some(
        (target) => target.targetId === tabId && target.type === "page",
      );
    });
  }

  async readCurrentUrl(sessionId: string, tabId: string): Promise<string> {
    const { session, tab } = this.#sessionTab(sessionId, tabId);
    const assertCurrent = () => {
      if (this.#backendCloseQueued || session.closeQueued)
        throw new Error("User browser session is closing");
      this.#assertTabCurrent(session, tabId, tab);
      this.#transferClientClosureProblem(session, [tabId]);
      this.#throwIfSessionTainted(session, "URL read");
    };
    assertCurrent();
    return await this.#startSessionOperation(session, async () => {
      assertCurrent();
      const documentVersion = tab.documentVersion;
      const targets = await this.#client.listTargets();
      assertCurrent();
      if (tab.documentVersion !== documentVersion)
        throw new Error("User browser document changed during URL read");
      const target = targets.find(
        (candidate) =>
          candidate.targetId === tabId && candidate.type === "page",
      );
      if (target === undefined) throw new Error("User browser tab was closed");
      return target.url;
    });
  }

  async listTabs(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary[]> {
    throwIfAborted(signal);
    const session = this.#session(sessionId);
    const operation = this.#startSessionOperation(session, async () => {
      const listed = await this.#client.listTargets(signal);
      const targets = listed.filter(
        (target) =>
          target.type === "page" &&
          isInspectableUrl(target.url) &&
          !session.ignoredTargetIds.has(target.targetId) &&
          (this.#tabs.get(target.targetId) === undefined ||
            (this.#tabs.get(target.targetId)?.ownerSessionId === session.id &&
              this.#tabs.get(target.targetId)?.ownerSessionIncarnation ===
                session.incarnation)),
      );
      this.#assertSessionCurrent(session);
      const live = new Set(targets.map((target) => target.targetId));
      const disappeared: string[] = [];
      for (const targetId of session.targetIds) {
        if (!live.has(targetId)) {
          disappeared.push(targetId);
        }
      }
      for (const targetId of disappeared) {
        this.#assertTargetCleanupOwner(session, targetId);
      }
      const detached = await Promise.allSettled(
        disappeared.map((targetId) => this.#detachTarget(session, targetId)),
      );
      for (const [index, targetId] of disappeared.entries()) {
        const tab = this.#tabs.get(targetId);
        if (tab?.tainted !== undefined) {
          this.#taintSession(session, `target ${targetId}: ${tab.tainted}`);
        }
        const result = detached[index];
        if (result?.status === "rejected") {
          this.#recordSessionEvidence(
            session,
            session.detachFailures,
            describeError(result.reason),
            "detach diagnostics exceeded their bound",
          );
          this.#taintSession(
            session,
            `detach outcome is unknown (${describeError(result.reason)})`,
          );
        }
      }
      this.#transferClientClosureProblem(session, disappeared);
      for (const targetId of disappeared) {
        session.targetIds.delete(targetId);
        const tab = this.#tabs.get(targetId);
        if (tab === undefined || this.#tabBelongsToSession(tab, session)) {
          this.#tabs.delete(targetId);
        }
      }
      const detachFailure = detached.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (detachFailure !== undefined) throw detachFailure.reason;
      this.#assertSessionIdle(session);
      this.#throwIfSessionTainted(session, "target reconciliation");
      this.#assertSessionCurrent(session);
      const published: UserBrowserCdpTarget[] = [];
      for (const target of targets) {
        const tab = this.#tabs.get(target.targetId);
        if (tab === undefined) {
          this.#tabs.set(target.targetId, {
            ownerSessionId: session.id,
            ownerSessionIncarnation: session.incarnation,
            documentVersion: 1,
            url: target.url,
            detaching: false,
          });
        } else if (!this.#tabBelongsToSession(tab, session)) {
          continue;
        } else if (tab.url !== target.url) {
          tab.url = target.url;
          tab.documentVersion += 1;
          tab.documentIdentity = undefined;
          tab.observation = undefined;
        }
        session.targetIds.add(target.targetId);
        published.push(target);
      }
      this.#assertSessionCurrent(session);
      return published
        .slice(0, 24)
        .map((target) => summarizeTarget(sessionId, target));
    });
    return await raceAbort(operation, signal);
  }

  async open(
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    throwIfAborted(signal);
    const session = this.#session(sessionId);
    const operation = this.#startSessionOperation(session, async () => {
      const pendingUrl = `about:blank#zenx-pending-${randomUUID()}`;
      const beforeTargets = await this.#client.listTargets(signal);
      const beforeTargetIds = new Set(
        beforeTargets.map((target) => target.targetId),
      );
      if (beforeTargets.some((target) => target.url === pendingUrl)) {
        throw new Error("User browser create marker already exists");
      }
      let targetId: string | undefined;
      let grouping: BrowserTabGrouping;
      try {
        const created = await this.#client.createTarget(
          pendingUrl,
          signal,
          sessionId,
        );
        targetId = typeof created === "string" ? created : created.targetId;
        grouping = readUserBrowserGrouping(
          typeof created === "string" ? undefined : created.grouping,
        );
      } catch (error) {
        this.#recordUnresolvedCreate(session, pendingUrl, beforeTargetIds);
        const recovered = await this.#reconcileCreate(
          session,
          pendingUrl,
          beforeTargetIds,
          signal,
        );
        if (recovered === undefined) {
          throw new Error(
            `User browser create outcome is unknown (${describeError(error)})`,
          );
        }
        throw new Error(
          `User browser create outcome is unknown; recovered provider target ${recovered.targetId} for cleanup (${describeError(error)})`,
        );
      }
      if (beforeTargetIds.has(targetId)) {
        this.#recordUnresolvedCreate(session, pendingUrl, beforeTargetIds);
        throw new Error("User browser create returned a pre-existing target");
      }
      // Account for the target before observing the session fence. A concurrent
      // close can then deterministically detach it instead of orphaning it.
      const existingTab = this.#tabs.get(targetId);
      if (
        existingTab !== undefined &&
        (existingTab.ownerSessionId !== session.id ||
          existingTab.ownerSessionIncarnation !== session.incarnation)
      ) {
        this.#recordUnresolvedCreate(session, pendingUrl, beforeTargetIds);
        this.#taintSession(session, "create target crossed session ownership");
        throw new Error(
          "User browser create marker reconciliation is ambiguous",
        );
      }
      this.#accountTarget(session, targetId, pendingUrl, false);
      session.createdTargetIds.add(targetId);
      const matches = await this.#client
        .findTargetsByUrl(pendingUrl, signal)
        .catch((error) => {
          if (signal?.aborted === true) throw error;
          return [];
        });
      const createdMatches = matches.filter(
        (target) => !beforeTargetIds.has(target.targetId),
      );
      if (
        createdMatches.length !== 1 ||
        createdMatches[0]?.type !== "page" ||
        !this.#tabBelongsToOrIsUnowned(
          createdMatches[0]?.targetId ?? "",
          session,
        ) ||
        createdMatches[0]?.targetId !== targetId
      ) {
        const tab = this.#tabs.get(targetId);
        if (tab !== undefined) tab.tainted = "create marker was ambiguous";
        if (createdMatches.some((target) => target.targetId !== targetId)) {
          this.#recordUnresolvedCreate(session, pendingUrl, beforeTargetIds);
        }
        throw new Error(
          "User browser create marker reconciliation is ambiguous",
        );
      }
      this.#assertSessionCurrent(session);
      throwIfAborted(signal);
      const tab = this.#tabs.get(targetId);
      let dispatched = false;
      try {
        await this.#client.navigate(
          targetId,
          url,
          this.#attachmentOwner(session),
          signal,
          () => (dispatched = true),
        );
        if (tab !== undefined) tab.url = url;
        this.#assertSessionCurrent(session);
        throwIfAborted(signal);
        const summary = await this.#summary(sessionId, targetId);
        this.#assertSessionCurrent(session);
        throwIfAborted(signal);
        return { ...summary, grouping };
      } catch (error) {
        if (
          tab !== undefined &&
          (error instanceof UserBrowserMutationOutcomeUnknownError ||
            error instanceof UserBrowserDocumentChangedAfterDispatchError)
        ) {
          tab.tainted = describeError(error);
        }
        if (signal?.aborted === true && tab !== undefined) {
          await this.#compensateCancelledCreate(session, targetId, tab);
        }
        throw error;
      }
    });
    const result = await raceAbort(operation, signal);

    return result;
  }

  navigate(
    sessionId: string,
    tabId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const operation = this.#navigate(sessionId, tabId, url, signal);
    observeRejection(operation);
    return operation;
  }

  async #navigate(
    sessionId: string,
    tabId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    throwIfAborted(signal);
    const { session, tab } = this.#sessionTab(sessionId, tabId);
    let dispatched = false;
    const operation = this.#startOperation(session, tab, async () => {
      try {
        await this.#client.navigate(
          tabId,
          url,
          this.#attachmentOwner(session),
          signal,
          () => (dispatched = true),
        );
        tab.documentVersion += 1;
        tab.url = url;
        tab.documentIdentity = undefined;
        tab.observation = undefined;
        return await this.#summary(sessionId, tabId);
      } catch (error) {
        if (
          error instanceof UserBrowserMutationOutcomeUnknownError ||
          error instanceof UserBrowserDocumentChangedAfterDispatchError
        ) {
          tab.tainted = describeError(error);
        }
        throw error;
      }
    });
    try {
      const result = await raceAbort(operation, signal);

      return result;
    } catch (error) {
      if (
        error instanceof UserBrowserMutationOutcomeUnknownError ||
        error instanceof UserBrowserDocumentChangedAfterDispatchError ||
        (dispatched && signal?.aborted === true)
      ) {
        tab.tainted ??= describeError(error);
        throw new Error(
          `User browser navigation outcome is unknown after cancellation or connection failure (${describeError(error)})`,
        );
      }
      throw error;
    }
  }

  async inspect(
    sessionId: string,
    tabId: string,
    signal?: AbortSignal,
  ): Promise<BrowserInspection> {
    throwIfAborted(signal);
    const { session, tab } = this.#sessionTab(sessionId, tabId);
    tab.observation = undefined;
    const operation = this.#startOperation(session, tab, async () => {
      let evaluation: { value: unknown; documentIdentity: string };
      try {
        evaluation = await this.#client.evaluateDocument(
          tabId,
          browserInspectScript,
          this.#attachmentOwner(session),
          undefined,
          signal,
        );
      } catch (error) {
        if (error instanceof UserBrowserDocumentChangedAfterDispatchError) {
          throw new Error("User browser document changed during inspection");
        }
        throw error;
      }
      const raw = asRecord(evaluation.value);
      if (
        raw === undefined ||
        typeof raw.visibleText !== "string" ||
        !Array.isArray(raw.targets) ||
        (raw.documentIdentity !== undefined &&
          !isCaptureIdentity(raw.documentIdentity, 16_384)) ||
        [raw.itemTotal, raw.textTotal].some(
          (total) =>
            total !== undefined &&
            (typeof total !== "number" ||
              !Number.isSafeInteger(total) ||
              total < 0),
        )
      ) {
        throw new Error(
          "User browser CDP inspection returned an unsupported shape",
        );
      }
      const fingerprints = raw.targets
        .slice(0, MAX_OBSERVATION_CAPTURE_ITEMS)
        .map(requireFingerprint);
      const inspected: BrowserDomInspection = {
        visibleText: raw.visibleText,
        targets: fingerprints,
        ...(raw.documentIdentity === undefined
          ? {}
          : { documentIdentity: raw.documentIdentity as string }),
        ...(raw.itemTotal === undefined
          ? {}
          : { itemTotal: raw.itemTotal as number }),
        ...(raw.textTotal === undefined
          ? {}
          : { textTotal: raw.textTotal as number }),
      };
      const targets = new Map<string, BrowserTargetFingerprint>();
      const observationId = randomUUID();
      const screenshotCapture =
        this.#client.captureScreenshot === undefined
          ? {
              data: FALLBACK_SCREENSHOT_PNG_BASE64,
              documentIdentity: evaluation.documentIdentity,
              status: "fallback" as const,
              reason:
                "Screenshot capture is not supported by the attached browser client",
            }
          : await this.#client.captureScreenshot(
              tabId,
              this.#attachmentOwner(session),
              evaluation.documentIdentity,
              signal,
            );
      if (screenshotCapture.documentIdentity !== evaluation.documentIdentity) {
        throw new Error("User browser document changed during inspection");
      }
      const finalIdentity = await this.#freshDocumentIdentity(
        tabId,
        session,
        evaluation.documentIdentity,
        signal,
      );
      if (finalIdentity !== evaluation.documentIdentity) {
        throw new Error(
          "User browser document changed before screenshot publication",
        );
      }
      const normalizedScreenshot =
        typeof screenshotCapture.data === "string" &&
        screenshotCapture.data.length > 0
          ? screenshotCapture
          : {
              data: FALLBACK_SCREENSHOT_PNG_BASE64,
              documentIdentity: screenshotCapture.documentIdentity,
              status: "fallback" as const,
              reason:
                "Attached browser screenshot response was empty or malformed",
            };
      let input: BrowserInputObservation | undefined;
      let afterInputSnapshot: unknown;
      let inputIssue: UserBrowserInputCaptureDiagnostic["reason"] =
        raw.inputSnapshot === undefined
          ? "initial-snapshot-missing"
          : normalizedScreenshot.status === "fallback"
            ? "screenshot-fallback"
            : "targeted-input-unavailable";
      if (
        raw.inputSnapshot !== undefined &&
        normalizedScreenshot.status !== "fallback" &&
        this.#client.targetedInput !== undefined
      ) {
        let snapshot: BrowserInputSnapshot | undefined;
        try {
          snapshot = requireBrowserInputSnapshot(raw.inputSnapshot);
        } catch {
          inputIssue = "initial-snapshot-invalid";
          // Optional coordinate/key support must not disable DOM inspection.
        }
        if (snapshot !== undefined) {
          const after = await this.#client.evaluateDocument(
            tabId,
            browserInputSnapshotScript,
            this.#attachmentOwner(session),
            evaluation.documentIdentity,
            signal,
          );
          if (after.documentIdentity !== evaluation.documentIdentity)
            throw new Error(
              "User browser document changed during input capture",
            );
          afterInputSnapshot = after.value;
          try {
            inputIssue = "after-snapshot-invalid";
            const afterSnapshot = requireBrowserInputSnapshot(after.value);
            inputIssue = "snapshot-changed";
            assertBrowserInputSnapshot(snapshot, afterSnapshot);
            input = { snapshot, screenshotId: observationId };
          } catch {
            // Keep the screenshot and DOM observation, but never authorize
            // coordinate/key input with an incoherent viewport snapshot.
          }
        }
      }
      if (input === undefined && this.#onInputCaptureDiagnostic !== undefined) {
        const before = asRecord(raw.inputSnapshot);
        const after = asRecord(afterInputSnapshot);
        try {
          this.#onInputCaptureDiagnostic({
            reason: inputIssue,
            captureStatus: normalizedScreenshot.status ?? "captured",
            before: inputCaptureSnapshotDiagnostic(before),
            after: inputCaptureSnapshotDiagnostic(after),
            ...(before && after
              ? {
                  documentChanged: before.documentKey !== after.documentKey,
                  focusChanged:
                    before.focusId !== after.focusId ||
                    before.focusBackendNodeId !== after.focusBackendNodeId,
                }
              : {}),
          });
        } catch {
          /* Diagnostics never change the observation or its fences. */
        }
      }
      const screenshotBytes = decodeUserBrowserScreenshot(
        normalizedScreenshot.data,
      );
      throwIfAborted(signal);
      const screenshot: BrowserScreenshotArtifact = await this.#artifacts.write(
        `${sessionId}/${tabId}`,
        observationId,
        screenshotBytes,
        {
          status: normalizedScreenshot.status ?? "captured",
          ...(normalizedScreenshot.reason === undefined
            ? {}
            : { reason: normalizedScreenshot.reason }),
        },
      );
      try {
        throwIfAborted(signal);
      } catch (error) {
        await this.#artifacts.removeArtifact(
          screenshot.artifactPath,
          screenshot.observationId,
        );
        throw error;
      }
      const projected = fingerprints.map((fingerprint) => {
        const targetId = randomUUID();
        targets.set(targetId, fingerprint);
        return {
          targetId,
          role: fingerprint.role,
          name: fingerprint.name,
          actions: [...fingerprint.actions],
          ...(fingerprint.value === undefined
            ? {}
            : { value: fingerprint.value }),
          ...(fingerprint.checked === undefined
            ? {}
            : { checked: fingerprint.checked }),
          ...(fingerprint.selected === undefined
            ? {}
            : { selected: fingerprint.selected }),
          ...(fingerprint.options === undefined
            ? {}
            : {
                options: fingerprint.options.map((option) => ({ ...option })),
              }),
          ...(fingerprint.optionsTruncated === undefined
            ? {}
            : { optionsTruncated: fingerprint.optionsTruncated }),
        };
      });
      const summary = await this.#summary(sessionId, tabId);
      this.#assertSessionCurrent(session);
      const publishIdentity = await this.#freshDocumentIdentity(
        tabId,
        session,
        evaluation.documentIdentity,
        signal,
      );
      if (publishIdentity !== evaluation.documentIdentity) {
        await this.#artifacts.removeArtifact(
          screenshot.artifactPath,
          screenshot.observationId,
        );
        throw new Error(
          "User browser document changed before inspection publication",
        );
      }
      tab.documentIdentity = evaluation.documentIdentity;
      tab.observation = {
        id: observationId,
        documentVersion: tab.documentVersion,
        targets,
        ...(input === undefined ? {} : { input }),
      };
      return {
        ...summary,
        observationId,
        documentVersion: tab.documentVersion,
        visibleText: raw.visibleText.slice(0, 8_000),
        screenshot,
        ...(input === undefined
          ? {}
          : {
              inputViewport: input.snapshot.viewport,
              focusedInputAvailable: input.snapshot.focusId !== null,
              inputPolicy: browserTargetedInputPolicy,
            }),
        targets: projected.slice(0, 80),
        [OBSERVATION_CAPTURE]: {
          ...browserDomCapture(
            inspected,
            projected,
            JSON.stringify([
              "user-browser",
              session.id,
              session.incarnation,
              tabId,
              evaluation.documentIdentity,
            ]),
          ),
          assertCurrent: () => {
            this.#assertTabCurrent(session, tabId, tab);
            if (
              tab.observation?.id !== observationId ||
              tab.documentIdentity !== evaluation.documentIdentity
            ) {
              throw new Error("User browser capture expired; inspect again");
            }
            this.#client.assertDocumentCurrent?.(
              tabId,
              this.#attachmentOwner(session),
              evaluation.documentIdentity,
            );
          },
        },
      };
    });
    const result = await raceAbort(operation, signal);

    return result;
  }

  async #freshDocumentIdentity(
    tabId: string,
    session: UserBrowserSession,
    _expected: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return await this.#client.getDocumentIdentity(
      tabId,
      this.#attachmentOwner(session),
      signal,
    );
  }

  click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const operation = this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "click",
      "",
      false,
      signal,
    );
    observeRejection(operation);
    return operation;
  }

  type(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const operation = this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "type",
      text,
      submit,
      signal,
    );
    observeRejection(operation);
    return operation;
  }

  select(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    option: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const operation = this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "select",
      option,
      false,
      signal,
    );
    observeRejection(operation);
    return operation;
  }

  get extensionOperations(): readonly BrowserExtensionOperation[] {
    return this.#client.extensionEvents
      ? browserExtensionOperations
      : ["evaluate", "content"];
  }
  async extension(
    sessionId: string,
    tabId: string,
    operation: BrowserExtensionOperation,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const { session, tab } = this.#sessionTab(sessionId, tabId);
    if (operation === "evaluate") {
      if (
        args.world !== undefined &&
        args.world !== "main" &&
        args.world !== "isolated"
      )
        throw Error("Browser evaluation world must be isolated or main");
      if (
        typeof args.expression !== "string" ||
        args.expression.length === 0 ||
        args.expression.length > 100000
      )
        throw Error("expression must contain 1 to 100000 characters");
      assertBrowserObservation(
        tab.observation,
        tab.documentVersion,
        String(args.observationId ?? ""),
      );
      let value: unknown;
      await this.#mutateObserved(
        sessionId,
        tabId,
        session,
        tab,
        `(async () => ({ok:true,value:await (${args.expression})}))()`,
        signal,
        args.world === "main" ? "main" : "isolated",
        (result) => {
          value = result;
        },
      );
      return { value };
    }
    return await this.#startOperation(session, tab, async () => {
      if (operation === "content") {
        const result = await this.#client.evaluateDocument(
          tabId,
          "document.documentElement.outerHTML",
          this.#attachmentOwner(session),
          undefined,
          signal,
          undefined,
          "isolated",
        );
        return { html: result.value };
      }
      if (!this.#client.extensionEvents)
        throw Error("Browser event collection unsupported by provider");
      return await this.#client.extensionEvents(
        tabId,
        this.#attachmentOwner(session),
        operation,
        args,
        signal,
      );
    });
  }

  async scroll(
    sessionId: string,
    tabId: string,
    observationId: string,
    direction: BrowserScrollDirection,
    pixels: number,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    throwIfAborted(signal);
    const expression = browserScrollScript(direction, pixels);
    const { session, tab } = this.#sessionTab(sessionId, tabId);
    assertBrowserObservation(
      tab.observation,
      tab.documentVersion,
      observationId,
    );
    const operation = this.#mutateObserved(
      sessionId,
      tabId,
      session,
      tab,
      expression,
      signal,
    );
    observeRejection(operation);
    return await operation;
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
    action: UserBrowserTargetedInputAction,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    throwIfAborted(signal);
    const { session, tab } = this.#sessionTab(sessionId, tabId);
    assertBrowserObservation(
      tab.observation,
      tab.documentVersion,
      observationId,
    );
    const observation = tab.observation;
    const input = observation.input;
    const expectedDocumentIdentity = tab.documentIdentity;
    const targetedInput = this.#client.targetedInput;
    if (targetedInput === undefined)
      throw new Error(
        "Browser targeted input is unavailable for this attached browser client",
      );
    if (
      input === undefined ||
      input.screenshotId !== observationId ||
      expectedDocumentIdentity === undefined
    )
      throw new Error(
        "A real, coherent screenshot is required for browser targeted input; inspect again",
      );
    if (action.kind === "click")
      browserInputPoint(input.snapshot, action.x, action.y);
    else browserInputKey(action.key);
    const version = tab.documentVersion;
    let dispatched = false;
    const operation = this.#startOperation(session, tab, async () => {
      try {
        await targetedInput.call(
          this.#client,
          tabId,
          this.#attachmentOwner(session),
          expectedDocumentIdentity,
          input.snapshot,
          action,
          signal,
          () => {
            throwIfAborted(signal);
            this.#assertTabCurrent(session, tabId, tab);
            if (
              tab.documentVersion !== version ||
              tab.documentIdentity !== expectedDocumentIdentity ||
              (!dispatched && tab.observation !== observation)
            )
              throw new UserBrowserDocumentChangedBeforeDispatchError();
          },
          () => {
            dispatched = true;
            tab.observation = undefined;
          },
        );
        tab.documentVersion += 1;
        tab.documentIdentity = undefined;
        try {
          return await this.#summary(sessionId, tabId, signal);
        } catch (error) {
          throw new BrowserInputOutcomeUnknownError(error, false);
        }
      } catch (error) {
        if (
          error instanceof UserBrowserMutationOutcomeUnknownError ||
          (error instanceof BrowserInputOutcomeUnknownError &&
            error.inputMayRemainPressed)
        )
          tab.tainted ??= describeError(error);
        throw error;
      }
    });
    observeRejection(operation);
    // The CDP client observes cancellation itself. Do not race away before it
    // quarantines unknown input and retains the command settlement fence.
    return await operation;
  }

  async closeTab(sessionId: string, tabId: string): Promise<void> {
    const session = this.#requireSession(sessionId);
    this.#transferClientClosureProblem(session, [...session.targetIds]);
    this.#throwIfSessionTainted(session, "tab close");
    if (!session.targetIds.has(tabId)) {
      throw new Error(`Unknown user browser tab: ${tabId}`);
    }
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error("User browser tab was closed");
    const operation = this.#startSessionOperation(
      session,
      async () => {
        this.#assertTabCurrent(session, tabId, tab, true);
        tab.detaching = true;
        let detached = false;
        try {
          await this.#detachTarget(session, tabId);
          detached = true;
        } catch (error) {
          this.#recordSessionEvidence(
            session,
            session.detachFailures,
            describeError(error),
            "detach diagnostics exceeded their bound",
          );
          this.#transferClientClosureProblem(session, [tabId]);
          this.#taintSession(
            session,
            `detach outcome is unknown (${describeError(error)})`,
          );
          if (
            session.uncertainTargetIds.size < USER_BROWSER_MAX_TARGET_EVIDENCE
          ) {
            session.uncertainTargetIds.add(tabId);
          } else {
            this.#taintSession(
              session,
              "uncertain detach ownership exceeded its bound",
            );
          }
          throw error;
        } finally {
          if (tab.tainted !== undefined) {
            this.#taintSession(session, `target ${tabId}: ${tab.tainted}`);
          }
          session.targetIds.delete(tabId);
          this.#ignoreTarget(session, tabId);
          if (
            this.#tabs.get(tabId) === tab &&
            this.#tabBelongsToSession(tab, session)
          ) {
            this.#tabs.delete(tabId);
          }
        }
        this.#throwIfSessionTainted(session, "tab close");
      },
      true,
    );
    await operation;
    for (const live of [...this.#liveSubscriptions])
      if (live.sessionId === sessionId && live.tabId === tabId) live.stop();
    await this.#artifacts.clearScope(`${sessionId}/${tabId}`);
  }

  keepTab(sessionId: string, tabId: string): void {
    this.#requireSession(sessionId).createdTargetIds.delete(tabId);
  }

  async finishSession(sessionId: string): Promise<void> {
    const session = this.#requireSession(sessionId);
    // Only positively identified pages created by this session are disposable.
    // Unknown creates and pre-existing user pages never enter this set.
    const outcomes = await Promise.allSettled(
      [...session.createdTargetIds].map(async (id) => {
        if (!session.targetIds.has(id)) return;
        if (!this.#client.closeCreatedTarget)
          throw new Error("Browser cannot close its temporary created page");
        await this.#startSessionOperation(
          session,
          async () => {
            const tab = this.#tabs.get(id);
            if (!tab) return;
            this.#assertTabCurrent(session, id, tab, true);
            await this.#client.closeCreatedTarget!(
              id,
              this.#attachmentOwner(session),
            );
            session.createdTargetIds.delete(id);
          },
          true,
        );
      }),
    );
    await this.closeSession(sessionId);
    const failure = outcomes.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async closeSession(sessionId: string): Promise<number> {
    const existing = this.#sessionCloseOperations.get(sessionId);
    if (existing !== undefined) return await existing;
    const session = this.#requireSession(sessionId);
    session.closeQueued = true;
    const closing = this.#startSessionOperation(
      session,
      async () => {
        session.detaching = true;
        for (const targetId of session.targetIds) {
          const tab = this.#tabs.get(targetId);
          if (tab !== undefined) {
            this.#assertTargetCleanupOwner(session, targetId);
            tab.detaching = true;
          }
        }
        await this.#reconcileUnresolvedCreates(session);
        const targetIds = [
          ...new Set([...session.targetIds, ...session.uncertainTargetIds]),
        ];
        const count = targetIds.length;
        for (const targetId of targetIds) {
          this.#assertTargetCleanupOwner(session, targetId);
        }
        this.#transferClientClosureProblem(session, targetIds);
        const detached = await Promise.allSettled(
          targetIds.map((targetId) => this.#detachTarget(session, targetId)),
        );
        this.#transferClientClosureProblem(session, targetIds);
        const failure = detached.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failure !== undefined) {
          this.#recordSessionEvidence(
            session,
            session.detachFailures,
            describeError(failure.reason),
            "detach diagnostics exceeded their bound",
          );
          this.#taintSession(
            session,
            `detach outcome is unknown (${describeError(failure.reason)})`,
          );
        }
        for (const targetId of targetIds) {
          const tab = this.#tabs.get(targetId);
          if (tab?.tainted !== undefined) {
            this.#taintSession(session, `target ${targetId}: ${tab.tainted}`);
          }
          if (tab === undefined || this.#tabBelongsToSession(tab, session)) {
            this.#tabs.delete(targetId);
          }
        }
        if (session.detachFailures[0] !== undefined) {
          this.#taintSession(
            session,
            `detach outcome is unknown (${session.detachFailures[0]})`,
          );
        }
        if (session.unresolvedCreates.size > 0) {
          this.#taintSession(session, "create outcome is unknown");
        }
        if (session.taints.length > 0) {
          for (const taint of session.taints)
            this.#taintBackend(session.id, taint);
        }
        this.#sessions.delete(sessionId);
        await this.#artifacts.clearScope(sessionId);
        this.#throwIfSessionTainted(session, "session close");
        return count;
      },
      true,
    );
    this.#sessionCloseOperations.set(sessionId, closing);
    void closing
      .finally(() => {
        if (this.#sessionCloseOperations.get(sessionId) === closing)
          this.#sessionCloseOperations.delete(sessionId);
      })
      .catch(() => undefined);
    const count = await closing;
    for (const live of [...this.#liveSubscriptions])
      if (live.sessionId === sessionId) live.stop();
    return count;
  }

  async close(): Promise<void> {
    if (this.#closeOperation !== undefined) return await this.#closeOperation;
    this.#backendCloseQueued = true;
    const requestedSessionClosures = [...this.#sessions.keys()].map(
      (sessionId) => this.closeSession(sessionId),
    );
    const closing = (async () => {
      const sessionClosures = await Promise.allSettled(
        requestedSessionClosures,
      );
      this.#closing = true;
      for (const live of [...this.#liveSubscriptions]) live.stop();
      await this.#liveQueue;
      let closeFailure: unknown;
      try {
        await this.#client.close();
      } catch (error) {
        closeFailure = error;
      }
      this.#sessions.clear();
      this.#tabs.clear();
      await this.#artifacts.close();
      const operationFailure = sessionClosures.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (
        operationFailure !== undefined &&
        this.#closure.backendTaints.length === 0
      )
        this.#taintBackend(
          "backend-close",
          describeError(operationFailure.reason),
        );
      if (this.#closure.backendTaints.length > 0) {
        throw new Error(
          `User browser backend close outcome is unknown; provider is tainted (${this.#closure.backendTaints.join("; ")})`,
        );
      }
      if (closeFailure !== undefined) throw closeFailure;
    })();
    this.#closeOperation = closing;
    return await closing;
  }

  async #act(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    action: BrowserTargetFingerprint["actions"][number],
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    throwIfAborted(signal);
    const { session, tab } = this.#sessionTab(sessionId, tabId);
    const target = resolveBrowserObservedTarget(
      tab.observation,
      tab.documentVersion,
      observationId,
      targetId,
      action,
    );
    return await this.#mutateObserved(
      sessionId,
      tabId,
      session,
      tab,
      browserActionScript(target, action, text, submit),
      signal,
    );
  }

  async #mutateObserved(
    sessionId: string,
    tabId: string,
    session: UserBrowserSession,
    tab: UserBrowserTabState,
    expression: string,
    signal?: AbortSignal,
    programmable?: "isolated" | "main",
    receiveValue?: (value: unknown) => void,
  ): Promise<BrowserTabSummary> {
    const expectedDocumentIdentity = tab.documentIdentity;
    tab.observation = undefined;
    tab.documentIdentity = undefined;
    let dispatched = false;
    const operation = this.#startOperation(session, tab, async () => {
      let evaluation: { value: unknown; documentIdentity: string };
      try {
        evaluation = await this.#client.evaluateDocument(
          tabId,
          expression,
          this.#attachmentOwner(session),
          expectedDocumentIdentity,
          signal,
          () => (dispatched = true),
          programmable,
        );
      } catch (error) {
        if (error instanceof UserBrowserDocumentChangedBeforeDispatchError)
          throw error;
        if (
          error instanceof UserBrowserMutationOutcomeUnknownError ||
          error instanceof UserBrowserDocumentChangedAfterDispatchError
        ) {
          tab.tainted = describeError(error);
        }
        throw error;
      }
      const response = asRecord(evaluation.value);
      if (response?.ok !== true) {
        throw new ActionRejectedError(String(response?.reason ?? "unknown"));
      }
      receiveValue?.(response.value);
      tab.documentVersion += 1;
      try {
        return await this.#summary(sessionId, tabId);
      } catch (error) {
        tab.tainted = describeError(error);
        throw error;
      }
    });
    try {
      const result = await raceAbort(operation, signal);

      return result;
    } catch (error) {
      if (error instanceof UserBrowserDocumentChangedBeforeDispatchError) {
        throw new Error("User browser document changed; inspect again");
      }
      if (error instanceof ActionRejectedError) {
        throw new Error(
          `User browser target changed or action was rejected (${error.message}); inspect again`,
        );
      }
      if (
        error instanceof UserBrowserMutationOutcomeUnknownError ||
        error instanceof UserBrowserDocumentChangedAfterDispatchError ||
        (dispatched && signal?.aborted === true)
      ) {
        tab.tainted ??= describeError(error);
        throw new Error(
          `User browser action outcome is unknown after cancellation or connection failure; inspect the current tab before another action (${describeError(error)})`,
        );
      }
      throw error;
    }
  }

  #startOperation<T>(
    session: UserBrowserSession,
    tab: UserBrowserTabState,
    run: () => Promise<T>,
  ): Promise<T> {
    if (tab.tainted !== undefined) {
      throw new Error(`User browser tab is tainted (${tab.tainted})`);
    }
    const targetId = [...session.targetIds].find(
      (candidate) => this.#tabs.get(candidate) === tab,
    );
    if (targetId === undefined) throw new Error("User browser tab was closed");
    const outward = promiseCapability<T>();
    // A queued operation can be fail-closed by a later detach before its
    // caller reaches the assertion. Keep that expected rejection observed
    // without changing the promise delivered to the caller.
    void outward.promise.catch(() => undefined);
    let operationStarted = false;
    const retained = this.#startSessionOperation(session, async () => {
      operationStarted = true;
      try {
        this.#assertTabCurrent(session, targetId, tab);
        const value = await run();
        outward.resolve(value);
        return value;
      } catch (error) {
        outward.reject(error);
        if (
          error instanceof UserBrowserMutationOutcomeUnknownError &&
          error.settlement !== undefined
        ) {
          await error.settlement;
        }
        throw error;
      }
    });
    void retained.catch((error: unknown) => {
      if (!operationStarted) outward.reject(error);
    });
    const settled = retained.then(
      () => undefined,
      () => undefined,
    );
    tab.operation = settled;
    void settled.then(() => {
      if (tab.operation === settled) tab.operation = undefined;
    });
    return outward.promise;
  }

  #startSessionOperation<T>(
    session: UserBrowserSession,
    run: () => Promise<T>,
    allowTainted = false,
  ): Promise<T> {
    return this.#closure.enqueue(
      session,
      () => {
        this.#assertSessionCurrent(session);
        if (!allowTainted) {
          this.#transferClientClosureProblem(session, [...session.targetIds]);
          this.#closure.throwIfSessionTainted(session, "operation");
        }
      },
      run,
    );
  }

  #assertSessionCurrent(session: UserBrowserSession): void {
    if (
      this.#closing ||
      session.detaching ||
      this.#sessions.get(session.id) !== session
    ) {
      throw new Error("User browser session is detaching");
    }
  }

  #assertSessionIdle(session: UserBrowserSession): void {
    for (const targetId of session.targetIds) {
      const tab = this.#tabs.get(targetId);
      if (tab?.detaching === true)
        throw new Error("User browser tab is detaching");
      if (tab?.tainted !== undefined)
        throw new Error(`User browser tab is tainted (${tab.tainted})`);
      if (tab?.operation !== undefined) {
        throw new Error("User browser tab operation is already in flight");
      }
    }
  }

  #session(sessionId: string): UserBrowserSession {
    if (this.#closing) throw new Error("User browser backend is closing");
    this.#closure.throwIfBackendOwnerTainted(sessionId, "operation");
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      if (this.#backendCloseQueued) {
        throw new Error("User browser backend is closing");
      }
      if (this.#sessions.size >= USER_BROWSER_MAX_ACTIVE_SESSIONS) {
        throw new Error(
          "User browser active session capacity exceeded its bound",
        );
      }
      session = {
        id: sessionId,
        incarnation: this.#nextSessionIncarnation++,
        targetIds: new Set(),
        createdTargetIds: new Set(),
        uncertainTargetIds: new Set(),
        ignoredTargetIds: new Set(),
        operationTail: Promise.resolve(),
        unresolvedCreates: new Map(),
        detachFailures: [],
        taints: [],
        closeQueued: false,
        detaching: false,
      };
      this.#sessions.set(sessionId, session);
    }
    if (session.detaching) throw new Error("User browser session is detaching");
    return session;
  }

  #requireSession(sessionId: string): UserBrowserSession {
    if (this.#closing) throw new Error("User browser backend is closing");
    this.#closure.throwIfBackendOwnerTainted(sessionId, "close");
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown user browser session: ${sessionId}`);
    }
    if (session.detaching) throw new Error("User browser session is detaching");
    return session;
  }

  #sessionTab(
    sessionId: string,
    tabId: string,
  ): { session: UserBrowserSession; tab: UserBrowserTabState } {
    const session = this.#requireSession(sessionId);
    this.#transferClientClosureProblem(session, [...session.targetIds]);
    this.#throwIfSessionTainted(session, "operation");
    if (!session.targetIds.has(tabId)) {
      throw new Error(`Unknown user browser tab: ${tabId}`);
    }
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error("User browser tab was closed");
    this.#assertTabOwner(session, tabId, tab);
    if (tab.tainted !== undefined) {
      throw new Error(`User browser tab is tainted (${tab.tainted})`);
    }
    return { session, tab };
  }

  async #summary(
    sessionId: string,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    const target = (await this.#client.listTargets(signal)).find(
      (candidate) =>
        candidate.targetId === targetId && candidate.type === "page",
    );
    if (target === undefined) throw new Error("User browser tab was closed");
    return summarizeTarget(sessionId, target);
  }

  #accountTarget(
    session: UserBrowserSession,
    targetId: string,
    url: string,
    tainted: boolean,
  ): void {
    const existing = this.#tabs.get(targetId);
    if (
      existing !== undefined &&
      !this.#tabBelongsToSession(existing, session)
    ) {
      this.#taintSession(session, `target ${targetId}: ownership changed`);
      throw new Error("User browser target belongs to another logical session");
    }
    if (
      !session.targetIds.has(targetId) &&
      session.targetIds.size >= USER_BROWSER_MAX_TARGET_EVIDENCE
    ) {
      this.#taintSession(session, "target ownership exceeded its bound");
      throw new Error("User browser target ownership exceeded its bound");
    }
    session.targetIds.add(targetId);
    this.#tabs.set(targetId, {
      ownerSessionId: session.id,
      ownerSessionIncarnation: session.incarnation,
      documentVersion: 1,
      url,
      detaching: session.detaching,
      ...(tainted ? { tainted: "create outcome requires cleanup" } : {}),
    });
    if (tainted) {
      this.#taintSession(
        session,
        `target ${targetId}: create outcome requires cleanup`,
      );
    }
  }

  #assertTabCurrent(
    session: UserBrowserSession,
    targetId: string,
    tab: UserBrowserTabState,
    allowTainted = false,
  ): void {
    this.#assertSessionCurrent(session);
    this.#assertTabOwner(session, targetId, tab);
    if (
      !session.targetIds.has(targetId) ||
      this.#tabs.get(targetId) !== tab ||
      tab.detaching
    ) {
      throw new Error("User browser tab is detaching or was closed");
    }
    if (!allowTainted && tab.tainted !== undefined) {
      throw new Error(`User browser tab is tainted (${tab.tainted})`);
    }
  }

  #ignoreTarget(session: UserBrowserSession, targetId: string): void {
    if (session.ignoredTargetIds.has(targetId)) return;
    if (session.ignoredTargetIds.size >= USER_BROWSER_MAX_TARGET_EVIDENCE) {
      this.#taintSession(session, "ignored-target evidence exceeded its bound");
      return;
    }
    session.ignoredTargetIds.add(targetId);
  }

  #recordUnresolvedCreate(
    session: UserBrowserSession,
    markerUrl: string,
    beforeTargetIds: Set<string>,
  ): void {
    if (session.unresolvedCreates.has(markerUrl)) return;
    if (session.unresolvedCreates.size >= USER_BROWSER_MAX_OPERATION_EVIDENCE) {
      this.#taintSession(session, "create-marker evidence exceeded its bound");
      return;
    }
    session.unresolvedCreates.set(markerUrl, beforeTargetIds);
  }

  #recordSessionEvidence(
    session: UserBrowserSession,
    collection: string[],
    detail: string,
    overflowDetail: string,
  ): void {
    this.#closure.recordSessionEvidence(
      session,
      collection,
      detail,
      overflowDetail,
    );
  }

  #taintSession(session: UserBrowserSession, detail: string): void {
    this.#closure.taintSession(session, detail);
  }

  #taintBackend(owner: string, detail: string): void {
    this.#closure.taintBackend(owner, detail);
  }

  #transferClientClosureProblem(
    session: UserBrowserSession,
    targetIds: readonly string[],
  ): void {
    const problem = this.#client.closureProblem(
      targetIds,
      this.#attachmentOwner(session),
    );
    if (problem !== undefined) {
      this.#taintSession(
        session,
        `client closure outcome is unknown (${problem})`,
      );
    }
  }

  #throwIfSessionTainted(session: UserBrowserSession, operation: string): void {
    this.#closure.throwIfSessionTainted(session, operation);
  }

  #detachTarget(session: UserBrowserSession, targetId: string): Promise<void> {
    this.#assertTargetCleanupOwner(session, targetId);
    const existing = this.#detachOperations.get(targetId);
    if (existing !== undefined) return existing;
    const operation = Promise.resolve().then(() =>
      this.#client.detachTarget(targetId, this.#attachmentOwner(session)),
    );
    this.#detachOperations.set(targetId, operation);
    void operation
      .finally(() => {
        if (this.#detachOperations.get(targetId) === operation)
          this.#detachOperations.delete(targetId);
      })
      .catch(() => undefined);
    return operation;
  }

  #attachmentOwner(session: UserBrowserSession): UserBrowserAttachmentOwner {
    return {
      logicalSessionId: session.id,
      logicalSessionIncarnation: session.incarnation,
    };
  }

  #tabBelongsToOrIsUnowned(
    targetId: string,
    session: UserBrowserSession,
  ): boolean {
    const tab = this.#tabs.get(targetId);
    return tab === undefined || this.#tabBelongsToSession(tab, session);
  }

  #tabBelongsToSession(
    tab: UserBrowserTabState,
    session: UserBrowserSession,
  ): boolean {
    return (
      tab.ownerSessionId === session.id &&
      tab.ownerSessionIncarnation === session.incarnation
    );
  }

  #assertTabOwner(
    session: UserBrowserSession,
    targetId: string,
    tab: UserBrowserTabState,
  ): void {
    if (this.#tabBelongsToSession(tab, session)) return;
    this.#taintSession(session, `target ${targetId}: ownership changed`);
    throw new Error("User browser target belongs to another logical session");
  }

  #assertTargetCleanupOwner(
    session: UserBrowserSession,
    targetId: string,
  ): void {
    const tab = this.#tabs.get(targetId);
    if (tab !== undefined) this.#assertTabOwner(session, targetId, tab);
  }

  async #reconcileCreate(
    session: UserBrowserSession,
    markerUrl: string,
    beforeTargetIds: Set<string>,
    signal?: AbortSignal,
  ): Promise<UserBrowserCdpTarget | undefined> {
    const matches = await this.#client
      .findTargetsByUrl(markerUrl, signal)
      .catch((error) => {
        if (signal?.aborted === true) throw error;
        return [];
      });
    const candidates = matches.filter(
      (target) => !beforeTargetIds.has(target.targetId),
    );
    if (
      candidates.length !== 1 ||
      candidates[0]?.type !== "page" ||
      !this.#tabBelongsToOrIsUnowned(candidates[0]?.targetId ?? "", session)
    ) {
      this.#taintSession(session, "create marker reconciliation is ambiguous");
      return undefined;
    }
    const recovered = candidates[0];
    if (recovered === undefined) return undefined;
    session.unresolvedCreates.delete(markerUrl);
    if (!session.targetIds.has(recovered.targetId)) {
      this.#accountTarget(session, recovered.targetId, recovered.url, true);
    }
    return recovered;
  }

  async #reconcileUnresolvedCreates(
    session: UserBrowserSession,
  ): Promise<void> {
    for (const [markerUrl, beforeTargetIds] of session.unresolvedCreates) {
      await this.#reconcileCreate(session, markerUrl, beforeTargetIds);
    }
  }

  async #compensateCancelledCreate(
    session: UserBrowserSession,
    targetId: string,
    tab: UserBrowserTabState,
  ): Promise<void> {
    tab.detaching = true;
    try {
      await this.#detachTarget(session, targetId);
    } catch (error) {
      tab.tainted = `cancelled create cleanup is unknown (${describeError(error)})`;
      this.#taintSession(session, `target ${targetId}: ${tab.tainted}`);
      return;
    }
    session.targetIds.delete(targetId);
    this.#ignoreTarget(session, targetId);
    if (this.#tabs.get(targetId) === tab) this.#tabs.delete(targetId);
  }
}

export interface UserBrowserConnection {
  backend: ZenXBrowserBackend;
  product: string;
}

export async function connectUserBrowserCdp(
  endpoint: string,
  signal?: AbortSignal,
  options: {
    authorization?: string;
    /** Host-selected bridge instance route, never accepted from tool arguments. */
    connectionPath?: string;
    /** Synchronous passive observer; only disposable fixtures inject it. */
    cdpDiagnosticObserver?: UserBrowserCdpDiagnosticObserver;
    liveFrameImageDecoder?: UserBrowserLiveImageDecoder;
    onInputCaptureDiagnostic?: (
      value: UserBrowserInputCaptureDiagnostic,
    ) => void;
  } = {},
): Promise<UserBrowserConnection> {
  const base = validateCdpEndpoint(endpoint);
  const connectionPath = options.connectionPath ?? "";
  if (
    connectionPath !== "" &&
    !/^\/instances\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/u.test(connectionPath)
  )
    throw new Error("Invalid Host browser instance route");
  const scopedBase = new URL(`${connectionPath}/`, base);
  const timeout = AbortSignal.timeout(5_000);
  const probeSignal =
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetch(new URL("json/version", scopedBase), {
    signal: probeSignal,
    headers: {
      accept: "application/json",
      ...(options.authorization === undefined
        ? {}
        : { authorization: options.authorization }),
    },
    redirect: "error",
  });
  const finalUrl = validateCdpEndpoint(response.url);
  if (finalUrl.pathname !== `${connectionPath}/json/version`) {
    throw new Error("User browser CDP version response URL is invalid");
  }
  if (!response.ok) {
    throw new Error(
      `User browser CDP version probe failed with HTTP ${String(response.status)}`,
    );
  }
  const version = asRecord(await response.json());
  if (version === undefined) {
    throw new Error("User browser CDP version response is invalid");
  }
  const product = validateUserBrowserVersion(version);
  const webSocketDebuggerUrl = version.webSocketDebuggerUrl;
  if (typeof webSocketDebuggerUrl !== "string") {
    throw new Error(
      "User browser CDP version response is missing webSocketDebuggerUrl",
    );
  }
  const socketUrl = new URL(webSocketDebuggerUrl);
  if (
    socketUrl.protocol !== "ws:" ||
    !isLoopbackHostname(socketUrl.hostname) ||
    socketUrl.hostname !== base.hostname ||
    effectivePort(socketUrl) !== effectivePort(base) ||
    !socketUrl.pathname.startsWith(`${connectionPath}/devtools/browser/`) ||
    !/^\/devtools\/browser\/[^/]+$/u.test(
      socketUrl.pathname.slice(connectionPath.length),
    ) ||
    socketUrl.username.length > 0 ||
    socketUrl.password.length > 0 ||
    socketUrl.search.length > 0 ||
    socketUrl.hash.length > 0
  ) {
    throw new Error(
      "User browser CDP WebSocket must use the same loopback authority as the HTTP endpoint",
    );
  }
  const client = await JsonRpcUserBrowserCdpClient.connect(
    socketUrl.toString(),
    scopedBase,
    probeSignal,
    options,
  );
  return {
    backend: new UserBrowserCdpBackend(client, {
      onInputCaptureDiagnostic: options.onInputCaptureDiagnostic,
    }),
    product,
  };
}

export function validateUserBrowserVersion(
  value: Record<string, unknown>,
): string {
  const product = value.Browser;
  const match =
    typeof product === "string"
      ? /^(?:Chrome|Chromium|Edg)\/(\d+)(?:\.\d+){1,3}(?:[-+].*)?$/u.exec(
          product,
        )
      : null;
  if (
    typeof product !== "string" ||
    match === null ||
    Number.parseInt(match[1] ?? "0", 10) < 100
  ) {
    throw new Error(
      "User browser CDP endpoint must report a supported Chrome, Edge, or Chromium product",
    );
  }
  return product;
}

class JsonRpcUserBrowserCdpClient implements UserBrowserCdpClient {
  readonly #mainWorldContexts = new Map<
    string,
    Map<number, { frameId: string; id: number; uniqueId?: string }>
  >();
  // Attachment-local evidence of contexts predating a cross-document navigation.
  // A replacement observed between start and commit must not be erased by commit.
  readonly #mainWorldNavigations = new Map<string, Map<string, Set<string>>>();
  readonly #eventBuffers = new Map<
    string,
    { network?: BrowserEventBuffer; console?: BrowserEventBuffer }
  >();
  async extensionEvents(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    operation: BrowserExtensionOperation,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const fence = await this.#executionDocument(targetId, owner, signal);
    this.#assertDocumentFence(fence, true);
    let buffers = this.#eventBuffers.get(fence.sessionId);
    if (!buffers) {
      buffers = {};
      this.#eventBuffers.set(fence.sessionId, buffers);
    }
    const kind = operation.startsWith("network_") ? "network" : "console";
    if (operation.endsWith("_start")) {
      if (buffers[kind]) return { started: true, alreadyStarted: true };
      const buffer = new BrowserEventBuffer();
      buffers[kind] = buffer;
      try {
        if (kind === "network")
          await this.#send(
            "Network.enable",
            { maxTotalBufferSize: 8388608, maxResourceBufferSize: 2097152 },
            fence.sessionId,
            signal,
            undefined,
            undefined,
            undefined,
            () => this.#assertDocumentFence(fence, true),
          );
        this.#assertDocumentFence(fence, true);
      } catch (error) {
        delete buffers[kind];
        await buffer.close();
        throw error;
      }
      return {
        started: true,
        history: "Only events received after this explicit start are retained.",
      };
    }
    const buffer = buffers[kind];
    if (!buffer)
      throw Error(
        `Browser ${kind} history unavailable; start collection explicitly (old history cannot be recovered)`,
      );
    if (operation === "network_response") {
      if (
        typeof args.requestId !== "string" ||
        !buffer.hasRequest(args.requestId)
      )
        throw Error(
          "Response request was not observed in this exact attachment's retained history",
        );
      const result = await this.#send(
        "Network.getResponseBody",
        { requestId: args.requestId },
        fence.sessionId,
        signal,
        undefined,
        undefined,
        undefined,
        () => this.#assertDocumentFence(fence, true),
      );
      this.#assertDocumentFence(fence, true);
      return result;
    }
    if (!operation.endsWith("_read"))
      throw Error("Unsupported Browser event operation");
    const result = await buffer.read(
      typeof args.eventCursor === "string" ? args.eventCursor : undefined,
      typeof args.limit === "number" ? args.limit : undefined,
    );
    this.#assertDocumentFence(fence, true);
    return result;
  }

  readonly #socket: WebSocket;
  readonly #diagnostics?: CdpDiagnosticConnection;
  readonly #httpBase: URL;
  readonly #authorization?: string;
  readonly #liveFrameImageDecoder?: UserBrowserLiveImageDecoder;
  readonly #pending = new Map<
    number,
    {
      method: string;
      sessionId?: string;
      dispatched: boolean;
      resolve(value: unknown): void;
      reject(error: Error, receivedResponse?: Record<string, unknown>): void;
    }
  >();
  readonly #targetSessions = new Map<string, string>();
  readonly #sessionTargets = new Map<string, string>();
  readonly #targetAttachments = new Map<
    string,
    {
      promise: Promise<string>;
      epoch: UserBrowserAttachmentEpoch;
      invalidated: boolean;
      pendingDetachSessionIds: Set<string>;
    }
  >();
  readonly #attachmentClosures = new Map<string, UserBrowserAttachmentEpoch>();
  readonly #sessionEpochs = new Map<string, UserBrowserAttachmentEpoch>();
  readonly #retiredSessionIds = new Set<string>();
  readonly #lateResponses = new Map<
    number,
    {
      sessionId?: string;
      receive(message: Record<string, unknown>): Promise<void>;
      expire(): void;
      expires: NodeJS.Timeout;
    }
  >();
  readonly #connectionTaints: string[] = [];
  readonly #targetMetadata = new Map<string, UserBrowserCdpTarget>();
  readonly #targetMetadataListeners = new Map<
    string,
    Set<(target: UserBrowserCdpTarget) => void>
  >();
  readonly #targetDocuments = new Map<
    string,
    {
      revision: number;
      frameId: string;
      loaderId: string;
      url: string;
      alive: boolean;
      pendingFrameInvalidations: Set<string>;
      invalidExecutionContextIds: Set<number>;
      pendingIsolatedContexts: Map<number, string>;
      isolatedExecutionContextId?: number;
    }
  >();
  #nextId = 1;
  #nextAttachAttempt = 1;
  #providerRevision = 0;
  #closed = false;
  #closing = false;
  #screencast?: UserBrowserScreencastState;
  #screencastSubscription?: UserBrowserScreencastSubscription;

  private constructor(
    socket: WebSocket,
    httpBase: URL,
    authorization?: string,
    liveFrameImageDecoder?: UserBrowserLiveImageDecoder,
    cdpDiagnosticObserver?: UserBrowserCdpDiagnosticObserver,
  ) {
    this.#socket = socket;
    this.#diagnostics = cdpDiagnosticObserver?.connect();
    this.#httpBase = httpBase;
    this.#authorization = authorization;
    this.#liveFrameImageDecoder = liveFrameImageDecoder;
    socket.on("message", (data) => this.#receive(data.toString()));
    socket.on("close", () => {
      this.#diagnostics?.event("socket-close");
      this.#failAll(new Error("User browser CDP connection closed"));
    });
    socket.on("error", (error) => {
      this.#diagnostics?.event("socket-error");
      this.#failAll(error);
    });
  }

  static async connect(
    url: string,
    httpBase: URL,
    signal?: AbortSignal,
    options: {
      authorization?: string;
      cdpDiagnosticObserver?: UserBrowserCdpDiagnosticObserver;
      liveFrameImageDecoder?: UserBrowserLiveImageDecoder;
    } = {},
  ): Promise<JsonRpcUserBrowserCdpClient> {
    const socket = new WebSocket(url, {
      handshakeTimeout: 5_000,
      ...(options.authorization === undefined
        ? {}
        : { headers: { authorization: options.authorization } }),
    });
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        socket.close();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("User browser CDP connection aborted"),
        );
      };
      socket.once("open", () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      socket.once("error", (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
    });
    const client = new JsonRpcUserBrowserCdpClient(
      socket,
      httpBase,
      options.authorization,
      options.liveFrameImageDecoder,
      options.cdpDiagnosticObserver,
    );
    try {
      await client.#send("Target.setDiscoverTargets", { discover: true });
    } catch (error) {
      client.#closing = true;
      socket.close();
      throw error;
    }
    return client;
  }

  async listTargets(signal?: AbortSignal): Promise<UserBrowserCdpTarget[]> {
    const response = asRecord(
      await this.#send("Target.getTargets", {}, undefined, signal),
    );
    const infos = response?.targetInfos;
    if (!Array.isArray(infos))
      throw new Error("User browser CDP Target.getTargets response is invalid");
    if (infos.length > USER_BROWSER_MAX_DISCOVERED_TARGETS) {
      throw new Error("User browser CDP target list exceeded its bound");
    }
    const targets = infos.map((value) => {
      const target = asRecord(value);
      if (
        target === undefined ||
        typeof target.targetId !== "string" ||
        typeof target.type !== "string" ||
        typeof target.title !== "string" ||
        typeof target.url !== "string"
      ) {
        throw new Error("User browser CDP target metadata is invalid");
      }
      return {
        targetId: target.targetId,
        type: target.type,
        title: target.title,
        url: target.url,
      };
    });
    for (const target of targets)
      this.#targetMetadata.set(target.targetId, target);
    return targets;
  }

  observeTargetMetadata(
    targetId: string,
    listener: (target: UserBrowserCdpTarget) => void,
  ): () => void {
    let listeners = this.#targetMetadataListeners.get(targetId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#targetMetadataListeners.set(targetId, listeners);
    }
    listeners.add(listener);
    const current = this.#targetMetadata.get(targetId);
    if (current !== undefined) listener(current);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.#targetMetadataListeners.delete(targetId);
    };
  }

  async createTarget(
    url: string,
    signal?: AbortSignal,
    groupSessionId?: string,
  ): Promise<UserBrowserTargetCreation> {
    const response = asRecord(
      await this.#send(
        "Target.createTarget",
        {
          url,
          background: true,
          focus: false,
          ...(groupSessionId ? { zenxSessionId: groupSessionId } : {}),
        },
        undefined,
        signal,
        USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
      ),
    );
    if (typeof response?.targetId !== "string")
      throw new Error("User browser CDP createTarget response is invalid");
    return {
      targetId: response.targetId,
      grouping: readUserBrowserGrouping(response.grouping),
    };
  }

  async findTargetsByUrl(
    url: string,
    signal?: AbortSignal,
  ): Promise<UserBrowserCdpTarget[]> {
    const timeout = AbortSignal.timeout(5_000);
    const requestSignal =
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await fetch(new URL("json/list", this.#httpBase), {
      signal: requestSignal,
      headers: {
        accept: "application/json",
        ...(this.#authorization === undefined
          ? {}
          : { authorization: this.#authorization }),
      },
      redirect: "error",
    });
    const finalUrl = validateCdpEndpoint(response.url);
    if (
      finalUrl.pathname !== new URL("json/list", this.#httpBase).pathname ||
      !response.ok
    ) {
      throw new Error("User browser CDP target reconciliation failed");
    }
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw new Error(
        "User browser CDP target reconciliation response is invalid",
      );
    }
    if (value.length > USER_BROWSER_MAX_DISCOVERED_TARGETS) {
      throw new Error(
        "User browser CDP target reconciliation exceeded its bound",
      );
    }
    const matches: UserBrowserCdpTarget[] = [];
    for (const item of value) {
      const target = asRecord(item);
      const targetId = target?.id ?? target?.targetId;
      if (
        typeof targetId === "string" &&
        typeof target?.type === "string" &&
        typeof target?.url === "string" &&
        target.url === url
      ) {
        matches.push({
          targetId,
          type: target.type,
          title: typeof target.title === "string" ? target.title : "",
          url: target.url,
        });
      }
    }
    return matches;
  }

  async navigate(
    targetId: string,
    url: string,
    owner: UserBrowserAttachmentOwner,
    signal?: AbortSignal,
    onDispatched?: () => void,
  ): Promise<void> {
    const sessionId = await this.#attach(targetId, owner, signal);
    try {
      await this.#send(
        "Page.navigate",
        { url },
        sessionId,
        signal,
        USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
        undefined,
        onDispatched,
      );
      this.#assertAttachmentClosedForOperation(
        targetId,
        owner,
        "Page.navigate",
      );
    } catch (error) {
      if (error instanceof UserBrowserCdpOutcomeUnknownError) {
        throw new UserBrowserMutationOutcomeUnknownError(
          "Page.navigate",
          describeError(error),
        );
      }
      throw error;
    }
  }

  async evaluateDocument(
    targetId: string,
    expression: string,
    owner: UserBrowserAttachmentOwner,
    expectedDocumentIdentity?: string,
    signal?: AbortSignal,
    onDispatched?: () => void,
    programmable?: "isolated" | "main",
  ): Promise<{ value: unknown; documentIdentity: string }> {
    throwIfAborted(signal);
    const before = await this.#executionDocument(
      targetId,
      owner,
      signal,
      expression === browserInspectScript,
    );
    const inspectDeadline = before.inspectDeadline;
    if (
      expectedDocumentIdentity !== undefined &&
      before.identity !== expectedDocumentIdentity
    ) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
    let evaluationContextId = before.executionContextId;
    let uniqueContextId: string | undefined;
    let assertMainContext: (() => void) | undefined;
    if (programmable === "main") {
      const candidates = [
        ...(this.#mainWorldContexts.get(before.sessionId)?.values() ?? []),
      ].filter((value) => value.frameId === before.frameId);
      if (candidates.length !== 1)
        throw Error(
          "Browser main-world execution context unavailable; no unpinned fallback is permitted",
        );
      const context = candidates[0]!;
      if (!context.uniqueId)
        throw Error(
          "Browser main-world unique context identity unsupported; no fallback is permitted",
        );
      evaluationContextId = context.id;
      uniqueContextId = context.uniqueId;
      assertMainContext = () => {
        if (
          this.#mainWorldContexts.get(before.sessionId)?.get(context.id) !==
          context
        )
          throw new UserBrowserDocumentChangedBeforeDispatchError();
      };
      this.#assertDocumentFence(before, true);
    } else if (programmable) {
      const world = asRecord(
        await this.#send(
          "Page.createIsolatedWorld",
          {
            frameId: before.frameId,
            worldName: "zenx-browser-programmable-v1",
            grantUniveralAccess: false,
          },
          before.sessionId,
          signal,
          undefined,
          undefined,
          undefined,
          () => this.#assertDocumentFence(before, true),
        ),
      );
      if (typeof world?.executionContextId !== "number")
        throw Error("Browser programmable execution context unavailable");
      evaluationContextId = world.executionContextId;
    }
    let response: Record<string, unknown> | undefined;
    let mutationResponseKnown = false;
    try {
      response = asRecord(
        await this.#sendDocumentCommand(
          before,
          "Runtime.evaluate",
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
            ...(uniqueContextId
              ? { uniqueContextId }
              : { contextId: evaluationContextId }),
            ...(programmable ? { timeout: 2000 } : {}),
          },
          signal,
          onDispatched,
          assertMainContext,
          inspectDeadline,
        ),
      );
      mutationResponseKnown = true;
      assertMainContext?.();
      if (response?.exceptionDetails !== undefined) {
        throw new Error("User browser CDP evaluation failed");
      }
      const rawValue = asRecord(response?.result)?.value;
      // The post-screenshot input-only probe is optional evidence, just like
      // the nested snapshot in DOM inspection. Only this exact trusted read gets
      // the same downgrade; its normal document/publication fences still run.
      const optionalInputOnly = expression === browserInputSnapshotScript;
      const resolved = includesBrowserInputSnapshot(expression)
        ? await resolveBrowserInputEvidence(
            optionalInputOnly ? { inputSnapshot: rawValue } : rawValue,
            async (method, params) => {
              this.#assertDocumentFence(before, true);
              return await this.#sendDocumentCommand(
                before,
                method,
                {
                  ...params,
                  ...(method === "Runtime.evaluate"
                    ? { contextId: before.executionContextId }
                    : {}),
                },
                signal,
              );
            },
            (objectId) => this.#releaseInputObject(before, objectId),
          )
        : rawValue;
      const value = optionalInputOnly
        ? asRecord(resolved)?.inputSnapshot
        : resolved;
      const confirmation = asRecord(
        await this.#sendDocumentCommand(
          before,
          "Runtime.evaluate",
          {
            expression: "void 0",
            awaitPromise: true,
            returnByValue: true,
            contextId: before.executionContextId,
          },
          signal,
          undefined,
        ),
      );
      if (confirmation?.exceptionDetails !== undefined) {
        throw new Error("User browser CDP post-confirmation failed");
      }
      const after = await this.#executionDocument(targetId, owner, signal);
      if (after.identity !== before.identity) {
        throw new UserBrowserDocumentChangedAfterDispatchError();
      }
      this.#assertAttachmentClosedForOperation(
        targetId,
        owner,
        "Runtime.evaluate",
      );
      return {
        value,
        documentIdentity: after.identity,
      };
    } catch (error) {
      if (error instanceof UserBrowserDocumentChangedAfterDispatchError)
        throw error;
      if (
        error instanceof UserBrowserCdpOutcomeUnknownError ||
        mutationResponseKnown
      ) {
        throw new UserBrowserMutationOutcomeUnknownError(
          "Runtime.evaluate",
          describeError(error),
          error instanceof UserBrowserCdpOutcomeUnknownError
            ? error.settlement
            : undefined,
        );
      }
      throw error;
    }
  }

  async targetedInput(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    expectedDocumentIdentity: string,
    observed: BrowserInputSnapshot,
    action: UserBrowserTargetedInputAction,
    signal?: AbortSignal,
    assertCurrent?: () => void,
    onDispatched?: () => void,
  ): Promise<void> {
    throwIfAborted(signal);
    this.#assertNoNativeDialog(targetId, owner);
    const fence = await this.#executionDocument(targetId, owner, signal);
    if (fence.identity !== expectedDocumentIdentity)
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    const assertFence = () => {
      throwIfAborted(signal);
      assertCurrent?.();
      this.#assertDocumentFence(fence, true);
      this.#assertNoNativeDialog(targetId, owner);
      this.#assertAttachmentClosedForOperation(
        targetId,
        owner,
        "targeted input",
      );
    };
    const probe = browserInputProbeScript(action);
    try {
      await dispatchBrowserTargetedInput(
        {
          assertCurrent: assertFence,
          snapshot: async () => {
            assertFence();
            await this.#documentBarrier(fence, signal);
            assertFence();
            const response = asRecord(
              await this.#sendDocumentCommand(
                fence,
                "Runtime.evaluate",
                {
                  expression: probe,
                  awaitPromise: true,
                  returnByValue: true,
                  contextId: fence.executionContextId,
                },
                signal,
                undefined,
                assertFence,
              ),
            );
            assertFence();
            if (response?.exceptionDetails !== undefined)
              throw new Error("User browser targeted input snapshot failed");
            return requireBrowserInputSnapshot(
              await resolveBrowserInputEvidence(
                asRecord(response?.result)?.value,
                async (method, params) => {
                  assertFence();
                  const result = await this.#sendDocumentCommand(
                    fence,
                    method,
                    {
                      ...params,
                      ...(method === "Runtime.evaluate"
                        ? { contextId: fence.executionContextId }
                        : {}),
                    },
                    signal,
                    undefined,
                    assertFence,
                  );
                  assertFence();
                  return result;
                },
                (objectId) => this.#releaseInputObject(fence, objectId),
              ),
            );
          },
          beforeDispatch: () => onDispatched?.(),
          dispatch: async (method, params, onDispatched) => {
            assertFence();
            return await this.#sendDocumentCommand(
              fence,
              method,
              params,
              signal,
              onDispatched,
              assertFence,
            );
          },
          quarantine: (error) => {
            fence.attachmentEpoch.taint ??= describeError(error);
          },
        },
        observed,
        action,
        signal,
      );
    } catch (error) {
      if (
        error instanceof BrowserInputOutcomeUnknownError &&
        error.inputMayRemainPressed
      ) {
        throw new UserBrowserMutationOutcomeUnknownError(
          "Browser targeted input",
          describeError(error),
          error.cause instanceof UserBrowserCdpOutcomeUnknownError
            ? error.cause.settlement
            : undefined,
        );
      }
      throw error;
    }
  }

  #assertNoNativeDialog(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
  ): void {
    const epoch = this.#attachmentClosures.get(targetId);
    if (
      epoch !== undefined &&
      sameAttachmentOwner(epoch, owner) &&
      epoch.nativeDialogOpen
    )
      throw new Error(
        "Native dialog requires human control; close the browser dialog and inspect again before targeted input",
      );
  }

  async captureScreenshot(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    expectedDocumentIdentity: string,
    signal?: AbortSignal,
  ): Promise<{
    data: string;
    documentIdentity: string;
    status: "captured" | "fallback";
    reason?: string;
  }> {
    const before = await this.#executionDocument(targetId, owner, signal);
    if (before.identity !== expectedDocumentIdentity) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
    let response: Record<string, unknown> | undefined;
    try {
      response = asRecord(
        await this.#send(
          "Page.captureScreenshot",
          { format: "png", fromSurface: true, captureBeyondViewport: false },
          before.sessionId,
          signal,
          USER_BROWSER_SCREENSHOT_TIMEOUT_MS,
          undefined,
          undefined,
          () => this.#assertDocumentFence(before, true),
        ),
      );
    } catch (error) {
      if (!(error instanceof UserBrowserCdpOutcomeUnknownError)) throw error;
      // A read-only capture can have an unknown settlement on hidden browser
      // surfaces. Keep this narrowly scoped fallback explicit and publish it
      // only after rechecking the document fence.
      const afterTimeout = await this.#executionDocument(
        targetId,
        owner,
        signal,
      );
      if (afterTimeout.identity !== before.identity) {
        throw new UserBrowserDocumentChangedAfterDispatchError();
      }
      return {
        data: FALLBACK_SCREENSHOT_PNG_BASE64,
        documentIdentity: afterTimeout.identity,
        status: "fallback",
        reason: "Attached browser screenshot capture outcome was unknown",
      };
    }
    const after = await this.#executionDocument(targetId, owner, signal);
    if (after.identity !== before.identity) {
      throw new UserBrowserDocumentChangedAfterDispatchError();
    }
    if (typeof response?.data !== "string" || response.data.length === 0) {
      return {
        data: FALLBACK_SCREENSHOT_PNG_BASE64,
        documentIdentity: after.identity,
        status: "fallback",
        reason: "Attached browser screenshot response was empty or malformed",
      };
    }
    decodeUserBrowserScreenshot(response.data);
    return {
      data: response.data,
      documentIdentity: after.identity,
      status: "captured",
    };
  }

  async getDocumentIdentity(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.#executionDocument(targetId, owner, signal)).identity;
  }

  assertDocumentCurrent(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    expectedDocumentIdentity: string,
  ): void {
    const epoch = this.#attachmentClosures.get(targetId);
    const state = this.#targetDocuments.get(targetId);
    const sessionId = this.#targetSessions.get(targetId);
    if (
      this.#closing ||
      epoch === undefined ||
      state === undefined ||
      sessionId === undefined ||
      state.frameId.length === 0 ||
      state.isolatedExecutionContextId === undefined ||
      state.pendingFrameInvalidations.size > 0 ||
      [...state.pendingIsolatedContexts].some(
        ([contextId, frameId]) =>
          frameId === state.frameId &&
          contextId !== state.isolatedExecutionContextId,
      )
    ) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
    const fence = {
      targetId,
      sessionId,
      attachmentEpoch: epoch,
      ...owner,
      providerRevision: this.#providerRevision,
      documentRevision: state.revision,
      frameId: state.frameId,
      loaderId: state.loaderId,
      url: state.url,
      executionContextId: state.isolatedExecutionContextId,
    };
    this.#assertDocumentFence(fence, true);
    if (this.#documentFenceIdentity(fence) !== expectedDocumentIdentity) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
  }

  async observeScreencast(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    listener: BrowserLiveObservationListener,
  ): Promise<() => Promise<void>> {
    await this.#stopScreencast();
    const subscription: UserBrowserScreencastSubscription = {
      targetId,
      owner,
      listener,
      active: true,
      restartQueued: false,
    };
    this.#screencastSubscription = subscription;
    try {
      await this.#startScreencast(subscription);
    } catch (error) {
      subscription.active = false;
      if (this.#screencastSubscription === subscription)
        this.#screencastSubscription = undefined;
      throw error;
    }
    return async () => {
      if (!subscription.active) return;
      subscription.active = false;
      if (this.#screencastSubscription === subscription)
        await this.#stopScreencast();
    };
  }

  async #startScreencast(
    subscription: UserBrowserScreencastSubscription,
  ): Promise<void> {
    if (!subscription.active || this.#screencastSubscription !== subscription)
      return;
    const fence = await this.#executionDocument(
      subscription.targetId,
      subscription.owner,
    );
    if (!subscription.active || this.#screencastSubscription !== subscription)
      return;
    const state: UserBrowserScreencastState = {
      targetId: subscription.targetId,
      sessionId: fence.sessionId,
      fence,
      subscription,
      lastPublishedAt: 0,
      nextSequence: 1,
    };
    this.#screencast = state;
    let started = false;
    try {
      await this.#send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: 70,
          maxWidth: 1600,
          maxHeight: 1000,
          everyNthFrame: 1,
        },
        fence.sessionId,
      );
      started = true;
      this.#assertDocumentFence(fence, true);
      if (
        this.#screencast !== state ||
        !subscription.active ||
        this.#screencastSubscription !== subscription
      )
        throw new Error("Browser observation target changed during connection");
      this.#scheduleLiveCapture(state);
    } catch (error) {
      if (this.#screencast === state) this.#clearScreencast(state);
      if (started && this.#canSendObservation(state.sessionId)) {
        await this.#send("Page.stopScreencast", {}, state.sessionId).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  async #stopScreencast(): Promise<void> {
    const subscription = this.#screencastSubscription;
    if (subscription !== undefined) {
      subscription.active = false;
      subscription.restartQueued = false;
      this.#screencastSubscription = undefined;
    }
    const state = this.#screencast;
    if (state === undefined) return;
    this.#clearScreencast(state);
    if (!this.#canSendObservation(state.sessionId)) return;
    await this.#send("Page.stopScreencast", {}, state.sessionId);
  }

  #restartScreencastForDocumentChange(targetId: string): void {
    const subscription = this.#screencastSubscription;
    const state = this.#screencast;
    if (
      subscription === undefined ||
      state === undefined ||
      subscription.targetId !== targetId ||
      subscription.restartQueued ||
      !subscription.active
    )
      return;
    subscription.restartQueued = true;
    this.#clearScreencast(state);
    subscription.listener({
      type: "status",
      status: "connecting",
      message: "The browser page changed. Reconnecting to the same tab…",
    });
    queueMicrotask(() => {
      void (async () => {
        try {
          if (this.#canSendObservation(state.sessionId))
            await this.#send("Page.stopScreencast", {}, state.sessionId);
          if (
            !subscription.active ||
            this.#screencastSubscription !== subscription
          )
            return;
          subscription.restartQueued = false;
          await this.#startScreencast(subscription);
        } catch (error) {
          subscription.restartQueued = false;
          if (
            subscription.active &&
            this.#screencastSubscription === subscription
          ) {
            subscription.listener({
              type: "status",
              status: "failed",
              message:
                "The live browser view could not resume after the page changed.",
              details: localErrorDetail(error),
            });
          }
        }
      })();
    });
  }

  #clearScreencast(state: UserBrowserScreencastState): void {
    if (state.publishTimer !== undefined) clearTimeout(state.publishTimer);
    if (state.captureTimer !== undefined) clearTimeout(state.captureTimer);
    state.publishTimer = undefined;
    state.captureTimer = undefined;
    state.captureDueAt = undefined;
    state.latestFrame = undefined;
    if (this.#screencast === state) this.#screencast = undefined;
  }

  #canSendObservation(sessionId: string): boolean {
    const epoch = this.#sessionEpochs.get(sessionId);
    return (
      !this.#closed &&
      epoch !== undefined &&
      !epoch.observationClosing &&
      this.#targetSessions.get(epoch.targetId) === sessionId &&
      this.#attachmentClosures.get(epoch.targetId) === epoch
    );
  }

  #receiveScreencastFrame(
    message: Record<string, unknown>,
    params: Record<string, unknown>,
  ): void {
    const cdpSessionId = message.sessionId;
    const frameSessionId = params.sessionId;
    if (
      typeof cdpSessionId !== "string" ||
      typeof frameSessionId !== "number" ||
      !Number.isSafeInteger(frameSessionId) ||
      !this.#canSendObservation(cdpSessionId)
    )
      return;
    const state = this.#screencast;
    void this.#send(
      "Page.screencastFrameAck",
      { sessionId: frameSessionId },
      cdpSessionId,
    ).catch((error: unknown) => {
      if (
        state !== undefined &&
        state.sessionId === cdpSessionId &&
        this.#screencast === state
      )
        this.#failScreencast(state, error);
    });
    // CDP events contain no document or screencast generation. A queued event
    // can outlive navigation or resubscription, so acknowledge it without
    // publishing its pixels or accelerating the fixed fenced capture loop.
  }

  #publishScreencastFrame(
    state: UserBrowserScreencastState,
    params: Record<string, unknown>,
  ): void {
    if (this.#screencast !== state) return;
    try {
      this.#assertDocumentFence(state.fence, true);
      const data = params.data;
      const metadata = asRecord(params.metadata);
      const width = metadata?.deviceWidth;
      const height = metadata?.deviceHeight;
      const maxEncodedLength =
        Math.ceil(USER_BROWSER_MAX_LIVE_FRAME_BYTES / 3) * 4 + 4;
      if (
        typeof data !== "string" ||
        data.length === 0 ||
        data.length > maxEncodedLength ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(data) ||
        Buffer.byteLength(data, "base64") > USER_BROWSER_MAX_LIVE_FRAME_BYTES ||
        typeof width !== "number" ||
        !Number.isFinite(width) ||
        width <= 0 ||
        width > USER_BROWSER_MAX_LIVE_FRAME_WIDTH ||
        typeof height !== "number" ||
        !Number.isFinite(height) ||
        height <= 0 ||
        height > USER_BROWSER_MAX_LIVE_FRAME_HEIGHT
      ) {
        throw new Error("Browser screencast frame exceeded its size bound");
      }
      const event: Extract<BrowserLiveObservationEvent, { type: "frame" }> = {
        type: "frame",
        frame: {
          sequence: state.nextSequence++,
          mimeType: "image/jpeg",
          data,
          width,
          height,
        },
      };
      if (state.lastPublishedAt === 0) {
        state.subscription.listener({
          type: "status",
          status: "live",
          message: "Watching the Agent's browser tab live.",
        });
      }
      const elapsed = Date.now() - state.lastPublishedAt;
      if (
        state.lastPublishedAt === 0 ||
        elapsed >= USER_BROWSER_LIVE_FRAME_INTERVAL_MS
      ) {
        state.lastPublishedAt = Date.now();
        state.subscription.listener(event);
        return;
      }
      state.latestFrame = event;
      if (state.publishTimer !== undefined) return;
      state.publishTimer = setTimeout(() => {
        state.publishTimer = undefined;
        const latest = state.latestFrame;
        state.latestFrame = undefined;
        if (latest === undefined || this.#screencast !== state) return;
        state.lastPublishedAt = Date.now();
        state.subscription.listener(latest);
      }, USER_BROWSER_LIVE_FRAME_INTERVAL_MS - elapsed);
      state.publishTimer.unref();
    } catch (error) {
      this.#failScreencast(state, error);
    }
  }

  #scheduleLiveCapture(
    state: UserBrowserScreencastState,
    delay = USER_BROWSER_LIVE_CAPTURE_INTERVAL_MS,
  ): void {
    if (this.#screencast !== state || state.captureInFlight) return;
    const dueAt = Date.now() + delay;
    if (state.captureDueAt !== undefined && state.captureDueAt <= dueAt) return;
    if (state.captureTimer !== undefined) clearTimeout(state.captureTimer);
    state.captureDueAt = dueAt;
    state.captureTimer = setTimeout(() => {
      state.captureTimer = undefined;
      state.captureDueAt = undefined;
      void this.#captureLiveFrame(state);
    }, delay);
    state.captureTimer.unref();
  }

  async #captureLiveFrame(state: UserBrowserScreencastState): Promise<void> {
    if (this.#screencast !== state || state.captureInFlight) return;
    state.captureInFlight = true;
    try {
      // Every displayed image belongs to this request's exact observation state.
      // Native events are acknowledged separately from this fixed single-flight loop.
      this.#assertDocumentFence(state.fence, true);
      const result = asRecord(
        await this.#send(
          "Page.captureScreenshot",
          {
            format: "jpeg",
            quality: 70,
            fromSurface: true,
            captureBeyondViewport: false,
          },
          state.sessionId,
          undefined,
          USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
          undefined,
          undefined,
          () => this.#assertDocumentFence(state.fence, true),
        ),
      );
      if (this.#screencast !== state) return;
      this.#assertDocumentFence(state.fence, true);
      const frame = await processUserBrowserLiveFrame(
        result?.data,
        this.#liveFrameImageDecoder,
      );
      if (this.#screencast !== state) return;
      this.#assertDocumentFence(state.fence, true);
      this.#publishScreencastFrame(state, {
        data: frame.data,
        metadata: {
          deviceWidth: frame.width,
          deviceHeight: frame.height,
        },
      });
    } catch (error) {
      if (this.#screencast === state) this.#failScreencast(state, error);
    } finally {
      state.captureInFlight = false;
      this.#scheduleLiveCapture(state);
    }
  }

  #failScreencast(state: UserBrowserScreencastState, error: unknown): void {
    if (this.#screencast !== state) return;
    this.#clearScreencast(state);
    if (this.#canSendObservation(state.sessionId)) {
      void this.#send("Page.stopScreencast", {}, state.sessionId).catch(() => {
        // The observation is already failed and detached from renderer delivery.
      });
    }
    state.subscription.listener({
      type: "status",
      status: "failed",
      message:
        "The live browser view stopped because a frame or connection was invalid.",
      details: localErrorDetail(error),
    });
  }

  async #releaseInputObject(
    fence: ZenXUserBrowserDocumentExecutionFence,
    objectId: string,
  ): Promise<unknown> {
    // Called only for IDs recorded as owned by resolveBrowserInputEvidence.
    // Cancellation/control takeover must not retain a live renderer reference.
    // The original connection, attachment epoch and context are still mandatory:
    // never attach, choose a successor, send Input, or retry unknown cleanup.
    return await this.#send(
      "Runtime.releaseObject",
      { objectId },
      fence.sessionId,
      undefined,
      USER_BROWSER_INPUT_OBJECT_CLEANUP_TIMEOUT_MS,
      undefined,
      undefined,
      () => this.#assertDocumentFence(fence, true),
    );
  }

  #claimFirstInspectDeadline(
    fence: ZenXUserBrowserDocumentExecutionFence,
    expression: string,
  ): { deadline: number } | undefined {
    if (expression !== browserInspectScript) return undefined;
    const epoch = fence.attachmentEpoch;
    if (epoch.firstInspectClaimed) return undefined;
    epoch.firstInspectClaimed = true;
    this.#assertDocumentFence(fence, false);
    // Setup has already succeeded. Reserve this one observation window before
    // asynchronous document preflight, independently of attachment age/cost.
    // A known-undispatched lifecycle rejection may return its reservation,
    // never renew its deadline or substitute an ordinary budget after expiry.
    const deadline =
      epoch.firstInspectGrantedDeadline ??
      performance.now() + USER_BROWSER_FIRST_INSPECT_TIMEOUT_MS;
    epoch.firstInspectGrantedDeadline = deadline;
    const reservation = { deadline };
    epoch.firstInspectReservation = reservation;
    return reservation;
  }

  async #sendDocumentCommand(
    fence: ZenXUserBrowserDocumentExecutionFence & {
      executionContextId: number;
    },
    method:
      | "Runtime.evaluate"
      | "DOM.describeNode"
      | "Runtime.releaseObject"
      | "Input.dispatchMouseEvent"
      | "Input.dispatchKeyEvent",
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onDispatched?: () => void,
    assertCurrent?: () => void,
    inspectDeadline?: number,
  ): Promise<unknown> {
    const settlement = promiseCapability<void>();
    try {
      const result = await this.#send(
        method,
        params,
        fence.sessionId,
        signal,
        USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
        async () => settlement.resolve(),
        onDispatched,
        () => {
          assertCurrent?.();
          this.#assertDocumentFence(fence, true);
        },
        () => {
          fence.attachmentEpoch.unsettledMutation ??= `${method} late settlement was not observed`;
          settlement.resolve();
        },
        inspectDeadline,
      );
      settlement.resolve();
      // A late callback/continuation cannot turn this absolute deadline green,
      // even if the event loop observes the reply before its overdue timer.
      if (inspectDeadline !== undefined && performance.now() >= inspectDeadline)
        throw new UserBrowserCdpOutcomeUnknownError(
          method,
          "original reserved deadline elapsed",
          settlement.promise,
        );
      return result;
    } catch (error) {
      if (error instanceof UserBrowserCdpOutcomeUnknownError) {
        throw new UserBrowserCdpOutcomeUnknownError(
          method,
          describeError(error),
          settlement.promise,
        );
      }
      settlement.resolve();
      throw error;
    }
  }

  closureProblem(
    targetIds: readonly string[],
    owner: UserBrowserAttachmentOwner,
  ): string | undefined {
    const evidence = [...this.#connectionTaints];
    for (const targetId of targetIds) {
      const epoch = this.#attachmentClosures.get(targetId);
      if (epoch !== undefined && !sameAttachmentOwner(epoch, owner)) continue;
      const problem = this.#attachmentProblem(epoch);
      if (problem !== undefined) evidence.push(`${targetId}: ${problem}`);
    }
    return evidence.length === 0 ? undefined : evidence.join("; ");
  }

  async #executionDocument(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    signal?: AbortSignal,
    firstInspect = false,
  ): Promise<
    ZenXUserBrowserDocumentExecutionFence & {
      identity: string;
      executionContextId: number;
      inspectDeadline?: number;
    }
  > {
    const sessionId = await this.#attach(targetId, owner, signal);
    const epoch = this.#attachmentClosures.get(targetId);
    const initial = this.#targetDocuments.get(targetId);
    if (
      epoch === undefined ||
      initial === undefined ||
      !sameAttachmentOwner(epoch, owner) ||
      epoch.cdpSessionId !== sessionId ||
      initial.alive === false
    ) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
    const fence: ZenXUserBrowserDocumentExecutionFence = {
      targetId,
      sessionId,
      attachmentEpoch: epoch,
      ...owner,
      providerRevision: this.#providerRevision,
      documentRevision: initial.revision,
      frameId: "",
      loaderId: "",
      url: "",
    };
    // Reserve synchronously before asynchronous preflight. Only a known
    // document-change rejection before world dispatch may return this token.
    const reservation = firstInspect
      ? this.#claimFirstInspectDeadline(fence, browserInspectScript)
      : undefined;
    const inspectDeadline = reservation?.deadline;
    let worldDispatched = false;
    const assertInspectDeadline = () => {
      if (inspectDeadline !== undefined && performance.now() >= inspectDeadline)
        throw new Error("Reserved deadline elapsed before dispatch");
    };
    try {
      assertInspectDeadline();
      const response = asRecord(
        await this.#send("Page.getFrameTree", {}, sessionId, signal),
      );
      this.#assertDocumentFence(fence, false);
      assertInspectDeadline();
      const frame = asRecord(asRecord(response?.frameTree)?.frame);
      if (
        frame === undefined ||
        typeof frame.id !== "string" ||
        typeof frame.loaderId !== "string" ||
        typeof frame.url !== "string"
      ) {
        throw new Error("User browser CDP document identity is invalid");
      }
      fence.frameId = frame.id;
      fence.loaderId = frame.loaderId;
      fence.url = frame.url;
      const state = this.#targetDocuments.get(targetId);
      if (state === undefined || state.alive === false)
        throw new UserBrowserDocumentChangedBeforeDispatchError();
      const pendingMainFrameInvalidations = [
        ...state.pendingFrameInvalidations,
      ].filter((event) => event.endsWith(`\u0000${frame.id}`));
      if (pendingMainFrameInvalidations.length > 0) {
        state.pendingFrameInvalidations.clear();
        this.#invalidateTarget(targetId, false);
        throw new UserBrowserDocumentChangedBeforeDispatchError(
          `pending lifecycle ${pendingMainFrameInvalidations
            .map((event) => event.slice(0, event.indexOf("\u0000")))
            .join(", ")}`,
        );
      }
      state.pendingFrameInvalidations.clear();
      this.#targetDocuments.set(targetId, {
        revision: state.revision,
        frameId: frame.id,
        loaderId: frame.loaderId,
        url: frame.url,
        alive: true,
        pendingFrameInvalidations: state.pendingFrameInvalidations,
        invalidExecutionContextIds: state.invalidExecutionContextIds,
        pendingIsolatedContexts: state.pendingIsolatedContexts,
        isolatedExecutionContextId: state.isolatedExecutionContextId,
      });
      assertInspectDeadline();
      await this.#documentBarrier(fence, signal);
      this.#assertDocumentFence(fence, false);
      assertInspectDeadline();
      const world = asRecord(
        await this.#send(
          "Page.createIsolatedWorld",
          {
            frameId: frame.id,
            worldName: USER_BROWSER_DOCUMENT_WORLD_NAME,
            grantUniveralAccess: false,
          },
          sessionId,
          signal,
          USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
          undefined,
          reservation === undefined
            ? undefined
            : () => {
                worldDispatched = true;
                if (epoch.firstInspectReservation === reservation)
                  delete epoch.firstInspectReservation;
              },
          inspectDeadline === undefined
            ? undefined
            : () => this.#assertDocumentFence(fence, false),
          undefined,
          inspectDeadline,
        ),
      );
      // A successful reply must not beat an overdue absolute timer. Unlike an
      // expired preflight, this world command has already been dispatched.
      if (inspectDeadline !== undefined && performance.now() >= inspectDeadline)
        throw new UserBrowserCdpOutcomeUnknownError(
          "Page.createIsolatedWorld",
          "original reserved deadline elapsed",
        );
      this.#assertDocumentFence(fence, false);
      if (typeof world?.executionContextId !== "number") {
        throw new Error("User browser CDP execution context is invalid");
      }
      fence.executionContextId = world.executionContextId;
      const contextState = this.#targetDocuments.get(targetId);
      if (contextState === undefined || contextState.alive === false) {
        throw new UserBrowserDocumentChangedBeforeDispatchError();
      }
      const replacement = [...contextState.pendingIsolatedContexts].some(
        ([contextId, frameId]) =>
          frameId === fence.frameId && contextId !== world.executionContextId,
      );
      contextState.pendingIsolatedContexts.clear();
      contextState.isolatedExecutionContextId = world.executionContextId;
      if (
        replacement ||
        contextState.invalidExecutionContextIds.has(world.executionContextId)
      ) {
        this.#invalidateTarget(targetId, false);
        throw new UserBrowserDocumentChangedBeforeDispatchError(
          "isolated execution context invalidated",
        );
      }
      contextState.invalidExecutionContextIds.clear();
      await this.#documentBarrier(fence, signal);
      const settledContextState = this.#targetDocuments.get(targetId);
      if (
        settledContextState !== undefined &&
        settledContextState.revision === fence.documentRevision
      ) {
        const settledReplacement = [
          ...settledContextState.pendingIsolatedContexts,
        ].some(
          ([contextId, frameId]) =>
            frameId === fence.frameId && contextId !== world.executionContextId,
        );
        if (
          settledReplacement ||
          settledContextState.invalidExecutionContextIds.has(
            world.executionContextId,
          )
        ) {
          this.#invalidateTarget(targetId, false);
          throw new UserBrowserDocumentChangedBeforeDispatchError(
            "isolated execution context invalidated",
          );
        }
        settledContextState.pendingIsolatedContexts.clear();
        settledContextState.invalidExecutionContextIds.clear();
      }
      this.#assertDocumentFence(fence, true);
      assertInspectDeadline();
      return {
        inspectDeadline,
        identity: this.#documentFenceIdentity({
          ...fence,
          executionContextId: world.executionContextId,
        }),
        ...fence,
        executionContextId: world.executionContextId,
      };
    } catch (error) {
      // Only the local token holder can return the still-undispatched grant.
      // This is a synchronous release on exit, not a retry or a late callback.
      if (
        reservation !== undefined &&
        epoch.firstInspectReservation === reservation
      ) {
        const canReturn =
          error instanceof UserBrowserDocumentChangedBeforeDispatchError &&
          !worldDispatched &&
          signal?.aborted !== true &&
          !this.#closed &&
          this.#providerRevision === fence.providerRevision &&
          this.#attachmentClosures.get(targetId) === epoch &&
          sameAttachmentOwner(epoch, fence) &&
          epoch.cdpSessionId === sessionId &&
          this.#targetSessions.get(targetId) === sessionId &&
          this.#sessionEpochs.get(sessionId) === epoch &&
          this.#targetDocuments.get(targetId)?.alive === true;
        delete epoch.firstInspectReservation;
        if (canReturn) epoch.firstInspectClaimed = false;
      }
      throw error;
    }
  }

  #documentFenceIdentity(
    fence: ZenXUserBrowserDocumentExecutionFence & {
      executionContextId: number;
    },
  ): string {
    return JSON.stringify({
      targetId: fence.targetId,
      sessionId: fence.sessionId,
      attachAttempt: fence.attachmentEpoch.attachAttempt,
      logicalSessionId: fence.logicalSessionId,
      logicalSessionIncarnation: fence.logicalSessionIncarnation,
      providerRevision: fence.providerRevision,
      revision: fence.documentRevision,
      frameId: fence.frameId,
      loaderId: fence.loaderId,
      url: fence.url,
      executionContextId: fence.executionContextId,
    });
  }

  async #documentBarrier(
    fence: ZenXUserBrowserDocumentExecutionFence,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = asRecord(
      await this.#send("Page.getFrameTree", {}, fence.sessionId, signal),
    );
    this.#assertDocumentFence(fence, false);
    const frame = asRecord(asRecord(response?.frameTree)?.frame);
    if (
      frame === undefined ||
      frame.id !== fence.frameId ||
      frame.loaderId !== fence.loaderId ||
      frame.url !== fence.url
    ) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
  }

  #assertDocumentFence(
    fence: ZenXUserBrowserDocumentExecutionFence,
    requireContext: boolean,
  ): void {
    const epoch = this.#attachmentClosures.get(fence.targetId);
    const state = this.#targetDocuments.get(fence.targetId);
    if (
      this.#closed ||
      this.#providerRevision !== fence.providerRevision ||
      epoch !== fence.attachmentEpoch ||
      epoch === undefined ||
      !sameAttachmentOwner(epoch, fence) ||
      epoch.cdpSessionId !== fence.sessionId ||
      this.#targetSessions.get(fence.targetId) !== fence.sessionId ||
      this.#sessionEpochs.get(fence.sessionId) !== epoch ||
      state === undefined ||
      state.alive === false ||
      state.revision !== fence.documentRevision ||
      (fence.frameId.length > 0 &&
        state.frameId.length > 0 &&
        state.frameId !== fence.frameId) ||
      (fence.loaderId.length > 0 &&
        state.loaderId.length > 0 &&
        state.loaderId !== fence.loaderId) ||
      (fence.url.length > 0 &&
        state.url.length > 0 &&
        state.url !== fence.url) ||
      (requireContext &&
        (fence.executionContextId === undefined ||
          state.isolatedExecutionContextId !== fence.executionContextId ||
          state.invalidExecutionContextIds.has(fence.executionContextId)))
    ) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
  }

  async closeCreatedTarget(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
  ): Promise<void> {
    const attached = this.#targetAttachments.get(targetId);
    if (attached && !sameAttachmentOwner(attached.epoch, owner))
      throw new Error("User browser attachment ownership changed");
    const result = asRecord(
      await this.#send("Target.closeTarget", { targetId }),
    );
    if (result?.success !== true)
      throw new Error("Browser did not confirm temporary page closure");
  }

  async detachTarget(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
  ): Promise<void> {
    const attaching = this.#targetAttachments.get(targetId);
    if (attaching !== undefined) {
      if (!sameAttachmentOwner(attaching.epoch, owner)) {
        throw new Error("User browser attachment ownership changed");
      }
      try {
        await attaching.promise;
      } catch {
        // The terminal closure below, not the rejected attach promise, decides
        // whether known ownership can be retried or uncertainty must surface.
      }
    }
    const closure = this.#attachmentClosures.get(targetId);
    if (closure !== undefined && !sameAttachmentOwner(closure, owner)) {
      throw new Error("User browser attachment ownership changed");
    }
    if (closure?.unknownEvidence.attach !== undefined) {
      throw new UserBrowserCdpOutcomeUnknownError(
        "Target.attachToTarget",
        closure.unknownEvidence.attach,
      );
    }
    if (closure?.unsettledMutation !== undefined) {
      throw new UserBrowserCdpOutcomeUnknownError(
        "Target.detachFromTarget",
        closure.unsettledMutation,
      );
    }
    const sessionId = this.#targetSessions.get(targetId);
    if (sessionId === undefined) {
      const problem = this.#attachmentProblem(closure);
      if (problem !== undefined) {
        throw new UserBrowserCdpOutcomeUnknownError(
          "Target.detachFromTarget",
          problem,
        );
      }
      this.#reapTarget(targetId, true);
      return;
    }
    if (closure !== undefined) closure.observationClosing = true;
    if (this.#screencastSubscription?.targetId === targetId) {
      this.#endScreencast(
        "unavailable",
        "The observed browser tab is no longer attached.",
      );
    }
    try {
      await this.#send(
        "Target.detachFromTarget",
        { sessionId },
        undefined,
        undefined,
        USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
      );
      if (closure !== undefined) {
        closure.detach = "known-success";
        closure.taint = undefined;
      }
    } catch (error) {
      if (closure !== undefined) {
        if (error instanceof UserBrowserCdpOutcomeUnknownError) {
          closure.detach = "outcome-unknown";
          closure.unknownEvidence.detach ??= describeError(error);
        } else {
          closure.detach = "known-failure";
          closure.taint = describeError(error);
        }
      }
      throw error;
    }
    this.#reapEpoch(closure, true);
    const problem = this.#attachmentProblem(closure);
    if (problem !== undefined) {
      throw new UserBrowserCdpOutcomeUnknownError(
        "Target.detachFromTarget",
        problem,
      );
    }
  }

  async close(): Promise<void> {
    this.#diagnostics?.event("client-close");
    if (this.#closing) {
      this.#throwIfAttachmentTainted();
      return;
    }
    this.#closing = true;
    if (!this.#closed) this.#socket.close();
    this.#closed = true;
    this.#failAll(new Error("User browser CDP connection closed"));
    this.#throwIfAttachmentTainted();
  }

  async #attach(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    signal?: AbortSignal,
  ): Promise<string> {
    const closure = this.#attachmentClosures.get(targetId);
    const problem = this.#attachmentProblem(closure);
    if (problem !== undefined) {
      throw new UserBrowserCdpOutcomeUnknownError(
        "Target.attachToTarget",
        problem,
      );
    }
    // Routing exists before domain setup so lifecycle events can be tracked.
    // It is not readiness: every caller must join the same setup barrier first.
    const pending = this.#targetAttachments.get(targetId);
    if (pending !== undefined) {
      if (!sameAttachmentOwner(pending.epoch, owner)) {
        throw new Error("User browser attachment ownership changed");
      }
      return await pending.promise;
    }
    const existing = this.#targetSessions.get(targetId);
    if (existing !== undefined) {
      if (closure === undefined || !sameAttachmentOwner(closure, owner)) {
        throw new Error("User browser attachment ownership changed");
      }
      return existing;
    }
    const attachmentClosure = this.#attachmentEpoch(targetId, owner);
    const attachment = {
      promise: Promise.resolve(""),
      epoch: attachmentClosure,
      invalidated: false,
      pendingDetachSessionIds: new Set<string>(),
    };
    const attaching = (async () => {
      const setupDeadline = attachmentClosure.setupDeadline;
      let response: Record<string, unknown> | undefined;
      try {
        response = asRecord(
          await this.#send(
            "Target.attachToTarget",
            { targetId, flatten: true },
            undefined,
            signal,
            USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
            async (late) =>
              await this.#compensateLateAttach(attachmentClosure, late),
          ),
        );
        attachmentClosure.attach = "known-success";
      } catch (error) {
        attachmentClosure.attach =
          error instanceof UserBrowserCdpOutcomeUnknownError
            ? "outcome-unknown"
            : "known-failure";
        if (attachmentClosure.attach === "outcome-unknown") {
          attachmentClosure.unknownEvidence.attach = describeError(error);
        }
        throw error;
      }
      if (typeof response?.sessionId !== "string")
        throw new Error("User browser CDP attach response is invalid");
      attachmentClosure.cdpSessionId = response.sessionId;
      if (attachment.pendingDetachSessionIds.has(response.sessionId)) {
        attachmentClosure.detach = "known-success";
        this.#retireEpoch(attachmentClosure);
        throw new Error("User browser target detached during attachment");
      }
      for (const staleSessionId of attachment.pendingDetachSessionIds) {
        this.#recordLifecycleEvidence(
          attachmentClosure,
          `unrecognized pending detach ${staleSessionId}`,
        );
      }
      if (attachmentClosure.lifecycleEvidence.length > 0) {
        await this.#compensateAttachment(
          attachmentClosure,
          response.sessionId,
        ).catch(() => undefined);
        throw new UserBrowserCdpOutcomeUnknownError(
          "Target.attachToTarget",
          attachmentClosure.lifecycleEvidence.join("; "),
        );
      }
      if (attachment.invalidated) {
        try {
          await this.#compensateAttachment(
            attachmentClosure,
            response.sessionId,
          );
        } catch {
          attachmentClosure.taint =
            "attachment invalidation compensation failed";
        }
        throw new Error("User browser target detached during attachment");
      }
      this.#targetSessions.set(targetId, response.sessionId);
      this.#sessionTargets.set(response.sessionId, targetId);
      this.#sessionEpochs.set(response.sessionId, attachmentClosure);
      this.#targetDocuments.set(targetId, {
        revision: 0,
        frameId: "",
        loaderId: "",
        url: "",
        alive: true,
        pendingFrameInvalidations: new Set(),
        invalidExecutionContextIds: new Set(),
        pendingIsolatedContexts: new Map(),
      });
      const cdpSessionId = response.sessionId;
      // Both domains subscribe independently. Register the exact route and
      // lifecycle state first, then send each once without serial round trips.
      // Join BOTH outcomes before publishing readiness or compensating: a
      // rejected sibling must never leave an unobserved setup or detach twice.
      const setup = await Promise.allSettled(
        (["Page.enable", "Runtime.enable"] as const).map((method) =>
          this.#enableAttachmentDomain(
            attachmentClosure,
            cdpSessionId,
            method,
            setupDeadline,
            signal,
          ),
        ),
      );
      // A known failure in one domain cannot mask the other's unknown send.
      const failure =
        setup.find(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof UserBrowserCdpOutcomeUnknownError,
        ) ?? setup.find((result) => result.status === "rejected");
      try {
        if (failure?.status === "rejected") throw failure.reason;
        this.#assertAttachmentSetupCurrent(
          attachmentClosure,
          cdpSessionId,
          "attachment domains",
        );
        // The aggregate continuation can be delayed after both domain replies.
        // Do not publish an expired setup and let first inspection obtain its
        // separate window. Both commands are known here; readiness was not sent.
        if (performance.now() >= setupDeadline)
          throw new Error(
            "User browser attachment setup deadline elapsed before readiness",
          );
      } catch (error) {
        try {
          await this.#compensateAttachment(attachmentClosure, cdpSessionId);
        } catch (compensationError) {
          attachmentClosure.taint = `attachment setup closure failed (${describeError(error)}; ${describeError(compensationError)})`;
        }
        throw error;
      }
      return cdpSessionId;
    })();
    attachment.promise = attaching;
    this.#targetAttachments.set(targetId, attachment);
    try {
      return await attaching;
    } finally {
      if (this.#targetAttachments.get(targetId) === attachment) {
        this.#targetAttachments.delete(targetId);
        if (
          attachmentClosure.attach === "known-failure" ||
          attachmentClosure.detach === "known-success"
        ) {
          this.#reapEpoch(attachmentClosure, true);
        }
      }
    }
  }

  async #enableAttachmentDomain(
    epoch: UserBrowserAttachmentEpoch,
    sessionId: string,
    method: "Page.enable" | "Runtime.enable",
    setupDeadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const outcome = method === "Page.enable" ? "enable" : "runtimeEnable";
    try {
      this.#assertAttachmentSetupCurrent(epoch, sessionId, method);
      const remaining = setupDeadline - performance.now();
      if (remaining <= 0) {
        throw new Error(
          `User browser attachment setup timed out before ${method}`,
        );
      }
      await this.#send(
        method,
        {},
        sessionId,
        signal,
        remaining,
        undefined,
        undefined,
        () => this.#assertAttachmentSetupCurrent(epoch, sessionId, method),
        undefined,
        setupDeadline,
      );
      if (performance.now() >= setupDeadline)
        throw new UserBrowserCdpOutcomeUnknownError(
          method,
          "original attachment setup deadline elapsed",
        );
      epoch[outcome] = "known-success";
      this.#assertAttachmentSetupCurrent(epoch, sessionId, method);
    } catch (error) {
      if (epoch[outcome] !== "known-success") {
        epoch[outcome] =
          error instanceof UserBrowserCdpOutcomeUnknownError
            ? "outcome-unknown"
            : "known-failure";
        if (epoch[outcome] === "outcome-unknown") {
          epoch.unknownEvidence[outcome] = describeError(error);
        }
      }
      throw error;
    }
  }

  #assertAttachmentSetupCurrent(
    epoch: UserBrowserAttachmentEpoch,
    sessionId: string,
    method: string,
  ): void {
    const attachment = this.#targetAttachments.get(epoch.targetId);
    const document = this.#targetDocuments.get(epoch.targetId);
    if (
      this.#closed ||
      this.#attachmentClosures.get(epoch.targetId) !== epoch ||
      this.#targetSessions.get(epoch.targetId) !== sessionId ||
      this.#sessionTargets.get(sessionId) !== epoch.targetId ||
      this.#sessionEpochs.get(sessionId) !== epoch ||
      attachment?.epoch !== epoch ||
      attachment.invalidated ||
      document === undefined ||
      document.alive === false
    ) {
      throw new Error(`User browser target changed during ${method} setup`);
    }
  }

  #attachmentEpoch(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
  ): UserBrowserAttachmentEpoch {
    if (this.#attachmentClosures.size >= USER_BROWSER_MAX_TARGET_EVIDENCE) {
      this.#recordConnectionTaint(
        "attachment closure evidence exceeded its bound",
      );
      throw new UserBrowserCdpOutcomeUnknownError(
        "Target.attachToTarget",
        "attachment closure evidence exceeded its bound",
      );
    }
    const epoch: UserBrowserAttachmentEpoch = {
      targetId,
      ...owner,
      attachAttempt: this.#nextAttachAttempt++,
      setupDeadline:
        performance.now() + USER_BROWSER_ATTACHMENT_SETUP_TIMEOUT_MS,
      firstInspectClaimed: false,
      attach: "known-failure",
      enable: "known-failure",
      runtimeEnable: "known-failure",
      detach: "known-failure",
      unknownEvidence: {},
      lifecycleEvidence: [],
    };
    this.#attachmentClosures.set(targetId, epoch);
    return epoch;
  }

  async #compensateAttachment(
    epoch: UserBrowserAttachmentEpoch,
    sessionId: string,
  ): Promise<void> {
    epoch.cdpSessionId = sessionId;
    this.#sessionEpochs.set(sessionId, epoch);
    epoch.observationClosing = true;
    try {
      await this.#send(
        "Target.detachFromTarget",
        { sessionId },
        undefined,
        undefined,
        USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
      );
      epoch.detach = "known-success";
      epoch.taint = undefined;
      this.#reapEpoch(epoch, true);
    } catch (error) {
      if (error instanceof UserBrowserCdpOutcomeUnknownError) {
        epoch.detach = "outcome-unknown";
        epoch.unknownEvidence.detach ??= describeError(error);
      } else {
        epoch.detach = "known-failure";
        epoch.taint = describeError(error);
      }
      throw error;
    }
  }

  async #compensateLateAttach(
    epoch: UserBrowserAttachmentEpoch,
    message: Record<string, unknown>,
  ): Promise<void> {
    const protocolError = asRecord(message.error);
    if (protocolError !== undefined) {
      epoch.attach = "known-failure";
      return;
    }
    const sessionId = asRecord(message.result)?.sessionId;
    if (typeof sessionId !== "string") {
      epoch.taint = "late attach response was invalid";
      return;
    }
    epoch.attach = "known-success";
    epoch.cdpSessionId = sessionId;
    await this.#compensateAttachment(epoch, sessionId);
  }

  #recordConnectionTaint(detail: string): void {
    if (this.#connectionTaints.includes(detail)) return;
    if (this.#connectionTaints.length < USER_BROWSER_MAX_OPERATION_EVIDENCE) {
      this.#connectionTaints.push(detail);
      return;
    }
    this.#connectionTaints[this.#connectionTaints.length - 1] =
      "connection taint diagnostics exceeded their bound";
  }

  #throwIfAttachmentTainted(): void {
    const taints = [
      ...this.#connectionTaints,
      ...[...this.#attachmentClosures.values()]
        .map((closure) => this.#attachmentProblem(closure))
        .filter((detail): detail is string => detail !== undefined),
    ];
    if (taints.length > 0) {
      throw new Error(
        `User browser CDP attachment outcome is unknown (${taints.join("; ")})`,
      );
    }
  }

  async #send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
    outcomeTimeoutMs = USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
    onLateResponse?: (message: Record<string, unknown>) => Promise<void>,
    onDispatched?: () => void,
    beforeDispatch?: () => void,
    onLateExpiration?: () => void,
    absoluteDeadline?: number,
  ): Promise<unknown> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("User browser CDP connection is unavailable");
    }
    if (this.#pending.size >= USER_BROWSER_MAX_PENDING_CDP_REQUESTS) {
      this.#recordConnectionTaint("pending CDP requests exceeded their bound");
      throw new Error("User browser CDP pending request bound exceeded");
    }
    if (this.#nextId >= Number.MAX_SAFE_INTEGER) {
      this.#recordConnectionTaint("CDP request id space was exhausted");
      throw new Error("User browser CDP request id space was exhausted");
    }
    const id = this.#nextId++;
    return await new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      let dispatched = false;
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        if (timeout !== undefined) clearTimeout(timeout);
      };
      const abort = () => {
        this.#diagnostics?.event("abort", id, dispatched);
        this.#pending.delete(id);
        finish();
        if (dispatched && onLateResponse !== undefined) {
          this.#retainLateResponse(
            id,
            sessionId,
            onLateResponse,
            onLateExpiration,
          );
        }
        const reason =
          signal?.reason instanceof Error
            ? signal.reason.message
            : "command aborted";
        reject(
          dispatched
            ? new UserBrowserCdpOutcomeUnknownError(method, reason)
            : abortReason(signal ?? AbortSignal.abort()),
        );
      };
      const pending: {
        method: string;
        sessionId?: string;
        dispatched: boolean;
        resolve(value: unknown): void;
        reject(error: Error, receivedResponse?: Record<string, unknown>): void;
      } = {
        method,
        sessionId,
        dispatched: false,
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: (error, receivedResponse) => {
          finish();
          // A matching protocol error is a reply too. Classify at receipt, not
          // in a later await continuation, so an on-time rejection stays known.
          if (
            receivedResponse !== undefined &&
            dispatched &&
            absoluteDeadline !== undefined &&
            performance.now() >= absoluteDeadline
          ) {
            reject(
              new UserBrowserCdpOutcomeUnknownError(
                method,
                `original reserved deadline elapsed (${describeError(error)})`,
              ),
            );
            // This original reply already settled; do not retain a timer for
            // a second response. The failed operation itself remains unknown.
            void onLateResponse?.(receivedResponse).catch((failure: unknown) =>
              this.#recordConnectionTaint(
                `late-response compensation failed (${describeError(failure)})`,
              ),
            );
            return;
          }
          if (
            dispatched &&
            error instanceof UserBrowserCdpOutcomeUnknownError
          ) {
            if (!this.#closed && onLateResponse !== undefined) {
              this.#retainLateResponse(
                id,
                sessionId,
                onLateResponse,
                onLateExpiration,
              );
            } else {
              onLateExpiration?.();
            }
          }
          reject(error);
        },
      };
      this.#pending.set(id, pending);
      const timerArmedAt = this.#diagnostics?.observer.now();
      if (absoluteDeadline !== undefined) {
        outcomeTimeoutMs = absoluteDeadline - performance.now();
        if (outcomeTimeoutMs <= 0) {
          this.#pending.delete(id);
          reject(new Error("Reserved deadline elapsed before dispatch"));
          return;
        }
      }
      timeout = setTimeout(() => {
        const timeoutFiredAt = this.#diagnostics?.observer.now();
        if (!this.#pending.delete(id)) return;
        this.#diagnostics?.event(
          "timeout-fired",
          id,
          dispatched,
          timeoutFiredAt,
        );
        finish();
        reject(
          new UserBrowserCdpOutcomeUnknownError(
            method,
            "outcome timed out after dispatch",
          ),
        );
        if (onLateResponse !== undefined) {
          this.#retainLateResponse(
            id,
            sessionId,
            onLateResponse,
            onLateExpiration,
          );
        }
      }, outcomeTimeoutMs);
      if (timerArmedAt !== undefined)
        this.#diagnostics?.armed(
          id,
          method,
          sessionId,
          outcomeTimeoutMs,
          timerArmedAt,
        );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) {
        abort();
        return;
      }
      try {
        beforeDispatch?.();
        this.#diagnostics?.event("dispatch-attempt", id, dispatched);
        if (absoluteDeadline !== undefined) {
          throwIfAborted(signal);
          if (performance.now() >= absoluteDeadline)
            throw new Error("Reserved deadline elapsed before dispatch");
        }
        this.#socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        );
        dispatched = true;
        pending.dispatched = true;
        this.#diagnostics?.event("dispatch-accepted", id, dispatched);
        onDispatched?.();
      } catch (error) {
        this.#diagnostics?.event("dispatch-throw", id, dispatched);
        this.#pending.delete(id);
        finish();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #retainLateResponse(
    id: number,
    sessionId: string | undefined,
    receive: (message: Record<string, unknown>) => Promise<void>,
    expire: () => void = () => undefined,
  ): void {
    if (this.#lateResponses.size >= USER_BROWSER_MAX_OPERATION_EVIDENCE) {
      const oldest = this.#lateResponses.keys().next().value as
        number | undefined;
      if (oldest !== undefined) {
        const evicted = this.#lateResponses.get(oldest);
        if (evicted !== undefined) {
          clearTimeout(evicted.expires);
          evicted.expire();
        }
        this.#lateResponses.delete(oldest);
      }
      this.#recordConnectionTaint("late-response cleanup exceeded its bound");
    }
    const expires = setTimeout(() => {
      this.#lateResponses.delete(id);
      expire();
    }, USER_BROWSER_LATE_RESPONSE_RETENTION_MS);
    this.#lateResponses.set(id, { sessionId, receive, expire, expires });
  }

  #receive(raw: string): void {
    const receivedAt = this.#diagnostics?.observer.now();
    let message: Record<string, unknown> | undefined;
    try {
      message = asRecord(JSON.parse(raw));
    } catch {
      if (receivedAt !== undefined)
        this.#diagnostics?.malformed("invalid-json", receivedAt);
      this.#failAll(new Error("User browser CDP returned invalid JSON"));
      return;
    }
    if (message === undefined) {
      if (receivedAt !== undefined)
        this.#diagnostics?.malformed("non-object", receivedAt);
      return;
    }
    if (typeof message.id !== "number") {
      this.#receiveEvent(message);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      const late = this.#lateResponses.get(message.id);
      if (late === undefined) {
        if (receivedAt !== undefined)
          this.#diagnostics?.receive(
            message.id,
            message.sessionId,
            "ignored-no-pending",
            receivedAt,
          );
        return;
      }
      if (message.sessionId !== late.sessionId) {
        if (receivedAt !== undefined)
          this.#diagnostics?.receive(
            message.id,
            message.sessionId,
            "late-session-mismatch",
            receivedAt,
          );
        this.#recordConnectionTaint(
          "late CDP response session did not match request",
        );
        return;
      }
      if (receivedAt !== undefined)
        this.#diagnostics?.receive(
          message.id,
          message.sessionId,
          "retained-late",
          receivedAt,
        );
      clearTimeout(late.expires);
      this.#lateResponses.delete(message.id);
      void late
        .receive(message)
        .catch((error: unknown) =>
          this.#recordConnectionTaint(
            `late-response compensation failed (${describeError(error)})`,
          ),
        );
      return;
    }
    this.#pending.delete(message.id);
    if (message.sessionId !== pending.sessionId) {
      if (receivedAt !== undefined)
        this.#diagnostics?.receive(
          message.id,
          message.sessionId,
          "session-mismatch",
          receivedAt,
        );
      this.#recordConnectionTaint(
        `CDP response session did not match request (${pending.method})`,
      );
      pending.reject(
        new UserBrowserCdpOutcomeUnknownError(
          pending.method,
          "response session did not match request",
        ),
      );
      return;
    }
    const error = asRecord(message.error);
    if (receivedAt !== undefined)
      this.#diagnostics?.receive(
        message.id,
        message.sessionId,
        error === undefined ? "pending-match" : "protocol-error",
        receivedAt,
      );
    if (error !== undefined) {
      pending.reject(
        new Error(
          `User browser CDP command failed: ${String(error.message ?? "unknown error")}`,
        ),
        message,
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #receiveEvent(message: Record<string, unknown>): void {
    const method = message.method;
    const params = asRecord(message.params);
    if (typeof method !== "string" || params === undefined) return;
    if (
      typeof message.sessionId === "string" &&
      this.#sessionTargets.has(message.sessionId)
    ) {
      const contexts = this.#mainWorldContexts.get(message.sessionId);
      const identity = (context: { id: number; uniqueId?: string }) =>
        context.uniqueId ?? `id:${context.id}`;
      if (
        method === "Page.frameStartedNavigating" &&
        typeof params.frameId === "string" &&
        params.navigationType !== "sameDocument"
      ) {
        let navigations = this.#mainWorldNavigations.get(message.sessionId);
        if (!navigations) {
          navigations = new Map();
          this.#mainWorldNavigations.set(message.sessionId, navigations);
        }
        if (navigations.size < 256 || navigations.has(params.frameId))
          navigations.set(
            params.frameId,
            new Set(
              [...(contexts?.values() ?? [])]
                .filter((context) => context.frameId === params.frameId)
                .map(identity),
            ),
          );
        else this.#mainWorldContexts.delete(message.sessionId);
      } else if (
        method === "Page.frameNavigated" ||
        method === "Page.frameDetached"
      ) {
        const frameId =
          method === "Page.frameDetached"
            ? params.frameId
            : asRecord(params.frame)?.id;
        if (typeof frameId === "string") {
          const navigations = this.#mainWorldNavigations.get(message.sessionId),
            prior = navigations?.get(frameId);
          for (const [id, context] of contexts ?? [])
            if (
              context.frameId === frameId &&
              (method === "Page.frameDetached" ||
                prior === undefined ||
                prior.has(identity(context)))
            )
              contexts!.delete(id);
          navigations?.delete(frameId);
          if (navigations?.size === 0)
            this.#mainWorldNavigations.delete(message.sessionId);
        }
      }
      if (method === "Runtime.executionContextCreated") {
        const context = asRecord(params.context),
          aux = asRecord(context?.auxData);
        if (
          aux?.isDefault === true &&
          typeof aux.frameId === "string" &&
          typeof context?.id === "number"
        ) {
          let contexts = this.#mainWorldContexts.get(message.sessionId);
          if (!contexts) {
            contexts = new Map();
            this.#mainWorldContexts.set(message.sessionId, contexts);
          }
          // Only the newest default context for a frame may be selected.
          for (const [id, value] of contexts)
            if (value.frameId === aux.frameId) contexts.delete(id);
          if (contexts.size >= 256) return;
          contexts.set(context.id, {
            id: context.id,
            frameId: aux.frameId,
            ...(typeof context.uniqueId === "string"
              ? { uniqueId: context.uniqueId }
              : {}),
          });
        }
      } else if (method === "Runtime.executionContextDestroyed") {
        for (const [id, context] of this.#mainWorldContexts.get(
          message.sessionId,
        ) ?? [])
          if (
            id === params.executionContextId ||
            (typeof params.executionContextUniqueId === "string" &&
              context.uniqueId === params.executionContextUniqueId)
          )
            this.#mainWorldContexts.get(message.sessionId)!.delete(id);
      } else if (method === "Runtime.executionContextsCleared")
        this.#mainWorldContexts.delete(message.sessionId);
    }
    if (method === "Page.screencastFrame") {
      this.#receiveScreencastFrame(message, params);
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const target = readUserBrowserTarget(params.targetInfo);
      if (target === undefined) return;
      this.#targetMetadata.set(target.targetId, target);
      for (const listener of this.#targetMetadataListeners.get(
        target.targetId,
      ) ?? [])
        listener(target);
      return;
    }
    if (
      method === "Target.targetDestroyed" &&
      typeof params.targetId === "string"
    ) {
      this.#targetMetadata.delete(params.targetId);
      this.#reapTarget(params.targetId, true);
      return;
    }
    if (
      method === "Target.detachedFromTarget" &&
      typeof params.sessionId === "string"
    ) {
      const epoch = this.#sessionEpochs.get(params.sessionId);
      if (epoch !== undefined) {
        this.#reapEpoch(epoch, true);
        return;
      }
      if (this.#retiredSessionIds.has(params.sessionId)) return;
      const pending =
        typeof params.targetId === "string"
          ? this.#targetAttachments.get(params.targetId)
          : undefined;
      if (pending !== undefined) {
        if (
          pending.pendingDetachSessionIds.size <
            USER_BROWSER_MAX_OPERATION_EVIDENCE ||
          pending.pendingDetachSessionIds.has(params.sessionId)
        ) {
          pending.pendingDetachSessionIds.add(params.sessionId);
        } else {
          this.#recordLifecycleEvidence(
            pending.epoch,
            "pending detach evidence exceeded its bound",
          );
        }
        return;
      }
      const current =
        typeof params.targetId === "string"
          ? this.#attachmentClosures.get(params.targetId)
          : undefined;
      if (current !== undefined) {
        this.#recordLifecycleEvidence(
          current,
          `unrecognized detached session ${params.sessionId}`,
        );
      } else {
        this.#recordConnectionTaint(
          `unrecognized detached session ${params.sessionId}`,
        );
      }
      return;
    }
    if (
      method === "Inspector.detached" &&
      typeof message.sessionId === "string"
    ) {
      const targetId = this.#sessionTargets.get(message.sessionId);
      const epoch = this.#sessionEpochs.get(message.sessionId);
      if (targetId !== undefined && epoch !== undefined)
        this.#reapEpoch(epoch, true);
      return;
    }
    if (typeof message.sessionId !== "string") return;
    const targetId = this.#sessionTargets.get(message.sessionId);
    if (targetId === undefined) return;
    const buffers = this.#eventBuffers.get(message.sessionId);
    if (method.startsWith("Network.")) buffers?.network?.push(method, params);
    if (
      method === "Runtime.consoleAPICalled" ||
      method === "Runtime.exceptionThrown"
    )
      buffers?.console?.push(method, params);
    if (
      method === "Page.javascriptDialogOpening" ||
      method === "Page.javascriptDialogClosed"
    ) {
      const epoch = this.#sessionEpochs.get(message.sessionId);
      if (
        epoch !== undefined &&
        this.#attachmentClosures.get(targetId) === epoch &&
        epoch.cdpSessionId === message.sessionId
      )
        epoch.nativeDialogOpen = method === "Page.javascriptDialogOpening";
      return;
    }
    const document = this.#targetDocuments.get(targetId);
    if (
      document !== undefined &&
      method === "Runtime.executionContextDestroyed" &&
      typeof params.executionContextId === "number"
    ) {
      if (document.isolatedExecutionContextId === params.executionContextId) {
        this.#invalidateTarget(targetId, false);
        return;
      }
      if (
        document.invalidExecutionContextIds.size <
          USER_BROWSER_MAX_OPERATION_EVIDENCE ||
        document.invalidExecutionContextIds.has(params.executionContextId)
      ) {
        document.invalidExecutionContextIds.add(params.executionContextId);
      } else {
        this.#invalidateTarget(targetId, false);
      }
      return;
    }
    if (
      document !== undefined &&
      method === "Runtime.executionContextsCleared"
    ) {
      this.#invalidateTarget(targetId, false);
      return;
    }
    if (
      document !== undefined &&
      method === "Runtime.executionContextCreated"
    ) {
      const context = asRecord(params.context);
      const auxData = asRecord(context?.auxData);
      if (
        typeof context?.id === "number" &&
        context.name === USER_BROWSER_DOCUMENT_WORLD_NAME &&
        typeof auxData?.frameId === "string"
      ) {
        if (
          document.pendingIsolatedContexts.size <
            USER_BROWSER_MAX_OPERATION_EVIDENCE ||
          document.pendingIsolatedContexts.has(context.id)
        ) {
          document.pendingIsolatedContexts.set(context.id, auxData.frameId);
        } else {
          this.#invalidateTarget(targetId, false);
          return;
        }
        if (
          document.frameId === auxData.frameId &&
          document.isolatedExecutionContextId !== undefined &&
          document.isolatedExecutionContextId !== context.id
        ) {
          this.#invalidateTarget(targetId, false);
        }
      }
      return;
    }
    if (
      document !== undefined &&
      document.frameId.length === 0 &&
      typeof params.frameId === "string" &&
      (method === "Page.navigatedWithinDocument" ||
        method === "Page.frameStartedNavigating" ||
        method === "Page.frameStartedLoading" ||
        method === "Page.backForwardCacheNotUsed")
    ) {
      if (
        document.pendingFrameInvalidations.size <
          USER_BROWSER_MAX_OPERATION_EVIDENCE ||
        [...document.pendingFrameInvalidations].some((event) =>
          event.endsWith(`\u0000${params.frameId}`),
        )
      ) {
        document.pendingFrameInvalidations.add(
          `${method}\u0000${params.frameId}`,
        );
      } else {
        document.revision += 1;
      }
      return;
    }
    if (
      userBrowserDocumentEventInvalidates(
        method,
        params,
        this.#targetDocuments.get(targetId)?.frameId,
      ) ||
      (method === "Page.frameDetached" &&
        params.frameId === this.#targetDocuments.get(targetId)?.frameId)
    ) {
      this.#invalidateTarget(targetId, false);
    }
  }

  #invalidateTarget(targetId: string, disappeared: boolean): void {
    const state = this.#targetDocuments.get(targetId) ?? {
      revision: 0,
      frameId: "",
      loaderId: "",
      url: "",
      alive: true,
      pendingFrameInvalidations: new Set<string>(),
      invalidExecutionContextIds: new Set<number>(),
      pendingIsolatedContexts: new Map<number, string>(),
    };
    state.revision += 1;
    state.alive = !disappeared;
    state.isolatedExecutionContextId = undefined;
    state.invalidExecutionContextIds.clear();
    state.pendingIsolatedContexts.clear();
    this.#targetDocuments.set(targetId, state);
    if (!disappeared) this.#restartScreencastForDocumentChange(targetId);
  }

  #reapTarget(targetId: string, ownershipClosed = false): void {
    const attaching = this.#targetAttachments.get(targetId);
    if (attaching !== undefined) attaching.invalidated = true;
    const epoch = this.#attachmentClosures.get(targetId);
    if (epoch?.cdpSessionId !== undefined) {
      this.#reapEpoch(epoch, ownershipClosed);
      return;
    }
    if (attaching === undefined) {
      this.#targetSessions.delete(targetId);
      this.#targetDocuments.delete(targetId);
      if (ownershipClosed && this.#attachmentProblem(epoch) === undefined) {
        this.#attachmentClosures.delete(targetId);
      }
    }
  }

  #reapEpoch(
    epoch: UserBrowserAttachmentEpoch | undefined,
    ownershipClosed: boolean,
  ): void {
    if (epoch === undefined) return;
    const sessionId = epoch.cdpSessionId;
    if (sessionId) {
      const buffers = this.#eventBuffers.get(sessionId);
      this.#eventBuffers.delete(sessionId);
      this.#mainWorldContexts.delete(sessionId);
      this.#mainWorldNavigations.delete(sessionId);
      void buffers?.network?.close().catch(() => undefined);
      void buffers?.console?.close().catch(() => undefined);
    }
    const attaching = this.#targetAttachments.get(epoch.targetId);
    if (attaching?.epoch === epoch) attaching.invalidated = true;
    if (sessionId !== undefined) {
      for (const [id, pending] of this.#pending) {
        if (
          pending.sessionId === sessionId &&
          (pending.method === "Page.enable" ||
            pending.method === "Runtime.enable")
        ) {
          this.#pending.delete(id);
          this.#diagnostics?.event("attachment-ended", id, pending.dispatched);
          pending.reject(
            new UserBrowserCdpOutcomeUnknownError(
              pending.method,
              "attachment ended during setup",
            ),
          );
        }
      }
      if (this.#screencast?.sessionId === sessionId) {
        this.#endScreencast(
          "unavailable",
          "The observed browser tab is no longer attached.",
        );
      }
      this.#sessionTargets.delete(sessionId);
      this.#sessionEpochs.delete(sessionId);
      this.#rememberRetiredSession(sessionId);
      if (
        this.#targetSessions.get(epoch.targetId) === sessionId &&
        this.#attachmentClosures.get(epoch.targetId) === epoch
      ) {
        this.#targetSessions.delete(epoch.targetId);
        this.#targetDocuments.delete(epoch.targetId);
      }
    }
    if (
      ownershipClosed &&
      attaching?.epoch !== epoch &&
      this.#attachmentClosures.get(epoch.targetId) === epoch &&
      this.#attachmentProblem(epoch) === undefined
    ) {
      this.#attachmentClosures.delete(epoch.targetId);
    }
  }

  #retireEpoch(epoch: UserBrowserAttachmentEpoch): void {
    if (epoch.cdpSessionId !== undefined) {
      this.#rememberRetiredSession(epoch.cdpSessionId);
      this.#sessionEpochs.delete(epoch.cdpSessionId);
    }
    if (this.#attachmentClosures.get(epoch.targetId) === epoch) {
      this.#attachmentClosures.delete(epoch.targetId);
    }
  }

  #rememberRetiredSession(sessionId: string): void {
    if (this.#retiredSessionIds.has(sessionId)) return;
    if (this.#retiredSessionIds.size >= USER_BROWSER_MAX_TARGET_EVIDENCE) {
      const oldest = this.#retiredSessionIds.values().next().value as
        string | undefined;
      if (oldest !== undefined) this.#retiredSessionIds.delete(oldest);
    }
    this.#retiredSessionIds.add(sessionId);
  }

  #recordLifecycleEvidence(
    epoch: UserBrowserAttachmentEpoch,
    detail: string,
  ): void {
    if (epoch.lifecycleEvidence.includes(detail)) return;
    if (epoch.lifecycleEvidence.length < USER_BROWSER_MAX_OPERATION_EVIDENCE) {
      epoch.lifecycleEvidence.push(detail);
      return;
    }
    epoch.lifecycleEvidence[epoch.lifecycleEvidence.length - 1] =
      "attachment lifecycle evidence exceeded its bound";
  }

  #assertAttachmentClosedForOperation(
    targetId: string,
    owner: UserBrowserAttachmentOwner,
    method: string,
  ): void {
    const epoch = this.#attachmentClosures.get(targetId);
    if (epoch === undefined || !sameAttachmentOwner(epoch, owner)) {
      throw new UserBrowserCdpOutcomeUnknownError(
        method,
        "attachment ownership changed during operation",
      );
    }
    const problem = this.#attachmentProblem(epoch);
    if (problem !== undefined) {
      throw new UserBrowserCdpOutcomeUnknownError(method, problem);
    }
  }

  #attachmentProblem(
    closure: UserBrowserAttachmentEpoch | undefined,
  ): string | undefined {
    if (closure === undefined) return undefined;
    const unknown = Object.values(closure.unknownEvidence);
    const evidence = [
      ...unknown,
      ...closure.lifecycleEvidence,
      ...(closure.taint === undefined ? [] : [closure.taint]),
      ...(closure.unsettledMutation === undefined
        ? []
        : [closure.unsettledMutation]),
    ];
    return evidence.length === 0 ? undefined : evidence.join("; ");
  }

  #failAll(error: Error): void {
    this.#diagnostics?.event("fail-all");
    this.#providerRevision += 1;
    this.#closed = true;
    this.#endScreencast(
      "unavailable",
      "The user browser connection is unavailable.",
    );
    if (!this.#closing && this.#attachmentClosures.size > 0) {
      this.#recordConnectionTaint(`connection failed (${error.message})`);
    }
    for (const buffers of this.#eventBuffers.values()) {
      void buffers.network?.close().catch(() => undefined);
      void buffers.console?.close().catch(() => undefined);
    }
    this.#eventBuffers.clear();
    this.#mainWorldContexts.clear();
    this.#mainWorldNavigations.clear();
    this.#targetSessions.clear();
    this.#sessionTargets.clear();
    this.#targetDocuments.clear();
    this.#targetMetadata.clear();
    this.#targetMetadataListeners.clear();
    for (const late of this.#lateResponses.values()) {
      clearTimeout(late.expires);
      late.expire();
    }
    this.#lateResponses.clear();
    for (const pending of this.#pending.values()) {
      pending.reject(
        pending.dispatched
          ? new UserBrowserCdpOutcomeUnknownError(
              pending.method,
              `connection failed after dispatch (${error.message})`,
            )
          : error,
      );
    }
    this.#pending.clear();
  }

  #endScreencast(status: "unavailable" | "failed", message: string): void {
    const subscription = this.#screencastSubscription;
    const state = this.#screencast;
    if (subscription === undefined && state === undefined) return;
    if (subscription !== undefined) {
      subscription.active = false;
      subscription.restartQueued = false;
      this.#screencastSubscription = undefined;
    }
    if (state !== undefined) this.#clearScreencast(state);
    subscription?.listener({ type: "status", status, message });
  }
}

export function userBrowserDocumentEventInvalidates(
  method: string,
  params: Record<string, unknown>,
  mainFrameId?: string,
): boolean {
  if (method === "Page.frameNavigated") {
    const frame = asRecord(params.frame);
    return frame !== undefined && frame.parentId === undefined;
  }
  if (
    method !== "Page.navigatedWithinDocument" &&
    method !== "Page.frameStartedNavigating" &&
    method !== "Page.frameStartedLoading" &&
    method !== "Page.backForwardCacheNotUsed"
  ) {
    return false;
  }
  return typeof params.frameId === "string" && params.frameId === mainFrameId;
}

function validateCdpEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("User browser CDP endpoint is not a valid URL");
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHostname(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "User browser CDP endpoint must be an unauthenticated loopback http:// URL",
    );
  }
  return url;
}

export function windowsBrowserExecutableCandidates(
  environment: NodeJS.ProcessEnv,
): string[] {
  const roots = [
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
    environment.LOCALAPPDATA,
  ].filter((entry): entry is string => entry !== undefined && entry.length > 0);
  return [
    ...roots.map((root) =>
      path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
    ),
    ...roots.map((root) =>
      path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ),
    ...roots.map((root) =>
      path.win32.join(root, "Chromium", "Application", "chrome.exe"),
    ),
  ];
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function decodeUserBrowserScreenshot(data: string): Buffer {
  if (
    data.length === 0 ||
    data.length % 4 === 1 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      data,
    )
  ) {
    throw new UserBrowserScreenshotMalformedError();
  }
  const decoded = Buffer.from(data, "base64");
  const normalized = decoded.toString("base64").replace(/=+$/u, "");
  if (normalized !== data.replace(/=+$/u, "")) {
    throw new UserBrowserScreenshotMalformedError();
  }
  return decoded;
}

function sameAttachmentOwner(
  epoch: UserBrowserAttachmentOwner,
  owner: UserBrowserAttachmentOwner,
): boolean {
  return (
    epoch.logicalSessionId === owner.logicalSessionId &&
    epoch.logicalSessionIncarnation === owner.logicalSessionIncarnation
  );
}

export class UserBrowserDocumentChangedBeforeDispatchError extends Error {
  constructor(detail?: string) {
    super(
      `User browser document changed before action dispatch${detail === undefined ? "" : ` (${detail})`}`,
    );
  }
}

export class UserBrowserDocumentChangedAfterDispatchError extends Error {
  constructor(detail = "document identity changed") {
    super(detail);
  }
}

export class UserBrowserMutationOutcomeUnknownError extends Error {
  constructor(
    operation: string,
    detail: string,
    readonly settlement?: Promise<void>,
  ) {
    super(`${operation} outcome is unknown (${detail})`);
  }
}

export class UserBrowserCdpOutcomeUnknownError extends Error {
  constructor(
    method: string,
    detail: string,
    readonly settlement?: Promise<void>,
  ) {
    super(`User browser CDP ${method} outcome is unknown (${detail})`);
  }
}
class ActionRejectedError extends Error {}

function promiseCapability<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observeRejection<T>(promise: Promise<T>): void {
  void promise.catch(() => undefined);
}

async function raceAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return await operation;
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("cancelled", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet)) &&
    octets.every((octet) => Number(octet) <= 255)
  );
}

function effectivePort(url: URL): string {
  if (url.port.length > 0) return url.port;
  return url.protocol === "http:" || url.protocol === "ws:" ? "80" : "";
}

function isInspectableUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function summarizeTarget(
  sessionId: string,
  target: UserBrowserCdpTarget,
): BrowserTabSummary {
  return {
    sessionId,
    tabId: target.targetId,
    title: target.title.slice(0, 256),
    url: redactBrowserUrl(target.url),
    loading: false,
  };
}

function readUserBrowserGrouping(value: unknown): BrowserTabGrouping {
  const grouping = asRecord(value);
  const reason =
    typeof grouping?.reason === "string"
      ? grouping.reason.slice(0, 160)
      : undefined;
  if (
    grouping?.status === "grouped" &&
    Number.isSafeInteger(grouping.groupId) &&
    (grouping.groupId as number) >= 0
  )
    return {
      status: "grouped",
      groupId: grouping.groupId as number,
      ...(reason === undefined ? {} : { reason }),
    };
  if (grouping?.status === "unknown")
    return {
      status: "unknown",
      reason:
        reason ??
        "Grouping outcome is unknown; tab creation succeeded, do not recreate it",
    };
  if (grouping?.status === "failed")
    return {
      status: "failed",
      reason: reason ?? "Tab was created, but browser tab grouping failed",
    };
  return {
    status: "unavailable",
    reason:
      reason ?? "Tab grouping is unavailable through this browser connection",
  };
}

function readUserBrowserTarget(
  value: unknown,
): UserBrowserCdpTarget | undefined {
  const target = asRecord(value);
  if (
    typeof target?.targetId !== "string" ||
    typeof target.type !== "string" ||
    typeof target.title !== "string" ||
    typeof target.url !== "string"
  )
    return undefined;
  return {
    targetId: target.targetId,
    type: target.type,
    title: target.title,
    url: target.url,
  };
}

function requireFingerprint(value: unknown): BrowserTargetFingerprint {
  const target = asRecord(value);
  const actions = target?.actions;
  if (
    target === undefined ||
    ![
      "selector",
      "tag",
      "role",
      "name",
      "type",
      "id",
      "fieldName",
      "autocomplete",
      "href",
    ].every((key) => typeof target[key] === "string") ||
    !Array.isArray(actions) ||
    !actions.every(
      (action) =>
        action === "click" || action === "type" || action === "select",
    ) ||
    (target.documentIdentity !== undefined &&
      !isCaptureIdentity(target.documentIdentity, 16_384)) ||
    (target.nodeIdentity !== undefined &&
      !isCaptureIdentity(target.nodeIdentity, 256)) ||
    (target.value !== undefined && typeof target.value !== "string") ||
    (target.checked !== undefined && typeof target.checked !== "boolean") ||
    (target.selected !== undefined && typeof target.selected !== "boolean") ||
    (target.optionsTruncated !== undefined &&
      typeof target.optionsTruncated !== "boolean") ||
    (target.options !== undefined &&
      (!Array.isArray(target.options) ||
        target.options.length > 100 ||
        !target.options.every((option) => {
          const candidate = asRecord(option);
          return (
            candidate !== undefined &&
            typeof candidate.value === "string" &&
            typeof candidate.label === "string" &&
            typeof candidate.selected === "boolean" &&
            typeof candidate.disabled === "boolean"
          );
        })))
  ) {
    throw new Error("User browser CDP inspection target is invalid");
  }
  return {
    ...(target.documentIdentity === undefined
      ? {}
      : { documentIdentity: target.documentIdentity as string }),
    ...(target.nodeIdentity === undefined
      ? {}
      : { nodeIdentity: target.nodeIdentity as string }),
    selector: target.selector as string,
    tag: target.tag as string,
    role: target.role as string,
    name: target.name as string,
    type: target.type as string,
    id: target.id as string,
    fieldName: target.fieldName as string,
    autocomplete: target.autocomplete as string,
    href: target.href as string,
    actions: [...actions],
    ...(target.value === undefined ? {} : { value: target.value }),
    ...(target.checked === undefined ? {} : { checked: target.checked }),
    ...(target.selected === undefined ? {} : { selected: target.selected }),
    ...(target.optionsTruncated === undefined
      ? {}
      : { optionsTruncated: target.optionsTruncated }),
    ...(target.options === undefined
      ? {}
      : {
          options: target.options.map((option) => {
            const candidate = asRecord(option)!;
            return {
              value: candidate.value as string,
              label: candidate.label as string,
              selected: candidate.selected as boolean,
              disabled: candidate.disabled as boolean,
            };
          }),
        }),
  };
}

function isCaptureIdentity(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

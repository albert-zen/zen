import { randomUUID } from "node:crypto";
import path from "node:path";

import WebSocket from "ws";

import {
  browserActionScript,
  browserInspectScript,
  redactBrowserUrl,
  resolveBrowserObservedTarget,
  type BrowserInspection,
  type BrowserObservation,
  type BrowserTabSummary,
  type BrowserTargetFingerprint,
  type ZenXBrowserBackend,
} from "./browser-provider.js";

const USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS = 2_000;
const USER_BROWSER_MAX_TARGET_EVIDENCE = 128;
const USER_BROWSER_MAX_DISCOVERED_TARGETS = 512;
const USER_BROWSER_MAX_OPERATION_EVIDENCE = 32;
const USER_BROWSER_MAX_BACKEND_TAINT = 64;
const USER_BROWSER_MAX_PENDING_CDP_REQUESTS = 128;
const USER_BROWSER_MAX_ACTIVE_SESSIONS = 32;
const USER_BROWSER_LATE_RESPONSE_RETENTION_MS = 5_000;

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
  attach: UserBrowserCdpOutcome;
  enable: UserBrowserCdpOutcome;
  detach: UserBrowserCdpOutcome;
  unknownEvidence: Partial<Record<"attach" | "enable" | "detach", string>>;
  lifecycleEvidence: string[];
  taint?: string;
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

export interface UserBrowserCdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export interface UserBrowserCdpClient {
  listTargets(signal?: AbortSignal): Promise<UserBrowserCdpTarget[]>;
  createTarget(url: string, signal?: AbortSignal): Promise<string>;
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
  ): Promise<{ value: unknown; documentIdentity: string }>;
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

interface UserBrowserSession {
  id: string;
  incarnation: number;
  targetIds: Set<string>;
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

export class UserBrowserCdpBackend implements ZenXBrowserBackend {
  readonly #client: UserBrowserCdpClient;
  readonly #sessions = new Map<string, UserBrowserSession>();
  readonly #tabs = new Map<string, UserBrowserTabState>();
  readonly #detachOperations = new Map<string, Promise<void>>();
  readonly #sessionCloseOperations = new Map<string, Promise<number>>();
  readonly #closure = new ZenXUserBrowserAttachmentEpochBoundary();
  #closeOperation?: Promise<void>;
  #backendCloseQueued = false;
  #closing = false;
  #nextSessionIncarnation = 1;

  constructor(client: UserBrowserCdpClient) {
    this.#client = client;
  }

  async listTabs(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary[]> {
    throwIfAborted(signal);
    const session = this.#session(sessionId);
    const operation = this.#startSessionOperation(session, async () => {
      const listed = await this.#client.listTargets();
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
      const beforeTargets = await this.#client.listTargets();
      const beforeTargetIds = new Set(
        beforeTargets.map((target) => target.targetId),
      );
      if (beforeTargets.some((target) => target.url === pendingUrl)) {
        throw new Error("User browser create marker already exists");
      }
      let targetId: string;
      try {
        targetId = await this.#client.createTarget(pendingUrl);
      } catch (error) {
        this.#recordUnresolvedCreate(session, pendingUrl, beforeTargetIds);
        const recovered = await this.#reconcileCreate(
          session,
          pendingUrl,
          beforeTargetIds,
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
      const matches = await this.#client
        .findTargetsByUrl(pendingUrl)
        .catch(() => []);
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
      const tab = this.#tabs.get(targetId);
      let dispatched = false;
      try {
        await this.#client.navigate(
          targetId,
          url,
          this.#attachmentOwner(session),
          undefined,
          () => (dispatched = true),
        );
        if (tab !== undefined) tab.url = url;
        this.#assertSessionCurrent(session);
        const summary = await this.#summary(sessionId, targetId);
        this.#assertSessionCurrent(session);
        return summary;
      } catch (error) {
        if (
          tab !== undefined &&
          (error instanceof UserBrowserMutationOutcomeUnknownError ||
            error instanceof UserBrowserDocumentChangedAfterDispatchError)
        ) {
          tab.tainted = describeError(error);
        }
        throw error;
      }
    });
    return await raceAbort(operation, signal);
  }

  async navigate(
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
      return await raceAbort(operation, signal);
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
        !Array.isArray(raw.targets)
      ) {
        throw new Error(
          "User browser CDP inspection returned an unsupported shape",
        );
      }
      const fingerprints = raw.targets.map(requireFingerprint).slice(0, 80);
      const targets = new Map<string, BrowserTargetFingerprint>();
      const projected = fingerprints.map((fingerprint) => {
        const targetId = randomUUID();
        targets.set(targetId, fingerprint);
        return {
          targetId,
          role: fingerprint.role,
          name: fingerprint.name,
          actions: [...fingerprint.actions],
          ...(fingerprint.secure ? { secure: true as const } : {}),
          ...(fingerprint.value === undefined
            ? {}
            : { value: fingerprint.value }),
        };
      });
      const observationId = randomUUID();
      const summary = await this.#summary(sessionId, tabId);
      this.#assertSessionCurrent(session);
      tab.documentIdentity = evaluation.documentIdentity;
      tab.observation = {
        id: observationId,
        documentVersion: tab.documentVersion,
        targets,
      };
      return {
        ...summary,
        observationId,
        documentVersion: tab.documentVersion,
        visibleText: raw.visibleText.slice(0, 8_000),
        targets: projected,
      };
    });
    return await raceAbort(operation, signal);
  }

  async click(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    return await this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "click",
      "",
      false,
      signal,
    );
  }

  async type(
    sessionId: string,
    tabId: string,
    observationId: string,
    targetId: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary> {
    return await this.#act(
      sessionId,
      tabId,
      observationId,
      targetId,
      "type",
      text,
      submit,
      signal,
    );
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
    return await closing;
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
      let closeFailure: unknown;
      try {
        await this.#client.close();
      } catch (error) {
        closeFailure = error;
      }
      this.#sessions.clear();
      this.#tabs.clear();
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
    action: "click" | "type",
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
    const expectedDocumentIdentity = tab.documentIdentity;
    tab.observation = undefined;
    tab.documentIdentity = undefined;
    let dispatched = false;
    const operation = this.#startOperation(session, tab, async () => {
      let evaluation: { value: unknown; documentIdentity: string };
      try {
        evaluation = await this.#client.evaluateDocument(
          tabId,
          browserActionScript(target, action, text, submit),
          this.#attachmentOwner(session),
          expectedDocumentIdentity,
          signal,
          () => (dispatched = true),
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
      tab.documentVersion += 1;
      try {
        return await this.#summary(sessionId, tabId);
      } catch (error) {
        tab.tainted = describeError(error);
        throw error;
      }
    });
    try {
      return await raceAbort(operation, signal);
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
    const result = this.#startSessionOperation(session, async () => {
      this.#assertTabCurrent(session, targetId, tab);
      return await run();
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    tab.operation = settled;
    void settled.then(() => {
      if (tab.operation === settled) tab.operation = undefined;
    });
    return result;
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
  ): Promise<UserBrowserCdpTarget | undefined> {
    const matches = await this.#client
      .findTargetsByUrl(markerUrl)
      .catch(() => []);
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
}

export interface UserBrowserConnection {
  backend: ZenXBrowserBackend;
  product: string;
}

export async function connectUserBrowserCdp(
  endpoint: string,
  signal?: AbortSignal,
): Promise<UserBrowserConnection> {
  const base = validateCdpEndpoint(endpoint);
  const timeout = AbortSignal.timeout(5_000);
  const probeSignal =
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetch(new URL("/json/version", base), {
    signal: probeSignal,
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const finalUrl = validateCdpEndpoint(response.url);
  if (finalUrl.pathname !== "/json/version") {
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
    !/^\/devtools\/browser\/[^/]+$/u.test(socketUrl.pathname) ||
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
    base,
    probeSignal,
  );
  return { backend: new UserBrowserCdpBackend(client), product };
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
  readonly #socket: WebSocket;
  readonly #httpBase: URL;
  readonly #pending = new Map<
    number,
    {
      method: string;
      dispatched: boolean;
      resolve(value: unknown): void;
      reject(error: Error): void;
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
      receive(message: Record<string, unknown>): Promise<void>;
      expires: NodeJS.Timeout;
    }
  >();
  readonly #connectionTaints: string[] = [];
  readonly #targetDocuments = new Map<
    string,
    {
      revision: number;
      frameId: string;
      loaderId: string;
      url: string;
      alive: boolean;
      pendingFrameInvalidations: Set<string>;
    }
  >();
  #nextId = 1;
  #nextAttachAttempt = 1;
  #providerRevision = 0;
  #closed = false;
  #closing = false;

  private constructor(socket: WebSocket, httpBase: URL) {
    this.#socket = socket;
    this.#httpBase = httpBase;
    socket.on("message", (data) => this.#receive(data.toString()));
    socket.on("close", () =>
      this.#failAll(new Error("User browser CDP connection closed")),
    );
    socket.on("error", (error) => this.#failAll(error));
  }

  static async connect(
    url: string,
    httpBase: URL,
    signal?: AbortSignal,
  ): Promise<JsonRpcUserBrowserCdpClient> {
    const socket = new WebSocket(url, { handshakeTimeout: 5_000 });
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
    const client = new JsonRpcUserBrowserCdpClient(socket, httpBase);
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
    return infos.map((value) => {
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
  }

  async createTarget(url: string, signal?: AbortSignal): Promise<string> {
    const response = asRecord(
      await this.#send(
        "Target.createTarget",
        { url, background: true, focus: false },
        undefined,
        signal,
        USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
      ),
    );
    if (typeof response?.targetId !== "string")
      throw new Error("User browser CDP createTarget response is invalid");
    return response.targetId;
  }

  async findTargetsByUrl(
    url: string,
    signal?: AbortSignal,
  ): Promise<UserBrowserCdpTarget[]> {
    const timeout = AbortSignal.timeout(5_000);
    const requestSignal =
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await fetch(new URL("/json/list", this.#httpBase), {
      signal: requestSignal,
      headers: { accept: "application/json" },
      redirect: "error",
    });
    const finalUrl = validateCdpEndpoint(response.url);
    if (finalUrl.pathname !== "/json/list" || !response.ok) {
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
  ): Promise<{ value: unknown; documentIdentity: string }> {
    throwIfAborted(signal);
    const before = await this.#executionDocument(targetId, owner, signal);
    if (
      expectedDocumentIdentity !== undefined &&
      before.identity !== expectedDocumentIdentity
    ) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
    let response: Record<string, unknown> | undefined;
    let mutationResponseKnown = false;
    try {
      response = asRecord(
        await this.#send(
          "Runtime.evaluate",
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
            contextId: before.executionContextId,
          },
          before.sessionId,
          signal,
          USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
          undefined,
          onDispatched,
          () => this.#assertDocumentFence(before, true),
        ),
      );
      mutationResponseKnown = true;
      if (response?.exceptionDetails !== undefined) {
        throw new Error("User browser CDP evaluation failed");
      }
      const confirmation = asRecord(
        await this.#send(
          "Runtime.evaluate",
          {
            expression: "void 0",
            awaitPromise: true,
            returnByValue: true,
            contextId: before.executionContextId,
          },
          before.sessionId,
          signal,
          USER_BROWSER_CDP_OUTCOME_TIMEOUT_MS,
          undefined,
          undefined,
          () => this.#assertDocumentFence(before, true),
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
        value: asRecord(response?.result)?.value,
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
        );
      }
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
  ): Promise<
    ZenXUserBrowserDocumentExecutionFence & {
      identity: string;
      executionContextId: number;
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
    const response = asRecord(
      await this.#send("Page.getFrameTree", {}, sessionId, signal),
    );
    this.#assertDocumentFence(fence, false);
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
    if (state.pendingFrameInvalidations.has(frame.id)) {
      state.pendingFrameInvalidations.clear();
      this.#invalidateTarget(targetId, false);
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
    state.pendingFrameInvalidations.clear();
    this.#targetDocuments.set(targetId, {
      revision: state.revision,
      frameId: frame.id,
      loaderId: frame.loaderId,
      url: frame.url,
      alive: true,
      pendingFrameInvalidations: state.pendingFrameInvalidations,
    });
    await this.#documentBarrier(fence, signal);
    this.#assertDocumentFence(fence, false);
    const world = asRecord(
      await this.#send(
        "Page.createIsolatedWorld",
        {
          frameId: frame.id,
          worldName: "__zenx_user_browser_document__",
          grantUniveralAccess: false,
        },
        sessionId,
        signal,
      ),
    );
    this.#assertDocumentFence(fence, false);
    if (typeof world?.executionContextId !== "number") {
      throw new Error("User browser CDP execution context is invalid");
    }
    fence.executionContextId = world.executionContextId;
    await this.#documentBarrier(fence, signal);
    this.#assertDocumentFence(fence, true);
    const identity = JSON.stringify({
      targetId,
      sessionId,
      attachAttempt: fence.attachmentEpoch.attachAttempt,
      logicalSessionId: fence.logicalSessionId,
      logicalSessionIncarnation: fence.logicalSessionIncarnation,
      providerRevision: fence.providerRevision,
      revision: fence.documentRevision,
      frameId: frame.id,
      loaderId: frame.loaderId,
      url: frame.url,
      executionContextId: world.executionContextId,
    });
    return {
      identity,
      ...fence,
      executionContextId: world.executionContextId,
    };
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
      (requireContext && fence.executionContextId === undefined)
    ) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
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
    const existing = this.#targetSessions.get(targetId);
    if (existing !== undefined) {
      if (closure === undefined || !sameAttachmentOwner(closure, owner)) {
        throw new Error("User browser attachment ownership changed");
      }
      return existing;
    }
    const pending = this.#targetAttachments.get(targetId);
    if (pending !== undefined) {
      if (!sameAttachmentOwner(pending.epoch, owner)) {
        throw new Error("User browser attachment ownership changed");
      }
      return await pending.promise;
    }
    const attachmentClosure = this.#attachmentEpoch(targetId, owner);
    const attachment = {
      promise: Promise.resolve(""),
      epoch: attachmentClosure,
      invalidated: false,
      pendingDetachSessionIds: new Set<string>(),
    };
    const attaching = (async () => {
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
      });
      try {
        await this.#send("Page.enable", {}, response.sessionId, signal);
        attachmentClosure.enable = "known-success";
        return response.sessionId;
      } catch (error) {
        attachmentClosure.enable =
          error instanceof UserBrowserCdpOutcomeUnknownError
            ? "outcome-unknown"
            : "known-failure";
        if (attachmentClosure.enable === "outcome-unknown") {
          attachmentClosure.unknownEvidence.enable = describeError(error);
        }
        try {
          await this.#compensateAttachment(
            attachmentClosure,
            response.sessionId,
          );
        } catch (compensationError) {
          attachmentClosure.taint = `Page.enable closure failed (${describeError(error)}; ${describeError(compensationError)})`;
        }
        throw error;
      }
    })();
    attachment.promise = attaching;
    this.#targetAttachments.set(targetId, attachment);
    try {
      return await attaching;
    } finally {
      if (this.#targetAttachments.get(targetId) === attachment) {
        this.#targetAttachments.delete(targetId);
      }
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
      attach: "known-failure",
      enable: "known-failure",
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
        this.#pending.delete(id);
        finish();
        if (dispatched && onLateResponse !== undefined) {
          this.#retainLateResponse(id, onLateResponse);
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
        dispatched: boolean;
        resolve(value: unknown): void;
        reject(error: Error): void;
      } = {
        method,
        dispatched: false,
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      };
      this.#pending.set(id, pending);
      timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        finish();
        reject(
          new UserBrowserCdpOutcomeUnknownError(
            method,
            "outcome timed out after dispatch",
          ),
        );
        if (onLateResponse !== undefined) {
          this.#retainLateResponse(id, onLateResponse);
        }
      }, outcomeTimeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) {
        abort();
        return;
      }
      try {
        beforeDispatch?.();
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
        onDispatched?.();
      } catch (error) {
        this.#pending.delete(id);
        finish();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #retainLateResponse(
    id: number,
    receive: (message: Record<string, unknown>) => Promise<void>,
  ): void {
    if (this.#lateResponses.size >= USER_BROWSER_MAX_OPERATION_EVIDENCE) {
      const oldest = this.#lateResponses.keys().next().value as
        number | undefined;
      if (oldest !== undefined) {
        const evicted = this.#lateResponses.get(oldest);
        if (evicted !== undefined) clearTimeout(evicted.expires);
        this.#lateResponses.delete(oldest);
      }
      this.#recordConnectionTaint("late-response cleanup exceeded its bound");
    }
    const expires = setTimeout(() => {
      this.#lateResponses.delete(id);
    }, USER_BROWSER_LATE_RESPONSE_RETENTION_MS);
    this.#lateResponses.set(id, { receive, expires });
  }

  #receive(raw: string): void {
    let message: Record<string, unknown> | undefined;
    try {
      message = asRecord(JSON.parse(raw));
    } catch {
      this.#failAll(new Error("User browser CDP returned invalid JSON"));
      return;
    }
    if (message === undefined) return;
    if (typeof message.id !== "number") {
      this.#receiveEvent(message);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      const late = this.#lateResponses.get(message.id);
      if (late === undefined) return;
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
    const error = asRecord(message.error);
    if (error !== undefined) {
      pending.reject(
        new Error(
          `User browser CDP command failed: ${String(error.message ?? "unknown error")}`,
        ),
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
      method === "Target.targetDestroyed" &&
      typeof params.targetId === "string"
    ) {
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
    const document = this.#targetDocuments.get(targetId);
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
        document.pendingFrameInvalidations.has(params.frameId)
      ) {
        document.pendingFrameInvalidations.add(params.frameId);
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
      )
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
    };
    state.revision += 1;
    state.alive = !disappeared;
    this.#targetDocuments.set(targetId, state);
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
    if (sessionId !== undefined) {
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
    ];
    return evidence.length === 0 ? undefined : evidence.join("; ");
  }

  #failAll(error: Error): void {
    this.#providerRevision += 1;
    this.#closed = true;
    if (!this.#closing && this.#attachmentClosures.size > 0) {
      this.#recordConnectionTaint(`connection failed (${error.message})`);
    }
    this.#targetSessions.clear();
    this.#sessionTargets.clear();
    this.#targetDocuments.clear();
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
  constructor() {
    super("User browser document changed before action dispatch");
  }
}

export class UserBrowserDocumentChangedAfterDispatchError extends Error {
  constructor(detail = "document identity changed") {
    super(detail);
  }
}

export class UserBrowserMutationOutcomeUnknownError extends Error {
  constructor(operation: string, detail: string) {
    super(`${operation} outcome is unknown (${detail})`);
  }
}

export class UserBrowserCdpOutcomeUnknownError extends Error {
  constructor(method: string, detail: string) {
    super(`User browser CDP ${method} outcome is unknown (${detail})`);
  }
}
class ActionRejectedError extends Error {}

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
    typeof target.secure !== "boolean" ||
    !Array.isArray(actions) ||
    !actions.every((action) => action === "click" || action === "type") ||
    (target.value !== undefined && typeof target.value !== "string")
  ) {
    throw new Error("User browser CDP inspection target is invalid");
  }
  return {
    selector: target.selector as string,
    tag: target.tag as string,
    role: target.role as string,
    name: target.name as string,
    type: target.type as string,
    id: target.id as string,
    fieldName: target.fieldName as string,
    autocomplete: target.autocomplete as string,
    href: target.href as string,
    secure: target.secure,
    actions: [...actions],
    ...(target.value === undefined ? {} : { value: target.value }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

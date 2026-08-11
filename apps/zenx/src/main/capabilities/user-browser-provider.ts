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

export interface UserBrowserCdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export interface UserBrowserCdpClient {
  listTargets(signal?: AbortSignal): Promise<UserBrowserCdpTarget[]>;
  createTarget(url: string, signal?: AbortSignal): Promise<string>;
  findTargetByUrl(
    url: string,
    signal?: AbortSignal,
  ): Promise<UserBrowserCdpTarget | undefined>;
  navigate(targetId: string, url: string, signal?: AbortSignal): Promise<void>;
  evaluateDocument(
    targetId: string,
    expression: string,
    expectedDocumentIdentity?: string,
    signal?: AbortSignal,
  ): Promise<{ value: unknown; documentIdentity: string }>;
  detachTarget(targetId: string): Promise<void>;
  close(): Promise<void> | void;
}

interface UserBrowserSession {
  id: string;
  targetIds: Set<string>;
  ignoredTargetIds: Set<string>;
  operations: Set<Promise<void>>;
  unresolvedCreates: Set<string>;
  detachFailures: unknown[];
  detaching: boolean;
}

interface UserBrowserTabState {
  ownerSessionId: string;
  documentVersion: number;
  url: string;
  documentIdentity?: string;
  observation?: BrowserObservation;
  operation?: Promise<void>;
  detaching: boolean;
  tainted?: string;
}

export class UserBrowserCdpBackend implements ZenXBrowserBackend {
  readonly #client: UserBrowserCdpClient;
  readonly #sessions = new Map<string, UserBrowserSession>();
  readonly #tabs = new Map<string, UserBrowserTabState>();
  readonly #detachOperations = new Map<string, Promise<void>>();
  readonly #sessionCloseOperations = new Map<string, Promise<number>>();
  #closeOperation?: Promise<void>;
  #closing = false;

  constructor(client: UserBrowserCdpClient) {
    this.#client = client;
  }

  async listTabs(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabSummary[]> {
    throwIfAborted(signal);
    const session = this.#session(sessionId);
    this.#assertSessionIdle(session);
    const operation = this.#startSessionOperation(session, async () => {
      const listed = await this.#client.listTargets();
      for (const target of listed) {
        if (!isPendingCreateUrl(target.url)) continue;
        session.targetIds.add(target.targetId);
        if (!this.#tabs.has(target.targetId)) {
          this.#tabs.set(target.targetId, {
            ownerSessionId: session.id,
            documentVersion: 1,
            url: target.url,
            detaching: false,
            tainted: "provider-created target requires cleanup",
          });
        }
      }
      const targets = listed.filter(
        (target) =>
          target.type === "page" &&
          isInspectableUrl(target.url) &&
          !session.ignoredTargetIds.has(target.targetId) &&
          (this.#tabs.get(target.targetId) === undefined ||
            this.#tabs.get(target.targetId)?.ownerSessionId === session.id),
      );
      this.#assertSessionCurrent(session);
      const live = new Set(targets.map((target) => target.targetId));
      const disappeared: string[] = [];
      for (const targetId of session.targetIds) {
        if (!live.has(targetId)) {
          session.targetIds.delete(targetId);
          this.#tabs.delete(targetId);
          disappeared.push(targetId);
        }
      }
      const detached = await Promise.allSettled(
        disappeared.map((targetId) => this.#detachTarget(targetId)),
      );
      const detachFailure = detached.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (detachFailure !== undefined) throw detachFailure.reason;
      this.#assertSessionCurrent(session);
      for (const target of targets) {
        session.targetIds.add(target.targetId);
        const tab = this.#tabs.get(target.targetId);
        if (tab === undefined) {
          this.#tabs.set(target.targetId, {
            ownerSessionId: session.id,
            documentVersion: 1,
            url: target.url,
            detaching: false,
          });
        } else if (tab.url !== target.url) {
          tab.url = target.url;
          tab.documentVersion += 1;
          tab.documentIdentity = undefined;
          tab.observation = undefined;
        }
      }
      this.#assertSessionCurrent(session);
      return targets
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
      let targetId: string;
      try {
        targetId = await this.#client.createTarget(pendingUrl);
      } catch (error) {
        const recovered = await this.#client
          .findTargetByUrl(pendingUrl)
          .catch(() => undefined);
        if (recovered === undefined) {
          session.unresolvedCreates.add(pendingUrl);
          throw new Error(
            `User browser create outcome is unknown (${describeError(error)})`,
          );
        }
        this.#accountTarget(session, recovered.targetId, recovered.url, true);
        throw new Error(
          `User browser create outcome is unknown; recovered provider target ${recovered.targetId} for cleanup (${describeError(error)})`,
        );
      }
      // Account for the target before observing the session fence. A concurrent
      // close can then deterministically detach it instead of orphaning it.
      this.#accountTarget(session, targetId, pendingUrl, false);
      this.#assertSessionCurrent(session);
      const tab = this.#tabs.get(targetId);
      try {
        await this.#client.navigate(targetId, url);
        if (tab !== undefined) tab.url = url;
        this.#assertSessionCurrent(session);
        const summary = await this.#summary(sessionId, targetId);
        this.#assertSessionCurrent(session);
        return summary;
      } catch (error) {
        if (tab !== undefined) tab.tainted = describeError(error);
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
    const operation = this.#startOperation(session, tab, async () => {
      try {
        await this.#client.navigate(tabId, url);
        tab.documentVersion += 1;
        tab.url = url;
        tab.documentIdentity = undefined;
        tab.observation = undefined;
        return await this.#summary(sessionId, tabId);
      } catch (error) {
        tab.tainted = describeError(error);
        throw error;
      }
    });
    try {
      return await raceAbort(operation, signal);
    } catch (error) {
      throw new Error(
        `User browser navigation outcome is unknown after cancellation or connection failure (${describeError(error)})`,
      );
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
    if (!session.targetIds.has(tabId)) {
      throw new Error(`Unknown user browser tab: ${tabId}`);
    }
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error("User browser tab was closed");
    tab.detaching = true;
    const operation = (async () => {
      await tab.operation;
      try {
        await this.#detachTarget(tabId);
      } catch (error) {
        session.detachFailures.push(error);
        throw error;
      } finally {
        session.targetIds.delete(tabId);
        session.ignoredTargetIds.add(tabId);
        this.#tabs.delete(tabId);
      }
    })();
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    session.operations.add(settled);
    void settled.then(() => session.operations.delete(settled));
    await operation;
  }

  async closeSession(sessionId: string): Promise<number> {
    const existing = this.#sessionCloseOperations.get(sessionId);
    if (existing !== undefined) return await existing;
    const session = this.#requireSession(sessionId);
    session.detaching = true;
    for (const targetId of session.targetIds) {
      const tab = this.#tabs.get(targetId);
      if (tab !== undefined) tab.detaching = true;
    }
    const closing = (async () => {
      await Promise.all([...session.operations]);
      const targetIds = [...session.targetIds];
      const count = targetIds.length;
      const detached = await Promise.allSettled(
        targetIds.map((targetId) => this.#detachTarget(targetId)),
      );
      for (const targetId of targetIds) this.#tabs.delete(targetId);
      this.#sessions.delete(sessionId);
      const failure = detached.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
      if (session.detachFailures[0] !== undefined)
        throw session.detachFailures[0];
      if (session.unresolvedCreates.size > 0) {
        throw new Error(
          "User browser create outcome is unknown; provider session is tainted",
        );
      }
      return count;
    })();
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
    this.#closing = true;
    for (const session of this.#sessions.values()) session.detaching = true;
    for (const tab of this.#tabs.values()) tab.detaching = true;
    const closing = (async () => {
      const operations = [
        ...this.#sessionCloseOperations.values(),
        ...[...this.#sessions.values()].flatMap((session) => [
          ...session.operations,
        ]),
      ];
      const settledOperations = await Promise.allSettled(operations);
      const detached = await Promise.allSettled(
        [...this.#tabs.keys()].map((targetId) => this.#detachTarget(targetId)),
      );
      let closeFailure: unknown;
      try {
        await this.#client.close();
      } catch (error) {
        closeFailure = error;
      }
      const priorDetachFailure = [...this.#sessions.values()]
        .flatMap((session) => session.detachFailures)
        .at(0);
      this.#sessions.clear();
      this.#tabs.clear();
      const detachFailure = detached.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      const operationFailure = settledOperations.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (operationFailure !== undefined) throw operationFailure.reason;
      if (priorDetachFailure !== undefined) throw priorDetachFailure;
      if (detachFailure !== undefined) throw detachFailure.reason;
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
        dispatched = true;
        evaluation = await this.#client.evaluateDocument(
          tabId,
          browserActionScript(target, action, text, submit),
          expectedDocumentIdentity,
        );
      } catch (error) {
        if (error instanceof UserBrowserDocumentChangedBeforeDispatchError)
          throw error;
        tab.tainted = describeError(error);
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
      throw new Error(
        `User browser action outcome is unknown after cancellation or connection failure${dispatched ? "" : " before dispatch confirmation"}; inspect the current tab before another action (${describeError(error)})`,
      );
    }
  }

  #startOperation<T>(
    session: UserBrowserSession,
    tab: UserBrowserTabState,
    run: () => Promise<T>,
  ): Promise<T> {
    if (tab.detaching) throw new Error("User browser tab is detaching");
    if (tab.operation !== undefined) {
      throw new Error("User browser tab operation is already in flight");
    }
    if (tab.tainted !== undefined) {
      throw new Error(`User browser tab is tainted (${tab.tainted})`);
    }
    const result = this.#startSessionOperation(session, run);
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
  ): Promise<T> {
    this.#assertSessionCurrent(session);
    const result = run();
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    session.operations.add(settled);
    void settled.then(() => session.operations.delete(settled));
    return result;
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
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      session = {
        id: sessionId,
        targetIds: new Set(),
        ignoredTargetIds: new Set(),
        operations: new Set(),
        unresolvedCreates: new Set(),
        detachFailures: [],
        detaching: false,
      };
      this.#sessions.set(sessionId, session);
    }
    if (session.detaching) throw new Error("User browser session is detaching");
    return session;
  }

  #requireSession(sessionId: string): UserBrowserSession {
    if (this.#closing) throw new Error("User browser backend is closing");
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
    if (!session.targetIds.has(tabId)) {
      throw new Error(`Unknown user browser tab: ${tabId}`);
    }
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error("User browser tab was closed");
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
    session.targetIds.add(targetId);
    this.#tabs.set(targetId, {
      ownerSessionId: session.id,
      documentVersion: 1,
      url,
      detaching: session.detaching,
      ...(tainted ? { tainted: "create outcome requires cleanup" } : {}),
    });
  }

  #detachTarget(targetId: string): Promise<void> {
    const existing = this.#detachOperations.get(targetId);
    if (existing !== undefined) return existing;
    const operation = Promise.resolve().then(() =>
      this.#client.detachTarget(targetId),
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
    socketUrl.username.length > 0 ||
    socketUrl.password.length > 0 ||
    socketUrl.search.length > 0 ||
    socketUrl.hash.length > 0
  ) {
    throw new Error(
      "User browser CDP WebSocket must be an unauthenticated loopback ws:// endpoint",
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
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  readonly #targetSessions = new Map<string, string>();
  readonly #sessionTargets = new Map<string, string>();
  readonly #targetAttachments = new Map<
    string,
    { promise: Promise<string>; invalidated: boolean }
  >();
  readonly #targetDocuments = new Map<
    string,
    {
      revision: number;
      frameId: string;
      loaderId: string;
      url: string;
      alive: boolean;
    }
  >();
  #nextId = 1;
  #closed = false;

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
    return new JsonRpcUserBrowserCdpClient(socket, httpBase);
  }

  async listTargets(signal?: AbortSignal): Promise<UserBrowserCdpTarget[]> {
    const response = asRecord(
      await this.#send("Target.getTargets", {}, undefined, signal),
    );
    const infos = response?.targetInfos;
    if (!Array.isArray(infos))
      throw new Error("User browser CDP Target.getTargets response is invalid");
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
      ),
    );
    if (typeof response?.targetId !== "string")
      throw new Error("User browser CDP createTarget response is invalid");
    return response.targetId;
  }

  async findTargetByUrl(
    url: string,
    signal?: AbortSignal,
  ): Promise<UserBrowserCdpTarget | undefined> {
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
    for (const item of value) {
      const target = asRecord(item);
      const targetId = target?.id ?? target?.targetId;
      if (
        typeof targetId === "string" &&
        typeof target?.type === "string" &&
        typeof target?.url === "string" &&
        target.url === url
      ) {
        return {
          targetId,
          type: target.type,
          title: typeof target.title === "string" ? target.title : "",
          url: target.url,
        };
      }
    }
    return undefined;
  }

  async navigate(
    targetId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const sessionId = await this.#attach(targetId, signal);
    await this.#send("Page.navigate", { url }, sessionId, signal);
  }

  async evaluateDocument(
    targetId: string,
    expression: string,
    expectedDocumentIdentity?: string,
    signal?: AbortSignal,
  ): Promise<{ value: unknown; documentIdentity: string }> {
    throwIfAborted(signal);
    const before = await this.#executionDocument(targetId);
    if (
      expectedDocumentIdentity !== undefined &&
      before.identity !== expectedDocumentIdentity
    ) {
      throw new UserBrowserDocumentChangedBeforeDispatchError();
    }
    let response: Record<string, unknown> | undefined;
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
        ),
      );
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
        ),
      );
      if (confirmation?.exceptionDetails !== undefined) {
        throw new Error("User browser CDP post-confirmation failed");
      }
      const after = await this.#executionDocument(targetId);
      if (after.identity !== before.identity) {
        throw new UserBrowserDocumentChangedAfterDispatchError();
      }
      return {
        value: asRecord(response?.result)?.value,
        documentIdentity: after.identity,
      };
    } catch (error) {
      if (error instanceof UserBrowserDocumentChangedAfterDispatchError)
        throw error;
      throw new UserBrowserDocumentChangedAfterDispatchError(
        describeError(error),
      );
    }
  }

  async #executionDocument(
    targetId: string,
    signal?: AbortSignal,
  ): Promise<{
    identity: string;
    executionContextId: number;
    sessionId: string;
  }> {
    const sessionId = await this.#attach(targetId, signal);
    const response = asRecord(
      await this.#send("Page.getFrameTree", {}, sessionId, signal),
    );
    const frame = asRecord(asRecord(response?.frameTree)?.frame);
    if (
      frame === undefined ||
      typeof frame.id !== "string" ||
      typeof frame.loaderId !== "string" ||
      typeof frame.url !== "string"
    ) {
      throw new Error("User browser CDP document identity is invalid");
    }
    const state = this.#targetDocuments.get(targetId);
    if (state?.alive === false)
      throw new Error("User browser target disappeared");
    const revision = state?.revision ?? 0;
    this.#targetDocuments.set(targetId, {
      revision,
      frameId: frame.id,
      loaderId: frame.loaderId,
      url: frame.url,
      alive: true,
    });
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
    if (typeof world?.executionContextId !== "number") {
      throw new Error("User browser CDP execution context is invalid");
    }
    const identity = JSON.stringify({
      targetId,
      sessionId,
      revision,
      frameId: frame.id,
      loaderId: frame.loaderId,
      url: frame.url,
      executionContextId: world.executionContextId,
    });
    return {
      identity,
      executionContextId: world.executionContextId,
      sessionId,
    };
  }

  async detachTarget(targetId: string): Promise<void> {
    const attaching = this.#targetAttachments.get(targetId);
    if (attaching !== undefined) {
      try {
        await attaching.promise;
      } catch {
        this.#reapTarget(targetId);
        return;
      }
    }
    const sessionId = this.#targetSessions.get(targetId);
    if (sessionId === undefined) {
      this.#reapTarget(targetId);
      return;
    }
    try {
      await this.#send("Target.detachFromTarget", { sessionId });
    } finally {
      this.#reapTarget(targetId);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close();
    this.#failAll(new Error("User browser CDP connection closed"));
  }

  async #attach(targetId: string, signal?: AbortSignal): Promise<string> {
    const existing = this.#targetSessions.get(targetId);
    if (existing !== undefined) return existing;
    const pending = this.#targetAttachments.get(targetId);
    if (pending !== undefined) return await pending.promise;
    const attachment = { promise: Promise.resolve(""), invalidated: false };
    const attaching = (async () => {
      const response = asRecord(
        await this.#send(
          "Target.attachToTarget",
          { targetId, flatten: true },
          undefined,
          signal,
        ),
      );
      if (typeof response?.sessionId !== "string")
        throw new Error("User browser CDP attach response is invalid");
      if (attachment.invalidated) {
        try {
          await this.#send("Target.detachFromTarget", {
            sessionId: response.sessionId,
          });
        } catch {
          // The target already disappeared; the local tombstone is authoritative.
        }
        throw new Error("User browser target detached during attachment");
      }
      this.#targetSessions.set(targetId, response.sessionId);
      this.#sessionTargets.set(response.sessionId, targetId);
      this.#targetDocuments.set(targetId, {
        revision: 0,
        frameId: "",
        loaderId: "",
        url: "",
        alive: true,
      });
      try {
        await this.#send("Page.enable", {}, response.sessionId, signal);
        return response.sessionId;
      } catch (error) {
        this.#reapTarget(targetId);
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

  async #send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("User browser CDP connection is unavailable");
    }
    const id = this.#nextId++;
    return await new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("User browser CDP command aborted"),
        );
      };
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) {
        abort();
        return;
      }
      this.#socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    });
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
    if (pending === undefined) return;
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
      this.#reapTarget(params.targetId);
      return;
    }
    if (
      method === "Target.detachedFromTarget" &&
      typeof params.sessionId === "string"
    ) {
      const targetId =
        this.#sessionTargets.get(params.sessionId) ??
        (typeof params.targetId === "string" ? params.targetId : undefined);
      if (targetId !== undefined) this.#reapTarget(targetId);
      return;
    }
    if (
      method === "Inspector.detached" &&
      typeof message.sessionId === "string"
    ) {
      const targetId = this.#sessionTargets.get(message.sessionId);
      if (targetId !== undefined) this.#reapTarget(targetId);
      return;
    }
    if (typeof message.sessionId !== "string") return;
    const targetId = this.#sessionTargets.get(message.sessionId);
    if (targetId === undefined) return;
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
    };
    state.revision += 1;
    state.alive = !disappeared;
    this.#targetDocuments.set(targetId, state);
  }

  #reapTarget(targetId: string): void {
    const attaching = this.#targetAttachments.get(targetId);
    if (attaching !== undefined) attaching.invalidated = true;
    const sessionId = this.#targetSessions.get(targetId);
    if (sessionId !== undefined) this.#sessionTargets.delete(sessionId);
    this.#targetSessions.delete(targetId);
    this.#targetDocuments.delete(targetId);
  }

  #failAll(error: Error): void {
    this.#closed = true;
    this.#targetSessions.clear();
    this.#sessionTargets.clear();
    this.#targetDocuments.clear();
    this.#targetAttachments.clear();
    for (const pending of this.#pending.values()) pending.reject(error);
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

function isPendingCreateUrl(url: string): boolean {
  return url.startsWith("about:blank#zenx-pending-");
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
  return error instanceof Error ? error.message : String(error);
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
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
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

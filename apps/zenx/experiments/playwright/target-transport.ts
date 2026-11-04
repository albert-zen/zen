/**
 * A browser-protocol envelope for ONE already-authorized CDP page attachment.
 * Playwright owns selectors, actionability, input and frame handling. This adapter
 * only translates the browser handshake and routes the page's child sessions.
 * It must never open a browser-wide remote debugging port.
 */
export interface PlaywrightTargetCdp {
  send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  subscribe(
    listener: (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => void,
  ): () => void;
}
export interface PlaywrightCdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** No ownership, permission or retry policy lives in this wire adapter. */
export class PlaywrightTargetTransport {
  readonly #cdp: PlaywrightTargetCdp;
  readonly #target: Record<string, unknown>;
  readonly #version: {
    product: string;
    userAgent: string;
    protocolVersion: string;
    revision: string;
    jsVersion: string;
  };
  readonly #emit: (message: PlaywrightCdpMessage) => void;
  readonly #unsubscribe: () => void;
  readonly #children = new Map<string, string | undefined>();
  readonly #pending = new Set<Promise<unknown>>();
  #ownsAutoAttach = false;
  readonly #pageSession = "zenx-page";
  #attached = false;
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(options: {
    cdp: PlaywrightTargetCdp;
    version: {
      product: string;
      userAgent: string;
      protocolVersion: string;
      revision: string;
      jsVersion: string;
    };
    target: { targetId: string; url: string; title: string };
    emit(message: PlaywrightCdpMessage): void;
  }) {
    this.#cdp = options.cdp;
    this.#version = { ...options.version };
    this.#emit = options.emit;
    this.#target = {
      ...options.target,
      type: "page",
      browserContextId: "zenx-authorized-page-context",
      attached: true,
      canAccessOpener: false,
    };
    this.#unsubscribe = this.#cdp.subscribe((method, params, sessionId) => {
      if (this.#closed || !this.#attached) return;
      if (sessionId !== undefined && !this.#children.has(sessionId)) return;
      if (method === "Target.attachedToTarget") {
        const info = params.targetInfo as Record<string, unknown> | undefined;
        const child = params.sessionId;
        // A popup is a separate Host-owned page, not authority inherited from its
        // opener. Only frames/workers attached beneath this page travel here.
        if (
          !info ||
          !["iframe", "worker"].includes(String(info.type)) ||
          typeof child !== "string"
        )
          return;
        this.#children.set(child, sessionId);
      }
      if (
        method === "Target.detachedFromTarget" &&
        typeof params.sessionId === "string"
      ) {
        if (!this.#children.has(params.sessionId)) return;
        const retired = new Set([params.sessionId]);
        for (const [child, parent] of this.#children) {
          if (parent !== undefined && retired.has(parent)) retired.add(child);
        }
        for (const child of retired) this.#children.delete(child);
      }
      if (
        method === "Target.targetCreated" ||
        method === "Target.targetInfoChanged" ||
        method === "Target.targetDestroyed"
      )
        return;
      this.#emit({ method, params, sessionId: sessionId ?? this.#pageSession });
    });
  }

  async receive(message: PlaywrightCdpMessage): Promise<void> {
    if (this.#closed) return;
    const { id, method, sessionId } = message;
    if (!Number.isSafeInteger(id) || typeof method !== "string") return;
    const params = message.params ?? {};
    try {
      const result =
        sessionId === undefined
          ? await this.#root(method, params)
          : await this.#session(method, params, sessionId);
      if (!this.#closed)
        this.#emit({
          id,
          result: result ?? {},
          ...(sessionId === undefined ? {} : { sessionId }),
        });
    } catch (error) {
      if (!this.#closed)
        this.#emit({
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
          ...(sessionId === undefined ? {} : { sessionId }),
        });
    }
  }

  async #root(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "Browser.getVersion") return this.#version;
    if (method === "Target.getTargetInfo") {
      if (
        params.targetId !== undefined &&
        params.targetId !== this.#target.targetId
      )
        throw Error("Target is outside this page attachment");
      return { targetInfo: this.#target };
    }
    if (method === "Target.getTargets") return { targetInfos: [this.#target] };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.setAutoAttach") {
      if (params.flatten !== true || params.autoAttach !== true)
        throw Error("Only flattened page attachment is supported");
      if (!this.#attached) {
        this.#attached = true;
        this.#emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId: this.#pageSession,
            targetInfo: this.#target,
            waitingForDebugger: false,
          },
        });
      }
      return {};
    }
    throw Error(
      `Browser-wide command is unavailable on a page attachment: ${method}`,
    );
  }

  async #session(
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ): Promise<unknown> {
    if (
      !this.#attached ||
      (sessionId !== this.#pageSession && !this.#children.has(sessionId))
    )
      throw Error("Session is outside this page attachment");
    // Target/browser/storage commands can escape the page even on a page CDP
    // session. Do not implement them as successful no-ops or forward blindly.
    if (
      method.startsWith("Browser.") ||
      method.startsWith("Storage.") ||
      method.startsWith("Target.")
    ) {
      if (
        method !== "Target.setAutoAttach" &&
        method !== "Target.detachFromTarget"
      )
        throw Error(`Command is outside this page attachment: ${method}`);
      if (
        method === "Target.detachFromTarget" &&
        (typeof params.sessionId !== "string" ||
          !this.#children.has(params.sessionId))
      )
        throw Error("Cannot detach a session outside this page attachment");
    }
    if (method === "Target.setAutoAttach") {
      params = {
        ...params,
        filter: [
          { type: "iframe", exclude: false },
          { type: "worker", exclude: false },
          { exclude: true },
        ],
      };
    }
    if (method === "Target.setAutoAttach" && sessionId === this.#pageSession)
      this.#ownsAutoAttach = params.autoAttach === true;
    const pending = this.#cdp.send(
      method,
      params,
      sessionId === this.#pageSession ? undefined : sessionId,
    );
    this.#pending.add(pending);
    try {
      return await pending;
    } finally {
      this.#pending.delete(pending);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#unsubscribe();
    this.#children.clear();
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#pending]);
      if (!this.#ownsAutoAttach) return;
      // Release our auto-attach mode before dropping the transport. Do not leave
      // future frame/worker targets waiting for a debugger that has gone away.
      await this.#cdp.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      // CDP setAutoAttach(false) detaches its related sessions itself. Sending
      // commands to their old IDs afterwards would turn successful cleanup into
      // spurious "session not found" errors. The Host's root stays attached.
    })();
    return this.#closePromise;
  }
}

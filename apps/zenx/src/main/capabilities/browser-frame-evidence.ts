/** Disposable native evidence under an existing root attachment, never a lease. */
export interface BrowserFrameContextEvidence {
  readonly sessionId: string;
  readonly frameId: string;
  readonly id: number;
  readonly uniqueId: string;
  readonly name: string;
  readonly isDefault: boolean;
}

export interface BrowserFrameDocumentEvidence {
  readonly sessionId: string;
  readonly frameId: string;
  readonly parentFrameId?: string;
  readonly loaderId: string;
  readonly url: string;
}

export interface BrowserFrameCaptureFence {
  readonly revision: number;
  readonly root: object;
}

interface Route {
  readonly sessionId: string;
  readonly targetId?: string;
  readonly parentSessionId?: string;
  readonly depth: number;
  readonly contexts: Map<number, BrowserFrameContextEvidence>;
  readonly frames: Map<string, BrowserFrameDocumentEvidence>;
  dialogOpen?: boolean;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

/**
 * The caller first validates the existing root owner and transport generation.
 * Only trusted native parent-session events can introduce descendant routes.
 * This object performs no attach, dispatch, input, retry, or durable mutation.
 */
export class BrowserFrameEvidence {
  readonly #root = {};
  readonly #routes = new Map<string, Route>();
  readonly #retired = new Set<string>();
  #revision = 0;
  #closed = false;
  #failure?: string;

  constructor(readonly rootSessionId: string) {
    this.#routes.set(rootSessionId, {
      sessionId: rootSessionId,
      depth: 0,
      contexts: new Map(),
      frames: new Map(),
    });
  }

  get revision(): number {
    return this.#revision;
  }

  get failure(): string | undefined {
    return this.#failure;
  }

  get hasOpenDialog(): boolean {
    return [...this.#routes.values()].some((route) => route.dialogOpen);
  }

  hasSession(sessionId: string): boolean {
    return !this.#closed && this.#routes.has(sessionId);
  }

  /** Returns true only for this root's current or exactly retired child route. */
  ownsSession(sessionId: string): boolean {
    return this.#routes.has(sessionId) || this.#retired.has(sessionId);
  }

  parentSession(sessionId: string): string | undefined {
    return this.#routes.get(sessionId)?.parentSessionId;
  }

  capture(): BrowserFrameCaptureFence {
    this.#assertAvailable();
    return Object.freeze({ revision: this.#revision, root: this.#root });
  }

  assertCapture(fence: BrowserFrameCaptureFence): void {
    this.#assertAvailable();
    if (fence.root !== this.#root || fence.revision !== this.#revision)
      throw new Error("Browser frame evidence changed; inspect again");
  }

  context(
    sessionId: string,
    frameId: string,
    contextId: number,
  ): BrowserFrameContextEvidence | undefined {
    this.#assertAvailable();
    const context = this.#routes.get(sessionId)?.contexts.get(contextId);
    return context?.frameId === frameId ? context : undefined;
  }

  document(
    sessionId: string,
    frameId: string,
  ): BrowserFrameDocumentEvidence | undefined {
    this.#assertAvailable();
    return this.#routes.get(sessionId)?.frames.get(frameId);
  }

  /** The returned object itself is pinned, not merely a reusable numeric ID. */
  assertContext(context: BrowserFrameContextEvidence): void {
    this.#assertAvailable();
    if (
      this.#routes.get(context.sessionId)?.contexts.get(context.id) !== context
    )
      throw new Error("Browser frame execution context changed; inspect again");
  }

  acceptEvent(sessionId: string, method: string, params: unknown): boolean {
    if (this.#closed) return false;
    const route = this.#routes.get(sessionId);
    if (!route) return this.#retired.has(sessionId);
    const value = object(params);
    if (!value) return false;
    if (
      method === "Page.javascriptDialogOpening" ||
      method === "Page.javascriptDialogClosed"
    ) {
      route.dialogOpen = method === "Page.javascriptDialogOpening";
      return true;
    }
    if (method === "Target.attachedToTarget") {
      const target = object(value.targetInfo);
      if (
        target?.type !== "iframe" ||
        !identifier(target.targetId) ||
        !identifier(value.sessionId) ||
        value.waitingForDebugger !== false
      ) {
        this.#invalidate("Browser child attachment evidence is unavailable");
        return true;
      }
      if (
        this.#routes.has(value.sessionId) ||
        this.#retired.has(value.sessionId) ||
        this.#routes.size >= 65 ||
        route.depth >= 8
      ) {
        this.#invalidate(
          "Browser child attachment evidence exceeded its bound or changed identity",
        );
        return true;
      }
      this.#routes.set(value.sessionId, {
        sessionId: value.sessionId,
        targetId: target.targetId,
        parentSessionId: sessionId,
        depth: route.depth + 1,
        contexts: new Map(),
        frames: new Map(),
      });
      this.#revision++;
      return true;
    }
    if (method === "Target.detachedFromTarget") {
      if (!identifier(value.sessionId)) return false;
      const child = this.#routes.get(value.sessionId);
      if (child?.parentSessionId === sessionId) {
        this.#retireSubtree(child.sessionId);
        return true;
      }
      return this.#retired.has(value.sessionId);
    }
    if (method === "Inspector.detached") {
      if (sessionId === this.rootSessionId) this.close();
      else this.#retireSubtree(sessionId);
      return true;
    }
    if (method === "Runtime.executionContextCreated") {
      const native = object(value.context);
      const aux = object(native?.auxData);
      if (
        !native ||
        !aux ||
        !Number.isSafeInteger(native.id) ||
        (native.id as number) <= 0 ||
        !identifier(native.uniqueId) ||
        !identifier(aux.frameId) ||
        typeof native.name !== "string" ||
        native.name.length > 512 ||
        typeof aux.isDefault !== "boolean"
      )
        return false;
      if (
        route.contexts.size >= 256 &&
        !route.contexts.has(native.id as number)
      ) {
        this.#invalidate("Browser frame context evidence exceeded its bound");
        return true;
      }
      const context = Object.freeze({
        sessionId,
        frameId: aux.frameId,
        id: native.id as number,
        uniqueId: native.uniqueId,
        name: native.name,
        isDefault: aux.isDefault,
      });
      const previous = route.contexts.get(context.id);
      route.contexts.set(context.id, context);
      // Creating an isolated observation world is preparation, not interference.
      if (context.isDefault || previous !== undefined) this.#revision++;
      return true;
    }
    if (method === "Runtime.executionContextDestroyed") {
      for (const [id, context] of route.contexts)
        if (
          id === value.executionContextId ||
          context.uniqueId === value.executionContextUniqueId
        )
          route.contexts.delete(id);
      this.#revision++;
      return true;
    }
    if (method === "Runtime.executionContextsCleared") {
      route.contexts.clear();
      this.#revision++;
      return true;
    }
    if (method === "Page.frameNavigated" || method === "Page.documentOpened") {
      const frame = object(value.frame);
      if (!frame || !this.#recordFrame(route, frame)) return false;
      for (const [id, context] of route.contexts)
        if (context.frameId === frame.id) route.contexts.delete(id);
      this.#revision++;
      return true;
    }
    if (
      method === "Page.frameAttached" ||
      method === "Page.frameDetached" ||
      method === "Page.frameStartedNavigating" ||
      method === "Page.frameStartedLoading" ||
      method === "Page.navigatedWithinDocument" ||
      method === "Page.backForwardCacheNotUsed"
    ) {
      if (identifier(value.frameId)) {
        route.frames.delete(value.frameId);
        for (const [id, context] of route.contexts)
          if (context.frameId === value.frameId) route.contexts.delete(id);
      }
      this.#revision++;
      return true;
    }
    return false;
  }

  /** Bind a read-only native tree to its exact source route and capture fence. */
  recordFrameTree(
    sessionId: string,
    response: unknown,
    fence: BrowserFrameCaptureFence,
  ): void {
    this.assertCapture(fence);
    const route = this.#routes.get(sessionId);
    const tree = object(object(response)?.frameTree);
    if (!route || !tree) throw new Error("Browser frame tree is unavailable");
    const next: Route = { ...route, frames: new Map() };
    const visit = (
      node: Record<string, unknown>,
      parent: string | undefined,
      depth: number,
    ): void => {
      const frame = object(node.frame);
      if (
        !frame ||
        (typeof frame.id === "string" && next.frames.has(frame.id)) ||
        depth > 8 ||
        next.frames.size >= 256 ||
        !this.#recordFrame(next, frame, parent) ||
        (node.childFrames !== undefined && !Array.isArray(node.childFrames))
      )
        throw new Error(
          "Browser frame tree identity is unavailable or exceeds its bound",
        );
      for (const child of (node.childFrames ?? []) as unknown[]) {
        const value = object(child);
        if (!value) throw new Error("Browser child frame tree is malformed");
        visit(value, frame.id as string, depth + 1);
      }
    };
    visit(tree, undefined, 0);
    this.assertCapture(fence);
    route.frames.clear();
    for (const [id, frame] of next.frames) route.frames.set(id, frame);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#revision++;
    this.#routes.clear();
    this.#retired.clear();
  }

  #recordFrame(
    route: Route,
    frame: Record<string, unknown>,
    parent?: string,
  ): boolean {
    if (
      !identifier(frame.id) ||
      !identifier(frame.loaderId) ||
      typeof frame.url !== "string" ||
      frame.url.length > 16384 ||
      (frame.parentId !== undefined && !identifier(frame.parentId)) ||
      (parent !== undefined &&
        frame.parentId !== undefined &&
        frame.parentId !== parent) ||
      (route.frames.size >= 256 && !route.frames.has(frame.id))
    )
      return false;
    route.frames.set(
      frame.id,
      Object.freeze({
        sessionId: route.sessionId,
        frameId: frame.id,
        ...((parent ?? frame.parentId) === undefined
          ? {}
          : { parentFrameId: (parent ?? frame.parentId) as string }),
        loaderId: frame.loaderId,
        url: frame.url,
      }),
    );
    return true;
  }

  #retireSubtree(sessionId: string): void {
    for (const child of [...this.#routes.values()])
      if (child.parentSessionId === sessionId)
        this.#retireSubtree(child.sessionId);
    this.#routes.delete(sessionId);
    if (this.#retired.size < 256) this.#retired.add(sessionId);
    else
      this.#invalidate(
        "Browser retired child-session evidence exceeded its bound",
      );
    this.#revision++;
  }

  #invalidate(reason: string): void {
    this.#failure ??= reason;
    this.#revision++;
  }

  #assertAvailable(): void {
    if (this.#closed) throw new Error("Browser root attachment was retired");
    if (this.#failure) throw new Error(this.#failure);
  }
}

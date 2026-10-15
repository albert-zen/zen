/** Passive, fixture-injected CDP observation. No transport or scheduling authority. */
const LIMITS = {
  connections: 4,
  aliases: 64,
  routeChars: 256,
  requests: 128,
  failures: 16,
  head: 128,
  tail: 128,
};
const METHODS = new Set([
  "Target.setDiscoverTargets",
  "Target.getTargets",
  "Target.createTarget",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Page.enable",
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.releaseObject",
  "Page.captureScreenshot",
  "DOM.describeNode",
  "DOM.resolveNode",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Page.navigate",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.screencastFrameAck",
]);
export type CdpDiagnosticKind =
  | "timer-armed"
  | "dispatch-attempt"
  | "dispatch-accepted"
  | "dispatch-throw"
  | "timeout-fired"
  | "abort"
  | "attachment-ended"
  | "receive"
  | "socket-close"
  | "socket-error"
  | "client-close"
  | "fail-all"
  | "cleanup-start"
  | "cleanup-complete"
  | "cutoff";
export type CdpReceiveDisposition =
  | "pending-match"
  | "session-mismatch"
  | "retained-late"
  | "late-session-mismatch"
  | "ignored-no-pending"
  | "protocol-error"
  | "invalid-json"
  | "non-object";
export interface CdpDiagnosticEvent {
  readonly sequence: number;
  readonly atMs: number;
  readonly connection: number;
  readonly kind: CdpDiagnosticKind;
  readonly id?: number;
  readonly method?: string;
  readonly route?: string;
  readonly receivedRoute?: string;
  readonly routeMatches?: boolean;
  readonly correlation?: "request" | "tombstone" | "uncorrelated";
  readonly disposition?: CdpReceiveDisposition;
  readonly timeoutMs?: number;
  readonly deadlineMs?: number;
  readonly dispatched?: boolean;
}
interface Request {
  routeKnown: boolean;
  sessionId: string | undefined;
  summary: CdpDiagnosticEvent;
}

/** Only this controller sees raw routes. Its listener sees frozen scalar projections. */
export class UserBrowserCdpDiagnosticObserver {
  readonly #origin = performance.now();
  readonly #head: CdpDiagnosticEvent[] = [];
  readonly #tail: CdpDiagnosticEvent[] = [];
  readonly #connections: CdpDiagnosticConnection[] = [];
  readonly #listener?: (event: CdpDiagnosticEvent) => void;
  #sequence = 0;
  #active = true;
  #observerErrors = 0;
  #eventsDropped = 0;
  #connectionOverflow = 0;
  #snapshot?: {
    schema: number;
    clock: string;
    meaning: string;
    limits: typeof LIMITS;
    observerErrors: number;
    eventsDropped: number;
    connectionOverflow: number;
    events: CdpDiagnosticEvent[];
    connections: ReturnType<CdpDiagnosticConnection["finish"]>[];
  };
  constructor(listener?: (event: CdpDiagnosticEvent) => void) {
    this.#listener = listener;
  }
  get counters() {
    return {
      observerErrors: this.#observerErrors,
      eventsDropped: this.#eventsDropped,
      connectionOverflow: this.#connectionOverflow,
    };
  }
  /** All diagnostic computation, including listener throws, stays outside transport semantics. */
  capture(work: () => void): void {
    if (!this.#active) return;
    try {
      work();
    } catch {
      this.#observerErrors += 1;
    }
  }
  now(): number {
    return performance.now() - this.#origin;
  }
  connect(): CdpDiagnosticConnection | undefined {
    if (!this.#active) return undefined;
    if (this.#connections.length >= LIMITS.connections) {
      this.#connectionOverflow += 1;
      return undefined;
    }
    const connection = new CdpDiagnosticConnection(
      this,
      this.#connections.length + 1,
    );
    this.#connections.push(connection);
    return connection;
  }
  record(event: Omit<CdpDiagnosticEvent, "sequence">): CdpDiagnosticEvent {
    if (!this.#active)
      return Object.freeze({ ...event, sequence: this.#sequence });
    const value = Object.freeze({ ...event, sequence: ++this.#sequence });
    if (this.#head.length < LIMITS.head) this.#head.push(value);
    else {
      if (this.#tail.length >= LIMITS.tail) {
        this.#tail.shift();
        this.#eventsDropped += 1;
      }
      this.#tail.push(value);
    }
    // A failed optional sink cannot interrupt state observation or the provider.
    try {
      this.#listener?.(value);
    } catch {
      this.#observerErrors += 1;
    }
    return value;
  }
  mark(kind: "cleanup-start" | "cleanup-complete"): void {
    this.capture(() => this.record({ kind, connection: 0, atMs: this.now() }));
  }
  stop() {
    if (this.#snapshot !== undefined) return this.#snapshot;
    this.capture(() =>
      this.record({ kind: "cutoff", connection: 0, atMs: this.now() }),
    );
    this.#active = false;
    const connections = this.#connections.map((connection) =>
      connection.finish(),
    );
    this.#snapshot = {
      schema: 1,
      clock: "Node performance.now relative to observer creation",
      meaning:
        "Observed callback times only; dispatch-accepted means send returned. Late replies never restore an unknown outcome.",
      limits: { ...LIMITS },
      ...this.counters,
      events: [...this.#head, ...this.#tail],
      connections,
    };
    return this.#snapshot;
  }
}

export class CdpDiagnosticConnection {
  readonly #aliases = new Map<string, string>();
  readonly #requests = new Map<number, Request>();
  readonly #tombstones = new Map<number, Request>();
  readonly #failures = new Map<number, CdpDiagnosticEvent>();
  #aliasesOverflow = 0;
  #requestsEvicted = 0;
  #tombstonesEvicted = 0;
  #failuresEvicted = 0;
  constructor(
    readonly observer: UserBrowserCdpDiagnosticObserver,
    readonly ordinal: number,
  ) {}
  #alias(route: unknown, received = false): string {
    if (route === undefined) return received ? "missing" : "root";
    if (typeof route !== "string") return "invalid";
    if (route.length > LIMITS.routeChars) {
      this.#aliasesOverflow += 1;
      return "overflow";
    }
    const known = this.#aliases.get(route);
    if (known !== undefined) return known;
    if (this.#aliases.size >= LIMITS.aliases) {
      this.#aliasesOverflow += 1;
      return "overflow";
    }
    const alias = `session-${this.#aliases.size + 1}`;
    this.#aliases.set(route, alias);
    return alias;
  }
  #boundedSet<T>(
    map: Map<number, T>,
    id: number,
    value: T,
    limit: number,
  ): boolean {
    let evicted = false;
    if (!map.has(id) && map.size >= limit) {
      map.delete(map.keys().next().value!);
      evicted = true;
    }
    map.set(id, value);
    return evicted;
  }
  armed(
    id: number,
    method: string,
    sessionId: string | undefined,
    timeoutMs: number,
    atMs: number,
  ): void {
    this.observer.capture(() => {
      const summary = this.observer.record({
        connection: this.ordinal,
        kind: "timer-armed",
        id,
        method: METHODS.has(method) ? method : "other",
        route: this.#alias(sessionId),
        atMs,
        timeoutMs,
        deadlineMs: atMs + timeoutMs,
      });
      const routeKnown =
        sessionId === undefined || sessionId.length <= LIMITS.routeChars;
      if (
        this.#boundedSet(
          this.#requests,
          id,
          {
            sessionId: routeKnown ? sessionId : undefined,
            routeKnown,
            summary,
          },
          LIMITS.requests,
        )
      )
        this.#requestsEvicted += 1;
    });
  }
  event(
    kind: CdpDiagnosticKind,
    id?: number,
    dispatched?: boolean,
    atMs?: number,
  ): void {
    this.observer.capture(() => {
      const request =
        id === undefined
          ? undefined
          : (this.#requests.get(id) ?? this.#tombstones.get(id));
      const value = this.observer.record({
        ...(request?.summary ?? {}),
        connection: this.ordinal,
        kind,
        id,
        atMs: atMs ?? this.observer.now(),
        dispatched,
      });
      if (request !== undefined) request.summary = value;
      if (
        id !== undefined &&
        [
          "timeout-fired",
          "abort",
          "dispatch-throw",
          "attachment-ended",
        ].includes(kind)
      )
        this.#retire(id, true);
      if (kind === "fail-all")
        for (const [pending, request] of this.#requests) {
          request.summary = Object.freeze({
            ...request.summary,
            kind,
            sequence: value.sequence,
            atMs: value.atMs,
          });
          this.#retire(pending, true);
        }
    });
  }
  receive(
    id: number,
    sessionId: unknown,
    disposition: CdpReceiveDisposition,
    atMs: number,
  ): void {
    this.observer.capture(() => {
      const live = this.#requests.get(id);
      const request = live ?? this.#tombstones.get(id);
      const value = this.observer.record({
        ...(request?.summary ?? {}),
        connection: this.ordinal,
        kind: "receive",
        id,
        atMs,
        disposition,
        receivedRoute: this.#alias(sessionId, true),
        routeMatches:
          request === undefined || !request.routeKnown
            ? undefined
            : sessionId === request.sessionId,
        correlation:
          request === undefined || !request.routeKnown
            ? "uncorrelated"
            : live === undefined
              ? "tombstone"
              : "request",
      });
      if (request !== undefined) request.summary = value;
      if (live !== undefined)
        this.#retire(
          id,
          disposition === "session-mismatch" ||
            disposition === "protocol-error",
        );
    });
  }
  malformed(disposition: "invalid-json" | "non-object", atMs: number): void {
    this.observer.capture(() =>
      this.observer.record({
        connection: this.ordinal,
        kind: "receive",
        atMs,
        disposition,
      }),
    );
  }
  #retire(id: number, failed: boolean): void {
    const request = this.#requests.get(id);
    if (request === undefined) return;
    this.#requests.delete(id);
    if (this.#boundedSet(this.#tombstones, id, request, LIMITS.requests))
      this.#tombstonesEvicted += 1;
    if (
      failed &&
      this.#boundedSet(this.#failures, id, request.summary, LIMITS.failures)
    )
      this.#failuresEvicted += 1;
  }
  finish() {
    const result = {
      connection: this.ordinal,
      aliasesOverflow: this.#aliasesOverflow,
      requestsEvicted: this.#requestsEvicted,
      tombstonesEvicted: this.#tombstonesEvicted,
      failuresEvicted: this.#failuresEvicted,
      unfinished: [...this.#requests.values()].map(({ summary }) => summary),
      failures: [...this.#failures.values()],
    };
    this.#requests.clear();
    this.#tombstones.clear();
    this.#aliases.clear();
    this.#failures.clear();
    return result;
  }
}

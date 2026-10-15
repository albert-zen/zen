/** Target-page input only. Does not request tab/window activation or send OS input. */
export const browserInputKeys = [
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
] as const;
export const browserTargetedInputPolicy = {
  interactionMode: "background_safe",
  userActivation: true,
  siteDialogsPopupsOrFocusPossible: true,
  nativeSurfaceFallback: "reject-use-human-control",
} as const;

export type BrowserInputKey = (typeof browserInputKeys)[number];
export interface BrowserInputViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
  scrollX: number;
  scrollY: number;
  visualScale: number;
  visualOffsetX: number;
  visualOffsetY: number;
}
export interface BrowserInputSnapshot {
  documentKey: string;
  viewport: BrowserInputViewport;
  focusId: string | null;
  pointerHitId?: string;
  pointerPoint?: { x: number; y: number };
  focusNeedsShadowEvidence?: boolean;
  pointerNeedsShadowEvidence?: boolean;
  focusUnsupported?: BrowserInputUnsupportedReason;
  focusBackendNodeId?: number;
  pointerBackendNodeId?: number;
  inputRevision: number;
  layoutRevision: number;
}
export interface BrowserInputObservation {
  snapshot: BrowserInputSnapshot;
  screenshotId: string;
}

export type BrowserInputUnsupportedReason = "native-surface" | "shadow-surface";
export class BrowserInputUnsupportedError extends Error {
  readonly code = "BROWSER_INPUT_UNSUPPORTED";
  constructor(readonly reason: BrowserInputUnsupportedReason) {
    super(
      `BROWSER_INPUT_UNSUPPORTED:${reason}: This local surface is unsupported for targeted input; use human control`,
    );
  }
}

/** Open-root traversal only; actual closed roots are checked by trusted CDP metadata. */
const browserInputElementResolutionScript = `
  const unsupported = 'iframe,frame,object,embed,select,input[type="file"],input[type="color"],input[type="date"],input[type="datetime-local"],input[type="month"],input[type="time"],input[type="week"]';
  const canHostShadow = element => element.namespaceURI === 'http://www.w3.org/1999/xhtml' && (element.localName.includes('-') || /^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/.test(element.localName));
  const nativeSurface = element => !!(element?.closest(unsupported) || element?.closest('label')?.control?.matches(unsupported));
  const resolveFocus = () => {
    let element = document.activeElement;
    for (let depth = 0; element && depth < 32; depth++) {
      if (nativeSurface(element)) return { unsupported: 'native-surface' };
      const root = element.shadowRoot;
      if (!root) return { element };
      if (!state.shadowRoots.has(root)) return { unsupported: 'shadow-surface' };
      const next = root.activeElement;
      if (!next || next === element || next.getRootNode() !== root) return { unsupported: 'shadow-surface' };
      element = next;
    }
    return element ? { unsupported: 'shadow-surface' } : {};
  };
  const resolveHit = (x, y) => {
    let element = document.elementFromPoint(x, y);
    for (let depth = 0; element && depth < 32; depth++) {
      if (nativeSurface(element)) return { unsupported: 'native-surface' };
      const root = element.shadowRoot;
      if (!root) return { element };
      if (!state.shadowRoots.has(root) || typeof root.elementFromPoint !== 'function') break;
      const next = root.elementFromPoint(x, y);
      if (!next || next === element || next.getRootNode() !== root) break;
      element = next;
    }
    return { unsupported: 'shadow-surface' };
  };
`;

/** Runs in the provider's isolated world; the page cannot forge the registry. */
export const browserInputSnapshotScript = `(() => {
  const key = Symbol.for("zenx-browser-targeted-input-v2");
  let state = globalThis[key];
  if (!state || state.document !== document) {
    state = { document, id: [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8, "0")).join(""), nodes: new WeakMap(), next: 1, inputRevision: 0, layoutRevision: 0, shadowRoots: new WeakSet(), shadowRootCount: 0 };
    globalThis[key] = state;
    for (const type of ["pointerdown", "pointerup", "keydown", "keyup", "wheel"]) document.addEventListener(type, event => { if (event.isTrusted) state.inputRevision++; }, true);
    for (const type of ["scroll", "resize"]) window.addEventListener(type, () => state.layoutRevision++, true);
    const decoration = node => node instanceof Element && (node.matches('[data-zenx-agent-pointer]') || node.closest('[data-zenx-agent-pointer]'));
    state.recordMutations = records => {
      if (records.some(record => !decoration(record.target) && !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].length > 0 && [...record.addedNodes, ...record.removedNodes].every(decoration)))) state.layoutRevision++;
    };
    state.observer = new MutationObserver(state.recordMutations);
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  // Document subtree observation does not cross shadow boundaries. Discover
  // bounded open roots before capture, reusing the same transient observer.
  // Untracked roots remain locally unsupported, rather than trusting stale pixels.
  const roots = [document];
  let budget = 8192;
  for (let index = 0; index < roots.length && budget > 0; index++) {
    const walker = document.createTreeWalker(roots[index], NodeFilter.SHOW_ELEMENT);
    let element;
    while (budget-- > 0 && (element = walker.nextNode())) {
      const root = element.shadowRoot;
      if (!root) continue;
      if (!state.shadowRoots.has(root)) {
        if (state.shadowRootCount >= 128) continue;
        state.shadowRoots.add(root);
        state.shadowRootCount++;
        state.layoutRevision++;
        state.observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        root.addEventListener('scroll', () => state.layoutRevision++, true);
      }
      roots.push(root);
    }
  }
  state.recordMutations(state.observer.takeRecords());
  ${browserInputElementResolutionScript}
  const focus = resolveFocus();
  const focused = focus.element;
  state.focusNode = focused;
  let focusId = null;
  if (focused && focused !== document.body && focused !== document.documentElement) {
    focusId = state.nodes.get(focused);
    if (!focusId) { focusId = state.id + ":" + state.next++; state.nodes.set(focused, focusId); }
  }
  return {
    documentKey: state.id + "|" + location.href,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY, visualScale: globalThis.visualViewport?.scale ?? 1, visualOffsetX: globalThis.visualViewport?.offsetLeft ?? 0, visualOffsetY: globalThis.visualViewport?.offsetTop ?? 0 },
    focusId, ...(focusId && canHostShadow(focused) ? { focusNeedsShadowEvidence: true } : {}), ...(focus.unsupported ? { focusUnsupported: focus.unsupported } : {}), inputRevision: state.inputRevision, layoutRevision: state.layoutRevision,
  };
})()`;

export function browserInputProbeScript(
  action:
    | { kind: "click"; x: number; y: number }
    | { kind: "key"; key: BrowserInputKey },
): string {
  if (action.kind !== "click") return browserInputSnapshotScript;
  if (![action.x, action.y].every(Number.isFinite))
    throw new Error("Browser pointer coordinates must be finite numbers");
  return `(() => {
    const snapshot = ${browserInputSnapshotScript};
    const state = globalThis[Symbol.for("zenx-browser-targeted-input-v2")];
    ${browserInputElementResolutionScript}
    const hit = resolveHit(${JSON.stringify(action.x)}, ${JSON.stringify(action.y)});
    if (hit.unsupported) return { browserInputUnsupported: hit.unsupported };
    const element = hit.element;
    state.hitNode = element;
    let pointerHitId = state.nodes.get(element);
    if (!pointerHitId) { pointerHitId = state.id + ":" + state.next++; state.nodes.set(element, pointerHitId); }
    return { ...snapshot, pointerHitId, ...(canHostShadow(element) ? { pointerNeedsShadowEvidence: true } : {}), pointerPoint: { x: ${JSON.stringify(action.x)}, y: ${JSON.stringify(action.y)} } };
  })()`;
}

export function includesBrowserInputSnapshot(expression: string): boolean {
  return expression.includes('Symbol.for("zenx-browser-targeted-input-v2")');
}

type BrowserInputCommand = (
  method: "Runtime.evaluate" | "DOM.describeNode" | "Runtime.releaseObject",
  params: Record<string, unknown>,
) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Only known JSON probe denials get a public classification. Runtime exceptions
 * and incomplete CDP metadata remain failures, never a successful native refusal. */
export async function resolveBrowserInputEvidence(
  value: unknown,
  send: BrowserInputCommand,
  releaseOwnedObject: (objectId: string) => Promise<unknown> = (objectId) =>
    send("Runtime.releaseObject", { objectId }),
): Promise<unknown> {
  const outer = record(value);
  if (!outer) return value;
  if (outer.browserInputUnsupported !== undefined) {
    requireBrowserInputSnapshot(value); // known refusal, or malformed data error
    throw new Error("Browser input probe returned invalid denial metadata");
  }
  const nested = outer.inputSnapshot !== undefined;
  const raw = record(nested ? outer.inputSnapshot : value);
  if (!raw || typeof raw.documentKey !== "string") return value;
  // Viewport limitations remain optional; do not turn an unrelated DOM inspect
  // into a failure merely because coordinate input is unavailable.
  let snapshot: BrowserInputSnapshot;
  try {
    snapshot = requireBrowserInputSnapshot(raw);
  } catch (error) {
    if (nested) return value;
    throw error;
  }
  if (
    !snapshot.focusNeedsShadowEvidence &&
    !snapshot.pointerNeedsShadowEvidence
  )
    return value;
  const point = snapshot.pointerPoint;
  const probe = point
    ? browserInputProbeScript({ kind: "click", ...point })
    : browserInputSnapshotScript;
  const owned: {
    objectId: string;
    role: "focus" | "pointer";
    id: string;
    backendNodeId?: number;
    reason?: BrowserInputUnsupportedReason;
  }[] = [];
  const readValue = (response: unknown) => {
    const result = record(response);
    if (!result || result.exceptionDetails !== undefined)
      throw new Error("Browser input surface evidence evaluation failed");
    return record(result.result);
  };
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await Promise.all(
      owned.map(async ({ objectId }) => {
        try {
          await releaseOwnedObject(objectId);
        } catch {
          /* Best-effort exact-session cleanup; unknown release is never retried. */
        }
      }),
    );
  };
  const describe = async (entry: (typeof owned)[number]) => {
    const node = record(
      record(
        await send("DOM.describeNode", {
          ...(released
            ? { backendNodeId: entry.backendNodeId }
            : { objectId: entry.objectId }),
          depth: 0,
          pierce: false,
        }),
      )?.node,
    );
    if (
      !node ||
      node.nodeType !== 1 ||
      !Number.isSafeInteger(node.backendNodeId) ||
      (node.backendNodeId as number) <= 0 ||
      typeof node.localName !== "string" ||
      !Array.isArray(node.attributes)
    )
      throw new Error(
        "Browser input surface evidence is unavailable or malformed",
      );
    if (
      entry.backendNodeId !== undefined &&
      entry.backendNodeId !== node.backendNodeId
    )
      throw new Error(
        "Browser input node identity changed during surface verification",
      );
    entry.backendNodeId = node.backendNodeId as number;
    const roots = node.shadowRoots;
    if (roots !== undefined && (!Array.isArray(roots) || roots.length > 1))
      throw new Error(
        "Browser input shadow metadata is unavailable or malformed",
      );
    if (
      Array.isArray(roots) &&
      roots.some(
        (root) =>
          !record(root) ||
          !["closed", "open", "user-agent"].includes(
            String(record(root)?.shadowRootType),
          ),
      )
    )
      throw new Error(
        "Browser input shadow metadata is unavailable or malformed",
      );
    const attributes = node.attributes as unknown[];
    if (
      attributes.length > 256 ||
      attributes.length % 2 ||
      attributes.some(
        (attribute) => typeof attribute !== "string" || attribute.length > 8192,
      )
    )
      throw new Error("Browser input node attributes are malformed");
    const typeIndex = attributes.findIndex(
      (attribute, index) => index % 2 === 0 && attribute === "type",
    );
    const inputType =
      typeIndex >= 0 ? String(attributes[typeIndex + 1]).toLowerCase() : "text";
    if (
      ["iframe", "frame", "object", "embed", "select"].includes(
        node.localName,
      ) ||
      (node.localName === "input" &&
        [
          "file",
          "color",
          "date",
          "datetime-local",
          "month",
          "time",
          "week",
        ].includes(inputType))
    )
      entry.reason = "native-surface";
    else if (
      Array.isArray(roots) &&
      roots.some((root) => record(root)?.shadowRootType !== "user-agent")
    )
      entry.reason = "shadow-surface";
    // Never erase a refusal discovered earlier in the same bounded verification.
    if (entry.reason && entry.role === "pointer")
      throw new BrowserInputUnsupportedError(entry.reason);
  };
  try {
    for (const role of ["focus", "pointer"] as const) {
      const id = role === "focus" ? snapshot.focusId : snapshot.pointerHitId;
      const needsEvidence =
        role === "focus"
          ? snapshot.focusNeedsShadowEvidence
          : snapshot.pointerNeedsShadowEvidence &&
            snapshot.pointerPoint !== undefined;
      if (!id || !needsEvidence) continue;
      const expression = `(() => { const state = globalThis[Symbol.for("zenx-browser-targeted-input-v2")]; const node = state?.${role === "focus" ? "focusNode" : "hitNode"}; return state?.document === document && state.id + "|" + location.href === ${JSON.stringify(snapshot.documentKey)} && node?.isConnected && state.nodes.get(node) === ${JSON.stringify(id)} ? node : null; })()`;
      const result = readValue(
        await send("Runtime.evaluate", {
          expression,
          returnByValue: false,
          awaitPromise: false,
        }),
      );
      if (
        result?.subtype !== "node" ||
        typeof result.objectId !== "string" ||
        !result.objectId
      )
        throw new Error(
          "Browser input candidate changed before surface verification",
        );
      const entry = { objectId: result.objectId, role, id };
      owned.push(entry);
      await describe(entry);
    }
    // Finish cleanup before the final identity/surface checks. The final query
    // uses only the backendNodeId just returned for our exact owned object.
    await release();
    const final = requireBrowserInputSnapshot(
      readValue(
        await send("Runtime.evaluate", {
          expression: probe,
          returnByValue: true,
          awaitPromise: true,
        }),
      )?.value,
    );
    // Compare the generated DOM snapshot before adding Host-only metadata.
    assertBrowserInputSnapshot(snapshot, final);
    if (snapshot.pointerHitId !== final.pointerHitId)
      throw new Error("Browser input hit changed during surface verification");
    // describeNode again after the fresh DOM probe: attachShadow does not emit
    // a document mutation, and no 'no shadow' result is cached across actions.
    for (const entry of owned) await describe(entry);
    // A node can be detached while describeNode still reports its old metadata.
    // Confirm current DOM identity after that final native query as well.
    const confirmed = requireBrowserInputSnapshot(
      readValue(
        await send("Runtime.evaluate", {
          expression: probe,
          returnByValue: true,
          awaitPromise: true,
        }),
      )?.value,
    );
    assertBrowserInputSnapshot(snapshot, confirmed);
    if (snapshot.pointerHitId !== confirmed.pointerHitId)
      throw new Error("Browser input hit changed after surface verification");
    for (const entry of owned) {
      if (entry.role === "focus") {
        snapshot = {
          ...snapshot,
          focusBackendNodeId: entry.backendNodeId,
          ...(entry.reason
            ? { focusId: null, focusUnsupported: entry.reason }
            : {}),
        };
      } else
        snapshot = { ...snapshot, pointerBackendNodeId: entry.backendNodeId };
    }
    return nested ? { ...outer, inputSnapshot: snapshot } : snapshot;
  } catch (error) {
    // This optional input evidence must not remove the pre-existing DOM inspect
    // capability. No classified denial is manufactured: an action without this
    // metadata rejects for missing coherent input, never as a native refusal.
    // Each provider still performs its ordinary document/control fence afterward.
    if (nested) return { ...outer, inputSnapshot: undefined };
    throw error;
  } finally {
    await release();
  }
}

export function requireBrowserInputSnapshot(
  value: unknown,
): BrowserInputSnapshot {
  if (value === null || typeof value !== "object")
    throw new Error(
      "Browser targeted input snapshot is unavailable; inspect again",
    );
  const denied = (value as { browserInputUnsupported?: unknown })
    .browserInputUnsupported;
  if (denied === "native-surface" || denied === "shadow-surface")
    throw new BrowserInputUnsupportedError(denied);
  const snapshot = value as BrowserInputSnapshot;
  const viewport = snapshot.viewport;
  if (
    typeof snapshot.documentKey !== "string" ||
    snapshot.documentKey.length < 32 ||
    (snapshot.focusId !== null && typeof snapshot.focusId !== "string") ||
    !Number.isSafeInteger(snapshot.inputRevision) ||
    snapshot.inputRevision < 0 ||
    !Number.isSafeInteger(snapshot.layoutRevision) ||
    snapshot.layoutRevision < 0 ||
    !viewport ||
    Object.values(viewport).some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    ) ||
    ![
      "width",
      "height",
      "deviceScaleFactor",
      "scrollX",
      "scrollY",
      "visualScale",
      "visualOffsetX",
      "visualOffsetY",
    ].every((key) => key in viewport) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    viewport.deviceScaleFactor <= 0 ||
    viewport.visualScale !== 1 ||
    viewport.visualOffsetX !== 0 ||
    viewport.visualOffsetY !== 0
  )
    throw new Error(
      "Browser targeted input requires a valid, unzoomed CSS viewport; inspect again",
    );
  return snapshot;
}

export function assertBrowserInputSnapshot(
  expected: BrowserInputSnapshot,
  actual: BrowserInputSnapshot,
  options: { inputDelta?: number; allowFocusChange?: boolean } = {},
): void {
  if (
    actual.documentKey !== expected.documentKey ||
    JSON.stringify(actual.viewport) !== JSON.stringify(expected.viewport) ||
    actual.layoutRevision !== expected.layoutRevision ||
    actual.inputRevision !==
      expected.inputRevision + (options.inputDelta ?? 0) ||
    (!options.allowFocusChange &&
      (actual.focusId !== expected.focusId ||
        actual.focusBackendNodeId !== expected.focusBackendNodeId))
  )
    throw new Error(
      "Browser page, viewport, focus or input changed; inspect again before targeted input",
    );
}

export function browserInputPoint(
  snapshot: BrowserInputSnapshot,
  x: unknown,
  y: unknown,
): { x: number; y: number } {
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= snapshot.viewport.width ||
    y >= snapshot.viewport.height
  )
    throw new Error(
      "Browser input coordinates must be finite CSS pixels inside the observed viewport",
    );
  return { x, y };
}

export function browserInputKey(value: unknown): BrowserInputKey {
  if (
    typeof value !== "string" ||
    !browserInputKeys.includes(value as BrowserInputKey)
  )
    throw new Error(
      "Unsupported browser key; use one named key from the tool schema",
    );
  return value as BrowserInputKey;
}

export class BrowserInputOutcomeUnknownError extends Error {
  constructor(
    cause: unknown,
    readonly inputMayRemainPressed = true,
  ) {
    super(
      `Browser targeted input outcome is unknown after dispatch. Do not retry. ${inputMayRemainPressed ? "This tab's input is blocked; have the user close the actual browser tab to release any held input (detaching ZenX alone is not enough)." : "Both input events were acknowledged; inspect again before continuing."} ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

export interface BrowserTargetedInputPort {
  /** Synchronous session/control/document generation fence, before every send. */
  assertCurrent(): void;
  snapshot(): Promise<BrowserInputSnapshot>;
  dispatch(
    method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent",
    params: Record<string, unknown>,
    onDispatched: () => void,
  ): Promise<unknown>;
  /** Called once when the adapter confirms its first event was dispatched. */
  beforeDispatch(): void;
  quarantine(error: BrowserInputOutcomeUnknownError): void;
}

/** Two events, bounded to one observed page. A lost fence never sends a release to a successor page. */
export async function dispatchBrowserTargetedInput(
  port: BrowserTargetedInputPort,
  observed: BrowserInputSnapshot,
  action:
    | { kind: "click"; x: number; y: number }
    | { kind: "key"; key: BrowserInputKey },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  port.assertCurrent();
  const initial = requireBrowserInputSnapshot(await port.snapshot());
  assertBrowserInputSnapshot(observed, initial);
  if (
    action.kind === "key" &&
    initial.focusId === null &&
    initial.focusUnsupported
  )
    throw new BrowserInputUnsupportedError(initial.focusUnsupported);
  if (action.kind === "key" && initial.focusId === null)
    throw new Error(
      "Browser key press requires an observed focused element; click it and inspect again",
    );
  const point =
    action.kind === "click"
      ? browserInputPoint(initial, action.x, action.y)
      : undefined;
  const virtualKeys: Record<BrowserInputKey, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Backspace: 8,
    Delete: 46,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Space: 32,
  };
  const key = action.kind === "key" ? browserInputKey(action.key) : undefined;
  const method = point ? "Input.dispatchMouseEvent" : "Input.dispatchKeyEvent";
  const parameters = point
    ? { ...point, button: "left", clickCount: 1 }
    : {
        key: key === "Space" ? " " : key,
        code: key,
        windowsVirtualKeyCode: virtualKeys[key!],
      };
  let dispatched = false;
  let released = false;
  try {
    signal?.throwIfAborted();
    port.assertCurrent();
    const onDispatched = () => {
      if (!dispatched) {
        dispatched = true;
        port.beforeDispatch();
      }
    };
    await port.dispatch(
      method,
      {
        ...parameters,
        type: point
          ? "mousePressed"
          : key === "Enter" || key === "Space"
            ? "keyDown"
            : "rawKeyDown",
        ...(point
          ? { buttons: 1 }
          : key === "Enter" || key === "Space"
            ? {
                text: key === "Enter" ? "\r" : " ",
                unmodifiedText: key === "Enter" ? "\r" : " ",
              }
            : {}),
      },
      onDispatched,
    );
    signal?.throwIfAborted();
    port.assertCurrent();
    const pressed = requireBrowserInputSnapshot(await port.snapshot());
    // Keydown may legitimately scroll or move focus (e.g. ArrowDown/Tab).
    // CDP ACK and the exact target/document/control fences authorize the planned
    // release. DOM counts are only an additional interference signal: a page's
    // window capture handler may consume our press before the observer sees it
    // (including an earlier stopImmediatePropagation handler). Zero observed
    // events is not evidence that the acknowledged press failed. More than one
    // event still proves additional input; unobserved events cannot prove absence
    // of interference, so explicit host ownership fences remain authoritative.
    if (
      pressed.documentKey !== initial.documentKey ||
      pressed.inputRevision < initial.inputRevision ||
      pressed.inputRevision > initial.inputRevision + 1 ||
      (action.kind === "click" &&
        (JSON.stringify(pressed.viewport) !==
          JSON.stringify(initial.viewport) ||
          pressed.pointerHitId !== initial.pointerHitId ||
          pressed.pointerBackendNodeId !== initial.pointerBackendNodeId))
    )
      throw new Error(
        "Browser document or concurrent input changed after press",
      );
    signal?.throwIfAborted();
    port.assertCurrent();
    await port.dispatch(
      method,
      {
        ...parameters,
        type: point ? "mouseReleased" : "keyUp",
        ...(point ? { buttons: 0 } : {}),
      },
      onDispatched,
    );
    released = true;
    signal?.throwIfAborted();
    port.assertCurrent();
  } catch (cause) {
    if (!dispatched) throw cause;
    const error = new BrowserInputOutcomeUnknownError(cause, !released);
    if (!released) port.quarantine(error);
    throw error;
  }
}

import {
  resolveBrowserFrameAncestorEvidence,
  type BrowserFrameAncestorEvidence,
} from "./browser-frame-geometry.js";

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
  nativeSurfaceFallback: "use-provider-capability",
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
export interface BrowserInputFrameDocument {
  ownerId: string;
  parentDocumentKey: string;
  documentKey: string;
  viewport: BrowserInputViewport;
  geometry: {
    x: number;
    y: number;
    width: number;
    height: number;
    contentQuad?: number[];
  };
}
interface BrowserInputFrameAncestorCandidate {
  ownerId: string;
  parentDocumentKey: string;
  documentKey: string;
}
interface BrowserInputNativeFrameCandidate extends BrowserInputFrameAncestorCandidate {
  viewport: BrowserInputViewport;
  width: number;
  height: number;
  witness: string;
  contentQuad?: number[];
}
export interface BrowserInputSnapshot {
  documentKey: string;
  /** Internal local-document probe; iframe owners are resolved by the Host. */
  localFrame?: boolean;
  /** Isolated-DOM candidates only; native owner/session proof is still required. */
  frameOwnerIds?: string[];
  frameOwnerScanComplete?: boolean;
  focusFrameOwner?: boolean;
  pointerFrameOwner?: boolean;
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
  frameDocuments?: BrowserInputFrameDocument[];
  nativeFrameCandidates?: BrowserInputNativeFrameCandidate[];
  frameAncestorCandidates?: BrowserInputFrameAncestorCandidate[];
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
      `BROWSER_INPUT_UNSUPPORTED:${reason}: This surface needs frame-aware or shadow-aware targeting; use a provider capability that resolves the exact inner target`,
    );
  }
}

/** Only observed same-origin documents and trusted shadow roots are traversed. */
const browserInputElementResolutionScript = `
  const unsupported = 'frame,object,embed';
  const canHostShadow = element => element.namespaceURI === 'http://www.w3.org/1999/xhtml' && (element.localName.includes('-') || /^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/.test(element.localName));
  const nativeSurface = element => !!(element?.closest(unsupported) || element?.closest('label')?.control?.matches(unsupported));
  const resolveFocus = () => {
    let element = document.activeElement;
    for (let depth = 0; element && depth < 32; depth++) {
      if (nativeSurface(element)) return { unsupported: 'native-surface' };
      if (element.localName === 'iframe') {
        if (state.localFrame) return { element };
        const frame = state.activeFrames.get(element);
        if (!frame || element.contentDocument !== frame.document) return { unsupported: 'native-surface' };
        const next = frame.document.activeElement;
        if (!next || next === frame.document.body || next === frame.document.documentElement) return {};
        element = next;
        continue;
      }
      const root = element.shadowRoot ?? state.closedRoots.get(element);
      if (!root) return { element };
      if (!state.shadowRoots.has(root)) return { unsupported: 'shadow-surface' };
      const next = root.activeElement;
      if (!next || next === element || next.getRootNode() !== root) return { unsupported: 'shadow-surface' };
      element = next;
    }
    return element ? { unsupported: 'shadow-surface' } : {};
  };
  const resolveHit = (x, y) => {
    const rootX = x, rootY = y;
    let element = document.elementFromPoint(x, y);
    for (let depth = 0; element && depth < 32; depth++) {
      if (nativeSurface(element)) return { unsupported: 'native-surface' };
      if (element.localName === 'iframe') {
        if (state.localFrame) return { element };
        const frame = state.activeFrames.get(element);
        if (!frame || element.contentDocument !== frame.document) return { unsupported: 'native-surface' };
        if (frame.geometry.contentQuad) {
          const q = frame.geometry.contentQuad;
          const ax = q[2] - q[0], ay = q[3] - q[1];
          const bx = q[6] - q[0], by = q[7] - q[1];
          const determinant = ax * by - ay * bx;
          const dx = rootX - q[0], dy = rootY - q[1];
          x = (dx * by - dy * bx) / determinant * frame.geometry.width;
          y = (ax * dy - ay * dx) / determinant * frame.geometry.height;
          if (!Number.isFinite(x) || !Number.isFinite(y)) return { unsupported: 'native-surface' };
        } else {
          x -= frame.geometry.x;
          y -= frame.geometry.y;
        }
        if (x < 0 || y < 0 || x >= frame.geometry.width || y >= frame.geometry.height) return { unsupported: 'native-surface' };
        element = frame.document.elementFromPoint(x, y);
        if (!element || element.ownerDocument !== frame.document) return { unsupported: 'native-surface' };
        continue;
      }
      const root = element.shadowRoot ?? state.closedRoots.get(element);
      if (!root) return { element };
      if (!state.shadowRoots.has(root) || typeof root.elementFromPoint !== 'function') break;
      const next = root.elementFromPoint(x, y);
      if (!next || next === element || next.getRootNode() !== root) break;
      element = next;
    }
    return { unsupported: 'shadow-surface' };
  };
`;

/** Runs in the provider's isolated world; the page cannot forge the registry.
 * Child documents share this registry, never their main-world globals. */
function browserInputSnapshotSource(localFrame = false): string {
  return `(() => {
  const localFrame = ${JSON.stringify(localFrame)};
  const key = Symbol.for("zenx-browser-targeted-input-v2");
  const randomId = () => [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8, "0")).join("");
  let state = globalThis[key];
  if (!state || state.document !== document || !(state.documents instanceof Map) || Boolean(state.localFrame) !== localFrame) {
    // Older isolated registries may survive an attachment replacement. Retire
    // their observer and mint new IDs; their old listener counters are never read.
    state?.observer?.disconnect();
    for (const entry of state?.documents?.values?.() ?? []) { entry.observer?.disconnect(); for (const { target, type, listener } of entry.listeners ?? []) target.removeEventListener(type, listener, true); }
    state = { document, localFrame, id: randomId(), nodes: new WeakMap(), next: 1, inputRevision: 0, layoutRevision: 0, shadowRoots: new WeakSet(), shadowRootCount: 0, documents: new Map() };
    globalThis[key] = state;
  }
  state.closedRoots ??= new WeakMap();
  state.nativeFrames ??= new WeakMap();
  state.nativeFrameCandidates = new Map();
  state.frameAncestorCandidates = new Map();
  const nodeId = node => {
    let id = state.nodes.get(node);
    if (!id) { id = state.id + ":" + state.next++; state.nodes.set(node, id); }
    return id;
  };
  const viewport = view => ({ width: view.innerWidth, height: view.innerHeight, deviceScaleFactor: view.devicePixelRatio, scrollX: view.scrollX, scrollY: view.scrollY, visualScale: view.visualViewport?.scale ?? 1, visualOffsetX: view.visualViewport?.offsetLeft ?? 0, visualOffsetY: view.visualViewport?.offsetTop ?? 0 });
  const unzoomed = value => Object.values(value).every(Number.isFinite) && value.width > 0 && value.height > 0 && value.deviceScaleFactor > 0 && value.visualScale === 1 && value.visualOffsetX === 0 && value.visualOffsetY === 0;
  const decoration = node => node?.nodeType === 1 && (node.matches('[data-zenx-agent-pointer]') || node.closest('[data-zenx-agent-pointer]'));
  const observeDocument = doc => {
    let entry = state.documents.get(doc);
    if (entry) {
      // document.open() can retain Document identity while erasing listeners.
      // Re-adding the same callbacks/capture flag is idempotent in the DOM.
      for (const { target, type, listener } of entry.listeners) target.addEventListener(type, listener, true);
      return entry;
    }
    const view = doc.defaultView;
    const listeners = [];
    entry = { document: doc, id: doc === document ? state.id : randomId(), roots: new WeakSet(), shadowRootCount: 0, listeners };
    entry.recordMutations = records => {
      if (records.some(record => !decoration(record.target) && !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].length > 0 && [...record.addedNodes, ...record.removedNodes].every(decoration)))) state.layoutRevision++;
    };
    entry.observer = new MutationObserver(entry.recordMutations);
    entry.observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    entry.listen = (target, type, listener) => { target.addEventListener(type, listener, true); listeners.push({ target, type, listener }); };
    for (const type of ["pointerdown", "pointerup", "keydown", "keyup", "wheel"]) entry.listen(doc, type, event => { if (event.isTrusted) state.inputRevision++; });
    for (const type of ["scroll", "resize"]) entry.listen(view, type, () => state.layoutRevision++);
    state.documents.set(doc, entry);
    return entry;
  };
  state.observeShadowRoot = root => {
    const entry = state.documents.get(root.ownerDocument);
    if (!entry) return false;
    if (!entry.roots.has(root)) {
      if (state.shadowRootCount >= 128) return false;
      entry.roots.add(root);
      entry.shadowRootCount++;
      state.shadowRootCount++;
      state.layoutRevision++;
      entry.observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      entry.listen(root, 'scroll', () => state.layoutRevision++);
    }
    return true;
  };
  // Only static 2D transform matrices use native geometry. Layout origins,
  // ancestor transforms and scroll are never reconstructed from CSS matrices.
  const frameGeometry = (element, childViewport) => {
    const view = element.ownerDocument.defaultView;
    let ancestor = element, transformed = false, animated = false;
    const styles = [];
    for (let depth = 0; ancestor; depth++) {
      if (depth >= 128) return;
      const style = view.getComputedStyle(ancestor);
      if (['translate', 'rotate', 'scale', 'perspective', 'offsetPath'].some(property => style[property] && style[property] !== 'none') || (style.zoom && style.zoom !== '1' && style.zoom !== 'normal') || (style.transformStyle && style.transformStyle !== 'flat')) return;
      const transform = style.transform || 'none';
      if (transform !== 'none') {
        if (!transform.startsWith('matrix(') || !transform.endsWith(')')) return;
        const matrix = transform.slice(7, -1).split(',').map(Number);
        if (matrix.length !== 6 || !matrix.every(Number.isFinite) || matrix[0] * matrix[3] - matrix[1] * matrix[2] === 0) return;
        transformed = true;
      }
      if (typeof ancestor.getAnimations === 'function' && ancestor.getAnimations().some(animation => animation.playState === 'running' || animation.pending)) animated = true;
      styles.push([transform, style.transformOrigin || '']);
      ancestor = ancestor.assignedSlot ?? ancestor.parentElement ?? ancestor.getRootNode()?.host;
    }
    if (transformed && animated) return;
    const style = view.getComputedStyle(element);
    const pixel = property => { const value = Number.parseFloat(style[property] || '0'); return Number.isFinite(value) && value >= 0 ? value : NaN; };
    const left = pixel('borderLeftWidth') + pixel('paddingLeft');
    const top = pixel('borderTopWidth') + pixel('paddingTop');
    const right = pixel('borderRightWidth') + pixel('paddingRight');
    const bottom = pixel('borderBottomWidth') + pixel('paddingBottom');
    const rect = element.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height, left, top, right, bottom].every(Number.isFinite)) return;
    if (transformed) {
      const width = pixel('width') - (style.boxSizing === 'border-box' ? left + right : 0);
      const height = pixel('height') - (style.boxSizing === 'border-box' ? top + bottom : 0);
      if (width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height) || Math.abs(width - childViewport.width) > 0.01 || Math.abs(height - childViewport.height) > 0.01) return;
      return { native: true, width, height, witness: JSON.stringify([styles, rect.left, rect.top, rect.width, rect.height, left, top, right, bottom, width, height]) };
    }
    const geometry = { x: rect.left + left, y: rect.top + top, width: rect.width - left - right, height: rect.height - top - bottom };
    if (!Object.values(geometry).every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0 || Math.abs(geometry.width - childViewport.width) > 0.01 || Math.abs(geometry.height - childViewport.height) > 0.01) return;
    return { geometry };
  };
  const roots = [{ root: document, doc: document, depth: 0 }];
  const activeDocuments = new Set([document]);
  const frameDocuments = [];
  const frameOwnerIds = [];
  let frameOwnerScanComplete = true;
  const nativeFrameCandidates = [];
  const frameAncestorCandidates = [];
  state.activeFrames = new WeakMap();
  state.shadowRoots = new WeakSet();
  observeDocument(document);
  let budget = 8192;
  for (let index = 0; index < roots.length && budget > 0; index++) {
    const { root, doc, depth } = roots[index];
    const entry = state.documents.get(doc);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let element;
    while (budget-- > 0 && (element = walker.nextNode())) {
      const shadow = element.shadowRoot ?? state.closedRoots.get(element);
      if (shadow) {
        if (state.observeShadowRoot(shadow)) {
          state.shadowRoots.add(shadow);
          roots.push({ root: shadow, doc, depth });
        } else frameOwnerScanComplete = false;
      }
      if (element.localName === 'iframe') frameOwnerIds.push(nodeId(element));
      if (localFrame || element.localName !== 'iframe' || depth >= 8 || activeDocuments.size >= 32) continue;
      try {
        const child = element.contentDocument;
        const view = child?.defaultView;
        if (!child || !view || view.document !== child || activeDocuments.has(child)) continue;
        // Access itself enforces same-origin, including sandboxed opaque frames.
        const url = view.location.href;
        const childViewport = viewport(view);
        if (!unzoomed(childViewport)) continue;
        const mapping = frameGeometry(element, childViewport);
        if (!mapping) continue;
        const childEntry = observeDocument(child);
        activeDocuments.add(child);
        const identity = { ownerId: nodeId(element), parentDocumentKey: entry.id + "|" + doc.defaultView.location.href, documentKey: childEntry.id + "|" + url, viewport: childViewport };
        const ancestry = { ownerId: identity.ownerId, parentDocumentKey: identity.parentDocumentKey, documentKey: identity.documentKey };
        frameAncestorCandidates.push(ancestry);
        state.frameAncestorCandidates.set(identity.ownerId, { element, document: child, candidate: ancestry });
        let geometry = mapping.geometry;
        if (mapping.native) {
          const pinned = state.nativeFrames.get(element);
          const contentQuad = pinned?.document === child && pinned.witness === mapping.witness ? pinned.contentQuad : undefined;
          const candidate = { ...identity, width: mapping.width, height: mapping.height, witness: mapping.witness, ...(contentQuad ? { contentQuad } : {}) };
          nativeFrameCandidates.push(candidate);
          state.nativeFrameCandidates.set(identity.ownerId, { element, document: child, candidate });
          if (!contentQuad) continue;
          geometry = { x: contentQuad[0], y: contentQuad[1], width: mapping.width, height: mapping.height, contentQuad };
        }
        state.activeFrames.set(element, { document: child, geometry });
        frameDocuments.push({ ...identity, geometry });
        roots.push({ root: child, doc: child, depth: depth + 1 });
      } catch {
        // Cross-origin/OOPIF and inaccessible frames stay explicitly unsupported.
      }
    }
  }
  if (budget <= 0) frameOwnerScanComplete = false;
  for (const [doc, entry] of state.documents) {
    entry.recordMutations(entry.observer.takeRecords());
    if (activeDocuments.has(doc)) continue;
    entry.observer.disconnect();
    for (const { target, type, listener } of entry.listeners) target.removeEventListener(type, listener, true);
    state.shadowRootCount -= entry.shadowRootCount;
    state.documents.delete(doc);
  }
  ${browserInputElementResolutionScript}
  const focus = resolveFocus();
  const focused = focus.element;
  state.focusNode = focused;
  let focusId = null;
  if (focused && focused !== focused.ownerDocument.body && focused !== focused.ownerDocument.documentElement) focusId = nodeId(focused);
  return {
    documentKey: state.id + "|" + location.href,
    ...(localFrame ? { localFrame: true, ...(focused?.localName === 'iframe' ? { focusFrameOwner: true } : {}) } : {}),
    viewport: viewport(globalThis),
    focusId, ...(focusId && canHostShadow(focused) ? { focusNeedsShadowEvidence: true } : {}), ...(focus.unsupported ? { focusUnsupported: focus.unsupported } : {}), inputRevision: state.inputRevision, layoutRevision: state.layoutRevision,
    frameDocuments, frameOwnerIds, frameOwnerScanComplete, ...(nativeFrameCandidates.length ? { nativeFrameCandidates } : {}), ...(frameAncestorCandidates.length ? { frameAncestorCandidates } : {}),
  };
})()`;
}

export const browserInputSnapshotScript = browserInputSnapshotSource();
export const browserFrameInputSnapshotScript = browserInputSnapshotSource(true);

export function browserInputProbeScript(
  action:
    | { kind: "click"; x: number; y: number }
    | { kind: "key"; key: BrowserInputKey },
  localFrame = false,
): string {
  const snapshotScript = localFrame
    ? browserFrameInputSnapshotScript
    : browserInputSnapshotScript;
  if (action.kind !== "click") return snapshotScript;
  if (![action.x, action.y].every(Number.isFinite))
    throw new Error("Browser pointer coordinates must be finite numbers");
  return `(() => {
    const snapshot = ${snapshotScript};
    const state = globalThis[Symbol.for("zenx-browser-targeted-input-v2")];
    ${browserInputElementResolutionScript}
    const hit = resolveHit(${JSON.stringify(action.x)}, ${JSON.stringify(action.y)});
    if (hit.unsupported) return { browserInputUnsupported: hit.unsupported };
    const element = hit.element;
    state.hitNode = element;
    let pointerHitId = state.nodes.get(element);
    if (!pointerHitId) { pointerHitId = state.id + ":" + state.next++; state.nodes.set(element, pointerHitId); }
    return { ...snapshot, pointerHitId, ...(state.localFrame && element.localName === 'iframe' ? { pointerFrameOwner: true } : {}), ...(canHostShadow(element) ? { pointerNeedsShadowEvidence: true } : {}), pointerPoint: { x: ${JSON.stringify(action.x)}, y: ${JSON.stringify(action.y)} } };
  })()`;
}

export function includesBrowserInputSnapshot(expression: string): boolean {
  return expression.includes('Symbol.for("zenx-browser-targeted-input-v2")');
}

type BrowserInputCommand = (
  method:
    | "Runtime.evaluate"
    | "DOM.describeNode"
    | "DOM.getBoxModel"
    | "DOM.resolveNode"
    | "Runtime.callFunctionOn"
    | "Runtime.releaseObject",
  params: Record<string, unknown>,
) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Native quad corners retain their layout order, including reflected transforms. */
export function requireBrowserInputContentQuad(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 8 ||
    value.some(
      (coordinate) =>
        typeof coordinate !== "number" || !Number.isFinite(coordinate),
    )
  )
    throw new Error("Browser iframe content quad is unavailable or malformed");
  const q = value as number[];
  const ax = q[2]! - q[0]!,
    ay = q[3]! - q[1]!;
  const bx = q[6]! - q[0]!,
    by = q[7]! - q[1]!;
  const determinant = ax * by - ay * bx;
  const magnitude = Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
  // Native floats may round individual corners. A projective shape is never
  // approximated: CSS ancestry must independently prove a 2D-only transform.
  if (
    !Number.isFinite(determinant) ||
    !Number.isFinite(magnitude) ||
    magnitude <= 0 ||
    Math.abs(determinant) <= 1e-8 ||
    (magnitude * magnitude) / Math.abs(determinant) > 1e6 ||
    Math.abs(q[4]! - q[2]! - q[6]! + q[0]!) > 0.01 ||
    Math.abs(q[5]! - q[3]! - q[7]! + q[1]!) > 0.01
  )
    throw new Error(
      "Browser iframe content quad is not a usable affine mapping",
    );
  return [...q];
}

/** Exact native geometry is re-read for every probe, never trusted as a cache. */
async function resolveBrowserInputFrameEvidence(
  snapshot: BrowserInputSnapshot,
  send: BrowserInputCommand,
  releaseOwnedObject: (objectId: string) => Promise<unknown>,
): Promise<void> {
  const candidates = snapshot.frameAncestorCandidates;
  if (!candidates?.length) return;
  const probe = snapshot.pointerPoint
    ? browserInputProbeScript({ kind: "click", ...snapshot.pointerPoint })
    : browserInputSnapshotScript;
  const expected = JSON.stringify(snapshot);
  const owned = new Set<string>();
  const evidence: {
    candidate: BrowserInputFrameAncestorCandidate;
    native?: BrowserInputNativeFrameCandidate;
    backendNodeId: number;
    contentQuad?: number[];
    ancestry: BrowserFrameAncestorEvidence;
  }[] = [];
  const resultValue = (response: unknown) => {
    const result = record(response);
    if (!result || result.exceptionDetails !== undefined)
      throw new Error("Browser iframe geometry evaluation failed");
    return record(result.result);
  };
  const release = async () => {
    const objectIds = [...owned];
    owned.clear();
    await Promise.all(
      objectIds.map(async (objectId) => {
        try {
          await releaseOwnedObject(objectId);
        } catch {
          /* Exact-session cleanup is never retried after an unknown result. */
        }
      }),
    );
  };
  const describe = async (
    params: Record<string, unknown>,
    expectedId?: number,
  ) => {
    const node = record(
      record(
        await send("DOM.describeNode", { ...params, depth: 0, pierce: false }),
      )?.node,
    );
    if (
      !node ||
      node.nodeType !== 1 ||
      node.localName !== "iframe" ||
      !Number.isSafeInteger(node.backendNodeId) ||
      (node.backendNodeId as number) <= 0 ||
      (expectedId !== undefined && node.backendNodeId !== expectedId)
    )
      throw new Error(
        "Browser iframe native identity changed or is unavailable",
      );
    return node.backendNodeId as number;
  };
  const quad = async (params: Record<string, unknown>) =>
    requireBrowserInputContentQuad(
      record(record(await send("DOM.getBoxModel", params))?.model)?.content,
    );
  const confirm = async () => {
    const current = resultValue(
      await send("Runtime.evaluate", {
        expression: probe,
        returnByValue: true,
        awaitPromise: false,
      }),
    )?.value;
    if (JSON.stringify(current) !== expected)
      throw new Error(
        "Browser iframe observation changed during geometry verification; inspect again",
      );
  };
  try {
    for (const candidate of candidates) {
      const expression = `(() => {
        const state = globalThis[Symbol.for("zenx-browser-targeted-input-v2")];
        const entry = state?.frameAncestorCandidates?.get(${JSON.stringify(candidate.ownerId)});
        return state?.document === document && state.id + "|" + location.href === ${JSON.stringify(snapshot.documentKey)} && entry?.element?.isConnected && entry.element.contentDocument === entry.document && JSON.stringify(entry.candidate) === ${JSON.stringify(JSON.stringify(candidate))} ? entry.element : null;
      })()`;
      const object = resultValue(
        await send("Runtime.evaluate", {
          expression,
          returnByValue: false,
          awaitPromise: false,
        }),
      );
      if (typeof object?.objectId === "string" && object.objectId)
        owned.add(object.objectId);
      if (
        object?.subtype !== "node" ||
        typeof object.objectId !== "string" ||
        !object.objectId
      )
        throw new Error(
          "Browser iframe candidate changed before native geometry verification",
        );
      const params = { objectId: object.objectId };
      const backendNodeId = await describe(params);
      const ancestry = await resolveBrowserFrameAncestorEvidence(
        object.objectId,
        send,
        releaseOwnedObject,
      );
      const native = snapshot.nativeFrameCandidates?.find(
        (frame) => frame.ownerId === candidate.ownerId,
      );
      evidence.push({
        candidate,
        native,
        backendNodeId,
        ancestry,
        ...(native ? { contentQuad: await quad(params) } : {}),
      });
    }
    await release();
    await confirm();
    for (const entry of evidence) {
      const params = { backendNodeId: entry.backendNodeId };
      await entry.ancestry.recheckNative();
      await describe(params, entry.backendNodeId);
      if (
        entry.native &&
        JSON.stringify(await quad(params)) !== JSON.stringify(entry.contentQuad)
      )
        throw new Error(
          "Browser iframe geometry changed during native verification; inspect again",
        );
    }
    await confirm();
    const updates = evidence.filter(
      (entry) =>
        entry.native &&
        JSON.stringify(entry.native.contentQuad) !==
          JSON.stringify(entry.contentQuad),
    );
    if (updates.length) {
      const expression = `(() => {
        const current = ${probe};
        if (JSON.stringify(current) !== ${JSON.stringify(expected)}) throw new Error('Browser iframe changed before geometry registration');
        const state = globalThis[Symbol.for("zenx-browser-targeted-input-v2")];
        const updates = ${JSON.stringify(updates.map((entry) => ({ ownerId: entry.candidate.ownerId, contentQuad: entry.contentQuad })))};
        for (const update of updates) {
          const entry = state.nativeFrameCandidates.get(update.ownerId);
          if (!entry?.element?.isConnected || entry.element.contentDocument !== entry.document) throw new Error('Browser iframe changed before geometry registration');
        }
        for (const update of updates) {
          const entry = state.nativeFrameCandidates.get(update.ownerId);
          state.nativeFrames.set(entry.element, { document: entry.document, witness: entry.candidate.witness, contentQuad: update.contentQuad });
        }
        state.layoutRevision++;
        return true;
      })()`;
      if (
        resultValue(
          await send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: false,
          }),
        )?.value !== true
      )
        throw new Error(
          "Browser iframe geometry registration was not confirmed",
        );
      throw new Error(
        "Browser iframe geometry observation initialized or changed; inspect again before targeted input",
      );
    }
  } finally {
    await release();
  }
}

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
  try {
    await resolveBrowserInputFrameEvidence(snapshot, send, releaseOwnedObject);
  } catch (error) {
    if (nested) return { ...outer, inputSnapshot: undefined };
    throw error;
  }
  if (
    !snapshot.focusNeedsShadowEvidence &&
    !snapshot.pointerNeedsShadowEvidence
  )
    return value;
  const point = snapshot.pointerPoint;
  const probe = point
    ? browserInputProbeScript(
        { kind: "click", ...point },
        snapshot.localFrame === true,
      )
    : snapshot.localFrame
      ? browserFrameInputSnapshotScript
      : browserInputSnapshotScript;
  const owned: {
    objectId: string;
    role: "focus" | "pointer";
    id: string;
    backendNodeId?: number;
    reason?: BrowserInputUnsupportedReason;
  }[] = [];
  const liveObjects = new Set<string>();
  const readValue = (response: unknown) => {
    const result = record(response);
    if (!result || result.exceptionDetails !== undefined)
      throw new Error("Browser input surface evidence evaluation failed");
    return record(result.result);
  };
  let released = false;
  const release = async () => {
    released = true;
    const objectIds = [...liveObjects];
    liveObjects.clear();
    await Promise.all(
      objectIds.map(async (objectId) => {
        try {
          await releaseOwnedObject(objectId);
        } catch {
          /* Best-effort exact-session cleanup; unknown release is never retried. */
        }
      }),
    );
  };
  const registerClosedRoot = async (
    entry: (typeof owned)[number],
    root: Record<string, unknown>,
  ) => {
    if (
      root.nodeType !== 11 ||
      !Number.isSafeInteger(root.backendNodeId) ||
      (root.backendNodeId as number) <= 0
    )
      throw new Error(
        "Browser closed shadow identity is unavailable or malformed",
      );
    const response = record(
      await send("DOM.resolveNode", { backendNodeId: root.backendNodeId }),
    );
    const object = record(response?.object);
    if (typeof object?.objectId === "string" && object.objectId)
      liveObjects.add(object.objectId);
    if (
      object?.subtype !== "node" ||
      typeof object.objectId !== "string" ||
      !object.objectId
    )
      throw new Error(
        "Browser closed shadow wrapper is unavailable or malformed",
      );
    const result = readValue(
      await send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function(documentKey, nodeId, role) {
          const state = globalThis[Symbol.for("zenx-browser-targeted-input-v2")];
          const host = state?.[role === 'focus' ? 'focusNode' : 'hitNode'];
          if (state?.document !== document || state.id + '|' + location.href !== documentKey || !host?.isConnected || state.nodes.get(host) !== nodeId || this.nodeType !== 11 || this.mode !== 'closed' || this.host !== host || this.ownerDocument !== host.ownerDocument || !this.isConnected || !state.documents.has(host.ownerDocument)) throw new Error('Browser closed shadow candidate changed before registration');
          if (!state.observeShadowRoot(this)) return false;
          state.closedRoots.set(host, this);
          return true;
        }`,
        arguments: [
          { value: snapshot.documentKey },
          { value: entry.id },
          { value: entry.role },
        ],
        returnByValue: true,
        awaitPromise: false,
      }),
    );
    if (result?.value === false)
      throw new BrowserInputUnsupportedError("shadow-surface");
    if (result?.value !== true)
      throw new Error("Browser closed shadow registration was not confirmed");
    // This observer did not exist when the authorizing screenshot was taken.
    // Keep its bounded registry entry, but never reuse that screenshot for input.
    throw new Error(
      "Browser closed shadow observation initialized; inspect again before targeted input",
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
    const closed = Array.isArray(roots)
      ? roots.map(record).find((root) => root?.shadowRootType === "closed")
      : undefined;
    if (closed) await registerClosedRoot(entry, closed);
    // Ordinary HTML controls (including native pickers) accept CDP input on
    // the observed page. Embedded documents still need inner-target evidence.
    if (["iframe", "frame", "object", "embed"].includes(node.localName))
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
      liveObjects.add(result.objectId);
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
  if (
    snapshot.frameOwnerScanComplete !== undefined &&
    typeof snapshot.frameOwnerScanComplete !== "boolean"
  )
    throw new Error("Browser iframe owner scan metadata is invalid");
  if (
    snapshot.frameOwnerIds !== undefined &&
    (!Array.isArray(snapshot.frameOwnerIds) ||
      snapshot.frameOwnerIds.length > 31 ||
      new Set(snapshot.frameOwnerIds).size !== snapshot.frameOwnerIds.length ||
      snapshot.frameOwnerIds.some(
        (id) => typeof id !== "string" || id.length === 0 || id.length > 128,
      ))
  )
    throw new Error(
      "Browser iframe owner candidates are unavailable or exceed their bound",
    );
  if (snapshot.frameDocuments !== undefined) {
    const frames = snapshot.frameDocuments;
    if (!Array.isArray(frames) || frames.length > 31)
      throw new Error(
        "Browser input frame evidence is unavailable or malformed",
      );
    const documents = new Set([snapshot.documentKey]);
    const owners = new Set<string>();
    for (const frame of frames) {
      if (
        !frame ||
        typeof frame.ownerId !== "string" ||
        frame.ownerId.length === 0 ||
        frame.ownerId.length > 128 ||
        owners.has(frame.ownerId) ||
        typeof frame.documentKey !== "string" ||
        frame.documentKey.length < 32 ||
        frame.documentKey.length > 16_384 ||
        documents.has(frame.documentKey) ||
        !documents.has(frame.parentDocumentKey) ||
        !frame.geometry ||
        !["x", "y", "width", "height"].every((key) =>
          Number.isFinite(
            frame.geometry[key as "x" | "y" | "width" | "height"],
          ),
        ) ||
        frame.geometry.width <= 0 ||
        frame.geometry.height <= 0
      )
        throw new Error(
          "Browser input frame evidence is unavailable or malformed",
        );
      requireBrowserInputSnapshot({
        documentKey: frame.documentKey,
        viewport: frame.viewport,
        focusId: null,
        inputRevision: 0,
        layoutRevision: 0,
      });
      if (
        Math.abs(frame.geometry.width - frame.viewport.width) > 0.01 ||
        Math.abs(frame.geometry.height - frame.viewport.height) > 0.01
      )
        throw new Error(
          "Browser input frame geometry is unavailable or malformed",
        );
      if (frame.geometry.contentQuad !== undefined)
        requireBrowserInputContentQuad(frame.geometry.contentQuad);
      documents.add(frame.documentKey);
      owners.add(frame.ownerId);
    }
  }
  if (snapshot.nativeFrameCandidates !== undefined) {
    const candidates = snapshot.nativeFrameCandidates;
    if (!Array.isArray(candidates) || candidates.length > 31)
      throw new Error("Browser native iframe evidence is malformed");
    const owners = new Set<string>();
    const documents = new Set([
      snapshot.documentKey,
      ...(snapshot.frameDocuments ?? []).map((frame) => frame.documentKey),
    ]);
    for (const candidate of candidates) {
      if (
        !candidate ||
        typeof candidate.ownerId !== "string" ||
        !candidate.ownerId ||
        candidate.ownerId.length > 128 ||
        owners.has(candidate.ownerId) ||
        !documents.has(candidate.parentDocumentKey) ||
        typeof candidate.documentKey !== "string" ||
        candidate.documentKey.length < 32 ||
        candidate.documentKey.length > 16_384 ||
        typeof candidate.witness !== "string" ||
        candidate.witness.length > 131_072 ||
        !Number.isFinite(candidate.width) ||
        !Number.isFinite(candidate.height) ||
        candidate.width <= 0 ||
        candidate.height <= 0
      )
        throw new Error("Browser native iframe evidence is malformed");
      requireBrowserInputSnapshot({
        documentKey: candidate.documentKey,
        viewport: candidate.viewport,
        focusId: null,
        inputRevision: 0,
        layoutRevision: 0,
      });
      if (
        Math.abs(candidate.width - candidate.viewport.width) > 0.01 ||
        Math.abs(candidate.height - candidate.viewport.height) > 0.01
      )
        throw new Error("Browser native iframe content size is ambiguous");
      if (candidate.contentQuad !== undefined)
        requireBrowserInputContentQuad(candidate.contentQuad);
      owners.add(candidate.ownerId);
    }
  }
  if (snapshot.frameAncestorCandidates !== undefined) {
    const candidates = snapshot.frameAncestorCandidates;
    const documents = new Set([
      snapshot.documentKey,
      ...(snapshot.frameDocuments ?? []).map((frame) => frame.documentKey),
    ]);
    const owners = new Set<string>();
    if (!Array.isArray(candidates) || candidates.length > 31)
      throw new Error("Browser iframe ancestor candidates are malformed");
    for (const candidate of candidates) {
      if (
        !candidate ||
        typeof candidate.ownerId !== "string" ||
        !candidate.ownerId ||
        candidate.ownerId.length > 128 ||
        owners.has(candidate.ownerId) ||
        !documents.has(candidate.parentDocumentKey) ||
        typeof candidate.documentKey !== "string" ||
        candidate.documentKey.length < 32 ||
        candidate.documentKey.length > 16384
      )
        throw new Error(
          "Browser iframe ancestor candidate identity is malformed",
        );
      owners.add(candidate.ownerId);
    }
  }
  return snapshot;
}

export function assertBrowserInputSnapshot(
  expected: BrowserInputSnapshot,
  actual: BrowserInputSnapshot,
  options: { inputDelta?: number; allowFocusChange?: boolean } = {},
): void {
  if (
    actual.documentKey !== expected.documentKey ||
    actual.frameOwnerScanComplete !== expected.frameOwnerScanComplete ||
    JSON.stringify(actual.frameOwnerIds ?? []) !==
      JSON.stringify(expected.frameOwnerIds ?? []) ||
    JSON.stringify(actual.viewport) !== JSON.stringify(expected.viewport) ||
    JSON.stringify(actual.frameDocuments ?? []) !==
      JSON.stringify(expected.frameDocuments ?? []) ||
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

function sameBrowserInputFrameDocuments(
  before: BrowserInputSnapshot,
  after: BrowserInputSnapshot,
  allowLayoutChange: boolean,
): boolean {
  const identity = (frame: BrowserInputFrameDocument) => ({
    ownerId: frame.ownerId,
    parentDocumentKey: frame.parentDocumentKey,
    documentKey: frame.documentKey,
  });
  return (
    JSON.stringify(
      (before.frameDocuments ?? []).map((frame) =>
        allowLayoutChange ? identity(frame) : frame,
      ),
    ) ===
    JSON.stringify(
      (after.frameDocuments ?? []).map((frame) =>
        allowLayoutChange ? identity(frame) : frame,
      ),
    )
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
      !sameBrowserInputFrameDocuments(
        initial,
        pressed,
        action.kind === "key",
      ) ||
      (action.kind === "key" && pressed.focusUnsupported !== undefined) ||
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

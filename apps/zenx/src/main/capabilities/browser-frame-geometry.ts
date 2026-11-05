/** Ephemeral coordinate evidence. These values never select a frame or send input. */
export interface BrowserFrameAffineTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface BrowserFramePoint {
  readonly x: number;
  readonly y: number;
}

export interface BrowserFrameOwnerWitness {
  readonly documentKey: string;
  readonly ownerId: string;
  readonly width: number;
  readonly height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly borderLeft: number;
  readonly borderTop: number;
  readonly borderRight: number;
  readonly borderBottom: number;
  readonly paddingLeft: number;
  readonly paddingTop: number;
  readonly paddingRight: number;
  readonly paddingBottom: number;
  readonly styleWitness: string;
}

export type BrowserFrameAncestorCommand = (
  method:
    "Runtime.callFunctionOn" | "DOM.describeNode" | "Runtime.releaseObject",
  params: Record<string, unknown>,
) => Promise<unknown>;

const ancestorChainBody = `
  const state = globalThis[Symbol.for("zenx-browser-targeted-input-v2")];
  const ownerDocument = this?.ownerDocument;
  const ownerEntry = state?.documents?.get(ownerDocument);
  if (!state || state.document !== document || !ownerEntry || !this || this.nodeType !== 1 || this.localName !== 'iframe' || !this.isConnected) throw new Error('Browser iframe owner or document changed');
  const nodes = [], ancestors = [];
  let node = this, edge = 'owner';
  for (let depth = 0; node; depth++) {
    if (depth >= 128 || node.nodeType !== 1 || !node.isConnected || node.ownerDocument !== ownerDocument) throw new Error('Browser iframe ancestry is unavailable');
    let nodeId = state.nodes.get(node);
    if (!nodeId) { nodeId = state.id + ':' + state.next++; state.nodes.set(node, nodeId); }
    nodes.push(node);
    ancestors.push({ nodeId, edge });
    if (node.assignedSlot) { node = node.assignedSlot; edge = 'slot'; }
    else if (node.parentElement) { node = node.parentElement; edge = 'light'; }
    else { node = node.getRootNode()?.host; edge = 'host'; }
  }
  const facts = { rootDocumentKey: state.id + '|' + location.href, documentKey: ownerEntry.id + '|' + ownerDocument.defaultView.location.href, ancestors };
`;

/**
 * Native shadow metadata closes the assignedSlot=null ambiguity for undiscovered
 * closed roots. The caller owns ownerObjectId and supplies its exact fenced route.
 * This helper releases only wrappers it creates, before its final native checks.
 */
export interface BrowserFrameAncestorEvidence {
  /** Recheck after the caller releases its owner wrappers, before its final DOM probe. */
  recheckNative(): Promise<void>;
}

export async function resolveBrowserFrameAncestorEvidence(
  ownerObjectId: string,
  send: BrowserFrameAncestorCommand,
  releaseOwnedObject: (objectId: string) => Promise<unknown> = (objectId) =>
    send("Runtime.releaseObject", { objectId }),
): Promise<BrowserFrameAncestorEvidence> {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const owned = new Set<string>();
  const readResult = (response: unknown) => {
    const value = record(response);
    if (!value || value.exceptionDetails !== undefined)
      throw new Error(
        "Browser iframe ancestor identity changed or is unavailable",
      );
    return record(value.result);
  };
  const readChain = async () =>
    readResult(
      await send("Runtime.callFunctionOn", {
        objectId: ownerObjectId,
        functionDeclaration: `function() { ${ancestorChainBody} return facts; }`,
        returnByValue: true,
        awaitPromise: false,
      }),
    )?.value;
  const chainIdentity = (value: unknown) => {
    const facts = record(value);
    const ancestors = facts?.ancestors;
    if (
      !facts ||
      Object.keys(facts).length !== 3 ||
      !["rootDocumentKey", "documentKey", "ancestors"].every((key) =>
        Object.hasOwn(facts, key),
      ) ||
      typeof facts.documentKey !== "string" ||
      facts.documentKey.length < 32 ||
      facts.documentKey.length > 16384 ||
      typeof facts.rootDocumentKey !== "string" ||
      facts.rootDocumentKey.length < 32 ||
      facts.rootDocumentKey.length > 16384 ||
      !Array.isArray(ancestors) ||
      ancestors.length === 0 ||
      ancestors.length > 128 ||
      ancestors.some((value, index) => {
        const entry = record(value);
        return (
          !entry ||
          Object.keys(entry).length !== 2 ||
          !Object.hasOwn(entry, "nodeId") ||
          !Object.hasOwn(entry, "edge") ||
          typeof entry.nodeId !== "string" ||
          entry.nodeId.length === 0 ||
          entry.nodeId.length > 128 ||
          typeof entry.edge !== "string" ||
          (index === 0
            ? entry.edge !== "owner"
            : !["slot", "light", "host"].includes(entry.edge))
        );
      })
    )
      throw new Error("Browser iframe ancestor evidence is malformed");
    // Native debugger transports may reorder dictionary keys. Identity is the
    // exact validated content and ordered chain, never object insertion order.
    return {
      ancestors,
      fingerprint: JSON.stringify([
        facts.rootDocumentKey,
        facts.documentKey,
        ancestors.map((entry) => [record(entry)!.nodeId, record(entry)!.edge]),
      ]),
    };
  };
  const initial = chainIdentity(await readChain());
  const ancestors = initial.ancestors;
  const expected = initial.fingerprint;
  const backendIds: number[] = [];
  const release = async () => {
    const ids = [...owned];
    owned.clear();
    await Promise.all(
      ids.map(async (objectId) => {
        try {
          await releaseOwnedObject(objectId);
        } catch {
          /* Exact-session cleanup is best-effort and never retried. */
        }
      }),
    );
  };
  const describe = async (index: number, params: Record<string, unknown>) => {
    const node = record(
      record(
        await send("DOM.describeNode", { ...params, depth: 0, pierce: false }),
      )?.node,
    );
    if (
      !node ||
      node.nodeType !== 1 ||
      typeof node.localName !== "string" ||
      (index === 0 && node.localName !== "iframe") ||
      !Number.isSafeInteger(node.backendNodeId) ||
      (node.backendNodeId as number) <= 0 ||
      (backendIds[index] !== undefined &&
        backendIds[index] !== node.backendNodeId)
    )
      throw new Error(
        "Browser iframe ancestor native identity changed or is unavailable",
      );
    const roots = node.shadowRoots;
    if (
      roots !== undefined &&
      (!Array.isArray(roots) ||
        roots.length > 1 ||
        roots.some(
          (root) =>
            !record(root) ||
            !["open", "closed", "user-agent"].includes(
              String(record(root)?.shadowRootType),
            ),
        ))
    )
      throw new Error("Browser iframe ancestor shadow evidence is malformed");
    if (
      Array.isArray(roots) &&
      roots.length &&
      record(ancestors[index])?.edge === "light"
    )
      throw new Error("Browser iframe shadow-slot ancestry is unresolved");
    return node.backendNodeId as number;
  };
  const confirm = async () => {
    if (chainIdentity(await readChain()).fingerprint !== expected)
      throw new Error(
        "Browser iframe ancestor chain changed during native verification",
      );
  };
  try {
    for (let index = 0; index < ancestors.length; index++) {
      let objectId = ownerObjectId;
      if (index > 0) {
        const object = readResult(
          await send("Runtime.callFunctionOn", {
            objectId: ownerObjectId,
            functionDeclaration: `function(index, expected) { ${ancestorChainBody} if (JSON.stringify([facts.rootDocumentKey, facts.documentKey, facts.ancestors.map(({ nodeId, edge }) => [nodeId, edge])]) !== expected) throw new Error('Browser iframe ancestor chain changed'); return nodes[index] ?? null; }`,
            arguments: [{ value: index }, { value: expected }],
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
          throw new Error("Browser iframe ancestor wrapper is unavailable");
        objectId = object.objectId;
      }
      const backendNodeId = await describe(index, { objectId });
      if (backendIds.includes(backendNodeId))
        throw new Error("Browser iframe ancestor identity is repeated");
      backendIds.push(backendNodeId);
    }
    await release();
    await confirm();
    const recheckNative = async () => {
      for (let index = 0; index < backendIds.length; index++)
        await describe(index, { backendNodeId: backendIds[index] });
    };
    await recheckNative();
    await confirm();
    return { recheckNative };
  } finally {
    await release();
  }
}

interface ChildViewport {
  readonly width: number;
  readonly height: number;
  readonly visualScale: number;
  readonly visualOffsetX: number;
  readonly visualOffsetY: number;
}

const coordinateBound = 10_000_000;
const coefficientBound = 1_000_000;
const maximumCondition = 1_000_000;
const bounded = (value: unknown, limit = coordinateBound): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= limit;

function requireTransform(
  value: BrowserFrameAffineTransform,
): BrowserFrameAffineTransform {
  if (
    !value ||
    ![value.a, value.b, value.c, value.d].every((coefficient) =>
      bounded(coefficient, coefficientBound),
    ) ||
    !bounded(value.e) ||
    !bounded(value.f)
  )
    throw new Error(
      "Browser frame affine transform is unavailable or exceeds its numeric bound",
    );
  const determinant = value.a * value.d - value.b * value.c;
  const magnitude = Math.max(
    Math.hypot(value.a, value.b),
    Math.hypot(value.c, value.d),
  );
  if (
    !Number.isFinite(determinant) ||
    Math.abs(determinant) <= 1e-12 ||
    (magnitude * magnitude) / Math.abs(determinant) > maximumCondition
  )
    throw new Error(
      "Browser frame affine transform is singular or ill-conditioned",
    );
  return {
    a: value.a,
    b: value.b,
    c: value.c,
    d: value.d,
    e: value.e,
    f: value.f,
  };
}

/** Maps root viewport CSS coordinates to themselves. Never a guessed fallback. */
export const browserFrameIdentityTransform: BrowserFrameAffineTransform =
  Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** outer(inner(point)); useful for a renderer-root quad's explicit top transform. */
export function browserFrameCompose(
  outer: BrowserFrameAffineTransform,
  inner: BrowserFrameAffineTransform,
): BrowserFrameAffineTransform {
  const o = requireTransform(outer),
    i = requireTransform(inner);
  return requireTransform({
    a: o.a * i.a + o.c * i.b,
    b: o.b * i.a + o.d * i.b,
    c: o.a * i.c + o.c * i.d,
    d: o.b * i.c + o.d * i.d,
    e: o.a * i.e + o.c * i.f + o.e,
    f: o.b * i.e + o.d * i.f + o.f,
  });
}

export function browserFrameInvert(
  transform: BrowserFrameAffineTransform,
): BrowserFrameAffineTransform {
  const t = requireTransform(transform);
  const determinant = t.a * t.d - t.b * t.c;
  return requireTransform({
    a: t.d / determinant,
    b: -t.b / determinant,
    c: -t.c / determinant,
    d: t.a / determinant,
    e: (t.c * t.f - t.d * t.e) / determinant,
    f: (t.b * t.e - t.a * t.f) / determinant,
  });
}

export function browserFrameMapPoint(
  transform: BrowserFrameAffineTransform,
  point: BrowserFramePoint,
): BrowserFramePoint {
  const t = requireTransform(transform);
  if (!point || !bounded(point.x) || !bounded(point.y))
    throw new Error(
      "Browser frame point is unavailable or exceeds its numeric bound",
    );
  const x = t.a * point.x + t.c * point.y + t.e;
  const y = t.b * point.x + t.d * point.y + t.f;
  if (!bounded(x) || !bounded(y))
    throw new Error("Mapped browser frame point exceeds its numeric bound");
  return { x, y };
}

function requireQuad(value: readonly number[]): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 8 ||
    !value.every((coordinate) => bounded(coordinate))
  )
    throw new Error("Browser frame content quad is unavailable or malformed");
  return value;
}

/** Preserve native corner order, including a reflection. No bounding-box conversion. */
export function browserFrameMapQuad(
  transform: BrowserFrameAffineTransform,
  quad: readonly number[],
): number[] {
  requireQuad(quad);
  const result: number[] = [];
  for (let index = 0; index < 8; index += 2) {
    const point = browserFrameMapPoint(transform, {
      x: quad[index]!,
      y: quad[index + 1]!,
    });
    result.push(point.x, point.y);
  }
  return result;
}

/**
 * Native content quad + independently verified local content size. Caller must
 * also establish the static 2D-only owner ancestry with the witness below.
 * The 0.01 corner residual permits native float rounding, not perspective CSS.
 */
export function browserFrameContentTransform(
  quad: readonly number[],
  width: number,
  height: number,
): BrowserFrameAffineTransform {
  requireQuad(quad);
  if (!bounded(width) || !bounded(height) || width <= 0 || height <= 0)
    throw new Error("Browser frame content size is unavailable or malformed");
  if (
    Math.abs(quad[4]! - quad[2]! - quad[6]! + quad[0]!) > 0.01 ||
    Math.abs(quad[5]! - quad[3]! - quad[7]! + quad[1]!) > 0.01
  )
    throw new Error(
      "Browser frame quad is not affine; perspective mapping is unsupported",
    );
  return requireTransform({
    a: (quad[2]! - quad[0]!) / width,
    b: (quad[3]! - quad[1]!) / width,
    c: (quad[6]! - quad[0]!) / height,
    d: (quad[7]! - quad[1]!) / height,
    e: quad[0]!,
    f: quad[1]!,
  });
}

/** Runtime.callFunctionOn declaration; invoke on an exact native iframe wrapper. */
export const browserFrameOwnerWitnessScript = `function() {
  const state = globalThis[Symbol.for("zenx-browser-targeted-input-v2")];
  if (!state || state.document !== document || !this || this.nodeType !== 1 || this.localName !== 'iframe' || !this.isConnected || this.ownerDocument !== document) throw new Error('Browser iframe owner or document changed');
  if ((globalThis.visualViewport?.scale ?? 1) !== 1 || (globalThis.visualViewport?.offsetLeft ?? 0) !== 0 || (globalThis.visualViewport?.offsetTop ?? 0) !== 0) throw new Error('Browser iframe parent viewport is zoomed');
  const styles = [];
  let ancestor = this;
  for (let depth = 0; ancestor; depth++) {
    if (depth >= 128 || ancestor.ownerDocument !== document) throw new Error('Browser iframe ancestry is unavailable');
    const style = getComputedStyle(ancestor);
    if (['translate', 'rotate', 'scale', 'perspective', 'offsetPath'].some(property => style[property] && style[property] !== 'none') || (style.zoom && style.zoom !== '1' && style.zoom !== 'normal') || (style.transformStyle && style.transformStyle !== 'flat')) throw new Error('Browser iframe transform or zoom is unsupported');
    const transform = style.transform || 'none';
    if (transform !== 'none') {
      if (!transform.startsWith('matrix(') || !transform.endsWith(')')) throw new Error('Browser iframe transform is not two dimensional');
      const matrix = transform.slice(7, -1).split(',').map(Number);
      if (matrix.length !== 6 || !matrix.every(value => Number.isFinite(value) && Math.abs(value) <= 1000000) || Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) <= 1e-12) throw new Error('Browser iframe transform is unavailable');
    }
    if (typeof ancestor.getAnimations === 'function') {
      const animations = ancestor.getAnimations();
      if (animations.length > 128 || animations.some(animation => animation.playState === 'running' || animation.pending)) throw new Error('Browser iframe geometry is animated');
    }
    styles.push([transform, style.transformOrigin || '']);
    if (!ancestor.assignedSlot && ancestor.parentElement && state.closedRoots?.get(ancestor.parentElement)) throw new Error('Browser iframe closed-slot ancestry is unresolved');
    ancestor = ancestor.assignedSlot ?? ancestor.parentElement ?? ancestor.getRootNode()?.host;
  }
  const style = getComputedStyle(this);
  const pixel = property => {
    const text = style[property] || '0px';
    if (!/^(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)px$/.test(text) && text !== '0') throw new Error('Browser iframe local size is unavailable');
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value) || value < 0 || value > 10000000) throw new Error('Browser iframe local size is unavailable');
    return value;
  };
  const borderLeft = pixel('borderLeftWidth'), borderTop = pixel('borderTopWidth'), borderRight = pixel('borderRightWidth'), borderBottom = pixel('borderBottomWidth');
  const paddingLeft = pixel('paddingLeft'), paddingTop = pixel('paddingTop'), paddingRight = pixel('paddingRight'), paddingBottom = pixel('paddingBottom');
  const width = pixel('width') - (style.boxSizing === 'border-box' ? borderLeft + borderRight + paddingLeft + paddingRight : 0);
  const height = pixel('height') - (style.boxSizing === 'border-box' ? borderTop + borderBottom + paddingTop + paddingBottom : 0);
  const clientWidth = this.clientWidth, clientHeight = this.clientHeight;
  if (width <= 0 || height <= 0 || !Number.isSafeInteger(clientWidth) || !Number.isSafeInteger(clientHeight) || clientWidth <= 0 || clientHeight <= 0) throw new Error('Browser iframe local content size is unavailable');
  let ownerId = state.nodes.get(this);
  if (!ownerId) { ownerId = state.id + ':' + state.next++; state.nodes.set(this, ownerId); }
  const values = { width, height, clientWidth, clientHeight, borderLeft, borderTop, borderRight, borderBottom, paddingLeft, paddingTop, paddingRight, paddingBottom };
  return { documentKey: state.id + '|' + location.href, ownerId, ...values, styleWitness: JSON.stringify([styles, values]) };
}`;

/** Caller separately compares documentKey and ownerId to its exact parent binding. */
export function requireBrowserFrameOwnerWitness(
  value: unknown,
  childViewport: ChildViewport,
): BrowserFrameOwnerWitness {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const keys = [
    "width",
    "height",
    "clientWidth",
    "clientHeight",
    "borderLeft",
    "borderTop",
    "borderRight",
    "borderBottom",
    "paddingLeft",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
  ] as const;
  if (
    !raw ||
    typeof raw.documentKey !== "string" ||
    raw.documentKey.length < 32 ||
    raw.documentKey.length > 16384 ||
    typeof raw.ownerId !== "string" ||
    !raw.ownerId ||
    raw.ownerId.length > 128 ||
    typeof raw.styleWitness !== "string" ||
    !raw.styleWitness ||
    raw.styleWitness.length > 131072 ||
    keys.some((key) => !bounded(raw[key]) || (raw[key] as number) < 0)
  )
    throw new Error("Browser iframe owner witness is unavailable or malformed");
  const numeric = (key: (typeof keys)[number]) => raw[key] as number;
  const witness: BrowserFrameOwnerWitness = {
    documentKey: raw.documentKey,
    ownerId: raw.ownerId,
    width: numeric("width"),
    height: numeric("height"),
    clientWidth: numeric("clientWidth"),
    clientHeight: numeric("clientHeight"),
    borderLeft: numeric("borderLeft"),
    borderTop: numeric("borderTop"),
    borderRight: numeric("borderRight"),
    borderBottom: numeric("borderBottom"),
    paddingLeft: numeric("paddingLeft"),
    paddingTop: numeric("paddingTop"),
    paddingRight: numeric("paddingRight"),
    paddingBottom: numeric("paddingBottom"),
    styleWitness: raw.styleWitness,
  };
  if (
    !childViewport ||
    !bounded(childViewport.width) ||
    !bounded(childViewport.height) ||
    childViewport.width <= 0 ||
    childViewport.height <= 0 ||
    childViewport.visualScale !== 1 ||
    childViewport.visualOffsetX !== 0 ||
    childViewport.visualOffsetY !== 0 ||
    witness.width <= 0 ||
    witness.height <= 0 ||
    !Number.isSafeInteger(witness.clientWidth) ||
    !Number.isSafeInteger(witness.clientHeight) ||
    witness.clientWidth <= 0 ||
    witness.clientHeight <= 0 ||
    Math.abs(witness.width - childViewport.width) > 0.01 ||
    Math.abs(witness.height - childViewport.height) > 0.01 ||
    Math.abs(
      witness.clientWidth -
        witness.paddingLeft -
        witness.paddingRight -
        witness.width,
    ) > 0.51 ||
    Math.abs(
      witness.clientHeight -
        witness.paddingTop -
        witness.paddingBottom -
        witness.height,
    ) > 0.51
  )
    throw new Error(
      "Browser iframe content and child viewport dimensions disagree or are ambiguous",
    );
  return witness;
}

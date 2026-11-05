import {
  BrowserFrameEvidence,
  type BrowserFrameCaptureFence,
  type BrowserFrameContextEvidence,
  type BrowserFrameDocumentEvidence,
} from "./browser-frame-evidence.js";
import {
  assertBrowserInputSnapshot,
  browserFrameInputSnapshotScript,
  browserInputProbeScript,
  requireBrowserInputSnapshot,
  resolveBrowserInputEvidence,
  type BrowserInputSnapshot,
  type BrowserInputKey,
  type BrowserInputFrameDocument,
  type BrowserTargetedMouseDispatch,
} from "./browser-targeted-input.js";
import {
  browserFrameIdentityTransform,
  browserFrameInvert,
  browserFrameMapPoint,
  browserFrameMapQuad,
  browserFrameContentTransform,
  browserFrameOwnerWitnessScript,
  resolveBrowserFrameAncestorEvidence,
  requireBrowserFrameOwnerWitness,
  type BrowserFrameAffineTransform,
} from "./browser-frame-geometry.js";

const WORLD = "__zenx_frame_input_v1";
const AUTO_ATTACH = {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: false,
  filter: [{ type: "iframe", exclude: false }, { exclude: true }],
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const fail = (): never => {
  throw new Error("Browser frame identity or geometry changed; inspect again");
};
const resultValue = (response: unknown): unknown => {
  const value = record(response);
  if (!value || value.exceptionDetails !== undefined) return fail();
  return record(value.result)?.value;
};
export type BrowserFrameInputAction =
  | { kind: "click"; x: number; y: number }
  | { kind: "key"; key: BrowserInputKey };
export interface BrowserFrameInputPort {
  assertCurrent(): void;
  send(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
}
interface Frame {
  document: BrowserFrameDocumentEvidence;
  context: BrowserFrameContextEvidence;
  rendererRootId: string;
  parent?: Frame;
}
interface Sample {
  frame: Frame;
  snapshot: BrowserInputSnapshot;
  key: string;
  transform: BrowserFrameAffineTransform;
  ownerId?: string;
  backendNodeId?: number;
  contentQuad?: number[];
  styleWitness?: string;
}
export interface BrowserFrameInputCapture {
  readonly snapshot: BrowserInputSnapshot;
  assertCurrent(): void;
  prepareMouse(
    snapshot: BrowserInputSnapshot,
    send: (
      sessionId: string,
      params: Record<string, unknown>,
      onDispatched: () => void,
    ) => Promise<unknown>,
  ): BrowserTargetedMouseDispatch;
  probe(
    action?: BrowserFrameInputAction,
    callerGuard?: () => void,
  ): Promise<BrowserInputSnapshot>;
}
interface MouseOwner {
  sampleSerial: number;
}
interface MouseSample {
  readonly owner: MouseOwner;
  readonly sampleSerial: number;
  readonly rendererRoot: Frame;
  readonly rootPoint: Readonly<{ x: number; y: number }>;
  readonly point: Readonly<{ x: number; y: number }>;
  readonly assertCurrent: () => void;
}
// Only completed Host probes enter this map. Copying a snapshot or supplying
// page-returned route/context IDs can never acquire a dispatch receipt.
const mouseSamples = new WeakMap<BrowserInputSnapshot, MouseSample>();
const captures = new WeakMap<BrowserInputSnapshot, BrowserFrameInputCapture>();
const enabledRoutes = new WeakMap<BrowserFrameEvidence, Set<string>>();
const setupFailures = new WeakMap<BrowserFrameEvidence, Error>();
/** Host-only association, incapable of finding a different root or acquiring it. */
export const browserFrameCaptureFor = (
  snapshot: unknown,
): BrowserFrameInputCapture | undefined =>
  snapshot !== null && typeof snapshot === "object"
    ? captures.get(snapshot as BrowserInputSnapshot)
    : undefined;

/** Read-only per-document probes under the caller's existing exact root owner. */
export class BrowserFrameInputObserver {
  readonly #enabled: Set<string>;
  constructor(
    readonly evidence: BrowserFrameEvidence,
    readonly port: BrowserFrameInputPort,
  ) {
    this.#enabled = enabledRoutes.get(evidence) ?? new Set<string>();
    enabledRoutes.set(evidence, this.#enabled);
  }

  async prepare(
    rootTree?: unknown,
  ): Promise<BrowserFrameInputCapture | undefined> {
    const root = this.evidence.rootSessionId;
    rootTree ??= await this.#send(root, "Page.getFrameTree", {});
    // The caller observed iframe owners that legacy recursion cannot resolve.
    // OOPIF documents may be absent from the parent Page frame tree entirely;
    // only trusted child attachment events can introduce their native routes.
    const failedSetup = setupFailures.get(this.evidence);
    if (failedSetup) throw failedSetup;
    for (let depth = 0; depth <= 8; depth++) {
      const pending = this.evidence
        .routes()
        .filter((route) => !this.#enabled.has(route.sessionId));
      if (!pending.length) break;
      for (const route of pending) {
        // A failed/unknown native setup is not replayed on the next inspection.
        // Only a newly admitted physical root attachment can try again.
        this.#enabled.add(route.sessionId);
        try {
          await this.#send(route.sessionId, "Runtime.enable", {});
          await this.#send(route.sessionId, "Page.enable", {});
          await this.#send(
            route.sessionId,
            "Target.setAutoAttach",
            AUTO_ATTACH,
          );
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          setupFailures.set(this.evidence, failure);
          throw failure;
        }
      }
      if (
        depth === 8 &&
        this.evidence
          .routes()
          .some((route) => !this.#enabled.has(route.sessionId))
      )
        fail();
    }
    const frames = await this.#frames();
    for (const frame of frames) {
      // Native frame lookup confirms this world's current document even when
      // Page commit and Runtime destruction/creation events arrive interleaved.
      const response = record(
        await this.#send(frame.document.sessionId, "Page.createIsolatedWorld", {
          frameId: frame.document.frameId,
          worldName: WORLD,
          grantUniveralAccess: false,
        }),
      );
      const context = this.evidence.context(
        frame.document.sessionId,
        frame.document.frameId,
        response?.executionContextId as number,
      );
      if (!context || context.name !== WORLD || context.isDefault) fail();
      frame.context = context!;
    }
    const fence = this.evidence.capture();
    const assertCurrent = () => {
      this.port.assertCurrent();
      this.evidence.assertCapture(fence);
      for (const frame of frames) this.evidence.assertContext(frame.context);
    };
    const mouseOwner: MouseOwner = { sampleSerial: 0 };
    const snapshot = await this.#sample(
      frames,
      fence,
      assertCurrent,
      mouseOwner,
    );
    const capture: BrowserFrameInputCapture = {
      snapshot,
      assertCurrent,
      prepareMouse: (snapshot, send) => {
        const selected = mouseSamples.get(snapshot);
        if (!selected || selected.owner !== mouseOwner) fail();
        selected!.assertCurrent();
        mouseSamples.delete(snapshot);
        let pressSerial = -1;
        let phase: "ready" | "pressed" | "release-ready" | "spent" = "ready";
        return Object.freeze({
          assertSnapshot: (fresh: BrowserInputSnapshot) => {
            selected!.assertCurrent();
            const next = mouseSamples.get(fresh);
            if (
              phase !== "pressed" ||
              !next ||
              next.owner !== mouseOwner ||
              next.sampleSerial <= pressSerial ||
              next.rendererRoot !== selected!.rendererRoot ||
              next.point.x !== selected!.point.x ||
              next.point.y !== selected!.point.y ||
              next.rootPoint.x !== selected!.rootPoint.x ||
              next.rootPoint.y !== selected!.rootPoint.y
            )
              fail();
            next!.assertCurrent();
            mouseSamples.delete(fresh);
            phase = "release-ready";
          },
          dispatch: async (
            params: Record<string, unknown>,
            onDispatched: () => void,
          ) => {
            selected!.assertCurrent();
            const press = phase === "ready";
            if (
              (!press && phase !== "release-ready") ||
              params.type !== (press ? "mousePressed" : "mouseReleased") ||
              params.x !== selected!.rootPoint.x ||
              params.y !== selected!.rootPoint.y ||
              params.button !== "left" ||
              params.buttons !== (press ? 1 : 0) ||
              params.clickCount !== 1 ||
              Object.keys(params).length !== 6
            )
              fail();
            // Retire before enqueue, including synchronous/unknown failures. A
            // failed send never permits retrying this receipt or another route.
            phase = "spent";
            const result = await send(
              selected!.rendererRoot.document.sessionId,
              { ...params, x: selected!.point.x, y: selected!.point.y },
              onDispatched,
            );
            if (press) {
              selected!.assertCurrent();
              pressSerial = mouseOwner.sampleSerial;
              phase = "pressed";
            }
            return result;
          },
        });
      },
      probe: (action, callerGuard) =>
        this.#sample(
          frames,
          fence,
          () => {
            assertCurrent();
            callerGuard?.();
          },
          mouseOwner,
          action,
        ),
    };
    captures.set(snapshot, capture);
    return capture;
  }

  async #send(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.port.assertCurrent();
    if (!this.evidence.hasSession(sessionId)) fail();
    if (method.startsWith("Input."))
      throw new Error("Frame probes cannot dispatch input");
    const result = await this.port.send(sessionId, method, params);
    this.port.assertCurrent();
    if (!this.evidence.hasSession(sessionId)) fail();
    return result;
  }

  async #frames(): Promise<Frame[]> {
    const fence = this.evidence.capture();
    const routes = this.evidence.routes();
    const rootIds = new Map<string, string>();
    for (const route of routes) {
      const response = await this.#send(
        route.sessionId,
        "Page.getFrameTree",
        {},
      );
      this.evidence.recordFrameTree(route.sessionId, response, fence);
      const root = record(record(record(response)?.frameTree)?.frame)?.id;
      if (typeof root !== "string") fail();
      rootIds.set(route.sessionId, root as string);
    }
    const all = new Map<string, Frame>();
    for (const route of routes) {
      for (const document of this.evidence.frames(route.sessionId)) {
        const contexts = this.evidence
          .contexts(route.sessionId)
          .filter(
            (context) =>
              context.frameId === document.frameId && context.isDefault,
          );
        // Parent trees can contain a remote frame placeholder. Only its actual
        // renderer route owns a default execution context for that frame.
        if (!contexts.length) continue;
        if (
          contexts.length !== 1 ||
          all.has(document.frameId) ||
          all.size >= 32
        )
          fail();
        all.set(document.frameId, {
          document,
          context: contexts[0]!,
          rendererRootId: rootIds.get(route.sessionId)!,
        });
      }
    }
    // Every native parent placeholder must have exactly one observed document.
    for (const route of routes)
      for (const document of this.evidence.frames(route.sessionId))
        if (!all.has(document.frameId)) fail();
    const root = all.get(rootIds.get(this.evidence.rootSessionId)!);
    if (!root || root.document.parentFrameId) fail();
    for (const frame of all.values()) {
      if (frame === root) continue;
      const parent = all.get(frame.document.parentFrameId ?? "");
      if (!parent) fail();
      frame.parent = parent;
      if (frame.document.sessionId !== parent!.document.sessionId) {
        if (
          rootIds.get(frame.document.sessionId) !== frame.document.frameId ||
          this.evidence.parentSession(frame.document.sessionId) !==
            parent!.document.sessionId
        )
          fail();
      }
    }
    // Parent-first, bounded and acyclic; never truncate missing descendants.
    const ordered: Frame[] = [root!];
    const depths = new Map<Frame, number>([[root!, 0]]);
    for (let i = 0; i < ordered.length; i++)
      for (const frame of all.values())
        if (frame.parent === ordered[i]) {
          const depth = depths.get(ordered[i]!)! + 1;
          if (ordered.includes(frame) || ordered.length >= 32 || depth > 8)
            fail();
          depths.set(frame, depth);
          ordered.push(frame);
        }
    if (ordered.length !== all.size) fail();
    this.evidence.assertCapture(fence);
    return ordered;
  }

  async #command(
    frame: Frame,
    assertCurrent: () => void,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    assertCurrent();
    this.evidence.assertContext(frame.context);
    const response = await this.#send(frame.document.sessionId, method, {
      ...params,
      ...(method === "Runtime.evaluate"
        ? { uniqueContextId: frame.context.uniqueId }
        : method === "DOM.resolveNode"
          ? { executionContextId: frame.context.id }
          : {}),
    });
    assertCurrent();
    return response;
  }

  async #probe(
    frame: Frame,
    assertCurrent: () => void,
    action?: BrowserFrameInputAction,
  ): Promise<BrowserInputSnapshot> {
    const send = (method: string, params: Record<string, unknown>) =>
      this.#command(frame, assertCurrent, method, params);
    const raw = resultValue(
      await send("Runtime.evaluate", {
        expression: action
          ? browserInputProbeScript(action, true)
          : browserFrameInputSnapshotScript,
        returnByValue: true,
        awaitPromise: true,
      }),
    );
    const snapshot = requireBrowserInputSnapshot(
      await resolveBrowserInputEvidence(raw, send),
    );
    if (
      !snapshot.localFrame ||
      snapshot.frameOwnerScanComplete !== true ||
      !Array.isArray(snapshot.frameOwnerIds)
    )
      fail();
    return snapshot;
  }

  async #sample(
    frames: Frame[],
    fence: BrowserFrameCaptureFence,
    assertCurrent: () => void,
    mouseOwner: MouseOwner,
    action?: BrowserFrameInputAction,
  ): Promise<BrowserInputSnapshot> {
    const sampleSerial = ++mouseOwner.sampleSerial;
    assertCurrent();
    const currentFrames = await this.#frames();
    if (
      JSON.stringify(
        currentFrames.map((frame) => [frame.document, frame.rendererRootId]),
      ) !==
      JSON.stringify(
        frames.map((frame) => [frame.document, frame.rendererRootId]),
      )
    )
      fail();
    const samples = new Map<string, Sample>();
    const documents: BrowserInputFrameDocument[] = [];
    for (const frame of frames) {
      const snapshot = await this.#probe(frame, assertCurrent);
      if (
        !snapshot.localFrame ||
        snapshot.frameOwnerScanComplete !== true ||
        (snapshot.frameDocuments?.length ?? 0) !== 0
      )
        fail();
      const key = JSON.stringify([
        frame.document.sessionId,
        frame.document.frameId,
        frame.document.loaderId,
        frame.context.uniqueId,
        snapshot.documentKey,
      ]);
      const sample: Sample = {
        frame,
        snapshot,
        key,
        transform: browserFrameIdentityTransform,
      };
      samples.set(frame.document.frameId, sample);
      if (frame.parent) {
        const parent = samples.get(frame.parent.document.frameId)!;
        const owner = record(
          await this.#command(
            frame.parent,
            assertCurrent,
            "DOM.getFrameOwner",
            { frameId: frame.document.frameId },
          ),
        );
        const backendNodeId = owner?.backendNodeId;
        if (
          !Number.isSafeInteger(backendNodeId) ||
          (backendNodeId as number) <= 0
        )
          fail();
        const witness = await this.#ownerWitness(
          frame,
          snapshot,
          backendNodeId as number,
          assertCurrent,
        );
        if (witness.documentKey !== parent.snapshot.documentKey) fail();
        const model = record(
          record(
            await this.#command(
              frame.parent,
              assertCurrent,
              "DOM.getBoxModel",
              { backendNodeId },
            ),
          )?.model,
        );
        const rendererRoot = samples.get(frame.parent.rendererRootId);
        if (!rendererRoot || !Array.isArray(model?.content)) fail();
        // Native quad is already composed inside the parent's renderer. Only
        // map that renderer root through its OOPIF owner, never its same-process
        // parent transform a second time.
        const quad = browserFrameMapQuad(
          rendererRoot!.transform,
          model!.content as number[],
        );
        sample.transform = browserFrameContentTransform(
          quad,
          snapshot.viewport.width,
          snapshot.viewport.height,
        );
        sample.ownerId = witness.ownerId;
        sample.backendNodeId = backendNodeId as number;
        sample.contentQuad = quad;
        sample.styleWitness = witness.styleWitness;
        documents.push({
          ownerId: witness.ownerId,
          parentDocumentKey: parent.key,
          documentKey: key,
          viewport: snapshot.viewport,
          geometry: {
            x: quad[0]!,
            y: quad[1]!,
            width: snapshot.viewport.width,
            height: snapshot.viewport.height,
            contentQuad: quad,
          },
        });
      }
    }
    for (const sample of samples.values()) {
      const candidates = sample.snapshot.frameOwnerIds;
      const verified = [...samples.values()]
        .filter((child) => child.frame.parent === sample.frame)
        .map((child) => child.ownerId!);
      if (
        !Array.isArray(candidates) ||
        candidates.length !== verified.length ||
        candidates.some((id) => !verified.includes(id))
      )
        fail();
    }
    const root = samples.get(frames[0]!.document.frameId)!;
    const role = async (
      kind: "focus" | "pointer",
    ): Promise<{
      id: string | null;
      backendNodeId?: number;
      unsupported?: "native-surface" | "shadow-surface";
      frameId?: string;
    }> => {
      let current = root;
      for (let depth = 0; depth < 32; depth++) {
        let localAction: BrowserFrameInputAction | undefined;
        if (kind === "pointer") {
          if (action?.kind !== "click") fail();
          const point = browserFrameMapPoint(
            browserFrameInvert(current.transform),
            action! as { x: number; y: number },
          );
          if (
            point.x < 0 ||
            point.y < 0 ||
            point.x >= current.snapshot.viewport.width ||
            point.y >= current.snapshot.viewport.height
          )
            fail();
          localAction = { kind: "click", ...point };
        }
        const fresh = await this.#probe(
          current.frame,
          assertCurrent,
          localAction,
        );
        assertBrowserInputSnapshot(current.snapshot, fresh);
        const owner =
          kind === "focus" ? fresh.focusFrameOwner : fresh.pointerFrameOwner;
        const id = kind === "focus" ? fresh.focusId : fresh.pointerHitId;
        if (!id)
          return {
            id: null,
            ...(fresh.focusUnsupported
              ? { unsupported: fresh.focusUnsupported }
              : {}),
          };
        const native = await this.#candidate(
          current.frame,
          fresh,
          kind,
          assertCurrent,
        );
        if (!owner)
          return {
            id: JSON.stringify([current.key, id]),
            backendNodeId: native,
            frameId: current.frame.document.frameId,
          };
        const children = [...samples.values()].filter(
          (child) =>
            child.frame.parent === current.frame &&
            child.ownerId === id &&
            child.backendNodeId === native,
        );
        if (children.length !== 1) fail();
        current = children[0]!;
      }
      return fail();
    };
    const focus = await role("focus");
    const pointer =
      action?.kind === "click" ? await role("pointer") : undefined;
    // End with complete local-document, native-owner and quad comparisons. A
    // changed frame cannot hide by returning to the same root DOM snapshot.
    for (const sample of samples.values()) {
      const fresh = await this.#probe(sample.frame, assertCurrent);
      assertBrowserInputSnapshot(sample.snapshot, fresh);
      if (sample.frame.parent) {
        const owner = record(
          await this.#command(
            sample.frame.parent,
            assertCurrent,
            "DOM.getFrameOwner",
            { frameId: sample.frame.document.frameId },
          ),
        );
        const witness = await this.#ownerWitness(
          sample.frame,
          sample.snapshot,
          sample.backendNodeId!,
          assertCurrent,
        );
        const parent = samples.get(sample.frame.parent.document.frameId)!;
        if (
          witness.documentKey !== parent.snapshot.documentKey ||
          witness.ownerId !== sample.ownerId ||
          witness.styleWitness !== sample.styleWitness
        )
          fail();
        const model = record(
          record(
            await this.#command(
              sample.frame.parent,
              assertCurrent,
              "DOM.getBoxModel",
              { backendNodeId: sample.backendNodeId },
            ),
          )?.model,
        );
        const rendererRoot = samples.get(sample.frame.parent.rendererRootId)!;
        if (
          owner?.backendNodeId !== sample.backendNodeId ||
          JSON.stringify(
            browserFrameMapQuad(
              rendererRoot.transform,
              model?.content as number[],
            ),
          ) !== JSON.stringify(sample.contentQuad)
        )
          fail();
      }
    }
    const finalFocus = await role("focus");
    const finalPointer =
      action?.kind === "click" ? await role("pointer") : undefined;
    if (
      JSON.stringify(finalFocus) !== JSON.stringify(focus) ||
      JSON.stringify(finalPointer) !== JSON.stringify(pointer)
    )
      fail();
    // Native checks above are asynchronous. Re-read every disjoint document,
    // including off-path siblings, after all native wrapper cleanup/checks.
    for (const sample of samples.values())
      assertBrowserInputSnapshot(
        sample.snapshot,
        await this.#probe(sample.frame, assertCurrent),
      );
    this.evidence.assertCapture(fence);
    assertCurrent();
    const values = [...samples.values()];
    const aggregate = requireBrowserInputSnapshot({
      documentKey: root.key,
      viewport: root.snapshot.viewport,
      focusId: focus.id,
      ...(focus.backendNodeId === undefined
        ? {}
        : { focusBackendNodeId: focus.backendNodeId }),
      ...(focus.unsupported ? { focusUnsupported: focus.unsupported } : {}),
      ...(pointer
        ? {
            pointerHitId: pointer.id,
            pointerBackendNodeId: pointer.backendNodeId,
            pointerPoint: {
              x: (action as { x: number }).x,
              y: (action as { y: number }).y,
            },
          }
        : {}),
      inputRevision: values.reduce(
        (sum, sample) => sum + sample.snapshot.inputRevision,
        0,
      ),
      layoutRevision: values.reduce(
        (sum, sample) => sum + sample.snapshot.layoutRevision,
        0,
      ),
      frameDocuments: documents,
    });
    if (action?.kind === "click" && pointer?.frameId) {
      const leaf = samples.get(pointer.frameId)!;
      const rendererRoot = samples.get(leaf.frame.rendererRootId)!;
      const point = browserFrameMapPoint(
        browserFrameInvert(rendererRoot.transform),
        action,
      );
      if (
        point.x < 0 ||
        point.y < 0 ||
        point.x >= rendererRoot.snapshot.viewport.width ||
        point.y >= rendererRoot.snapshot.viewport.height
      )
        fail();
      mouseSamples.set(
        aggregate,
        Object.freeze({
          owner: mouseOwner,
          sampleSerial,
          rendererRoot: rendererRoot.frame,
          rootPoint: Object.freeze({ x: action.x, y: action.y }),
          point: Object.freeze(point),
          assertCurrent,
        }),
      );
    }
    return aggregate;
  }

  async #ownerWitness(
    frame: Frame,
    snapshot: BrowserInputSnapshot,
    backendNodeId: number,
    assertCurrent: () => void,
  ) {
    const node = record(
      record(
        await this.#command(frame.parent!, assertCurrent, "DOM.describeNode", {
          backendNodeId,
          depth: 0,
          pierce: false,
        }),
      )?.node,
    );
    if (
      node?.nodeType !== 1 ||
      node.localName !== "iframe" ||
      node.frameId !== frame.document.frameId ||
      node.backendNodeId !== backendNodeId
    )
      fail();
    const response = record(
      await this.#command(frame.parent!, assertCurrent, "DOM.resolveNode", {
        backendNodeId,
      }),
    );
    const wrapper = record(response?.object);
    if (
      wrapper?.subtype !== "node" ||
      typeof wrapper.objectId !== "string" ||
      !wrapper.objectId
    )
      fail();
    let witness;
    let ancestry:
      | Awaited<ReturnType<typeof resolveBrowserFrameAncestorEvidence>>
      | undefined;
    try {
      ancestry = await resolveBrowserFrameAncestorEvidence(
        wrapper!.objectId as string,
        (method, params) =>
          this.#command(frame.parent!, assertCurrent, method, params),
      );
      witness = requireBrowserFrameOwnerWitness(
        resultValue(
          await this.#command(
            frame.parent!,
            assertCurrent,
            "Runtime.callFunctionOn",
            {
              objectId: wrapper!.objectId,
              functionDeclaration: browserFrameOwnerWitnessScript,
              returnByValue: true,
              awaitPromise: false,
            },
          ),
        ),
        snapshot.viewport,
      );
    } finally {
      // Cleanup is exact-route only. Never retry a detached/unknown release.
      try {
        await this.#command(
          frame.parent!,
          assertCurrent,
          "Runtime.releaseObject",
          { objectId: wrapper!.objectId },
        );
      } catch {}
    }
    await ancestry!.recheckNative();
    return witness;
  }

  async #candidate(
    frame: Frame,
    snapshot: BrowserInputSnapshot,
    role: "focus" | "pointer",
    assertCurrent: () => void,
  ): Promise<number> {
    const id = role === "focus" ? snapshot.focusId : snapshot.pointerHitId;
    const response = record(
      await this.#command(frame, assertCurrent, "Runtime.evaluate", {
        expression: `(() => { const state = globalThis[Symbol.for("zenx-browser-targeted-input-v2")]; const node=state?.${role === "focus" ? "focusNode" : "hitNode"}; return state?.document===document && state.id+'|'+location.href===${JSON.stringify(snapshot.documentKey)} && node?.isConnected && node.ownerDocument===document && state.nodes.get(node)===${JSON.stringify(id)} ? node : null; })()`,
        returnByValue: false,
        awaitPromise: false,
      }),
    );
    const wrapper = record(response?.result);
    if (
      response?.exceptionDetails ||
      wrapper?.subtype !== "node" ||
      typeof wrapper.objectId !== "string" ||
      !wrapper.objectId
    )
      fail();
    try {
      const node = record(
        record(
          await this.#command(frame, assertCurrent, "DOM.describeNode", {
            objectId: wrapper!.objectId,
            depth: 0,
            pierce: false,
          }),
        )?.node,
      );
      if (
        node?.nodeType !== 1 ||
        !Number.isSafeInteger(node.backendNodeId) ||
        (node.backendNodeId as number) <= 0
      )
        fail();
      return node!.backendNodeId as number;
    } finally {
      try {
        await this.#command(frame, assertCurrent, "Runtime.releaseObject", {
          objectId: wrapper!.objectId,
        });
      } catch {}
    }
  }
}

/** Native topology, not URL/origin heuristics, decides whether legacy recursion is complete. */
export function browserFrameInputNeedsObserver(
  treeResponse: unknown,
  legacy: unknown,
): boolean {
  const tree = record(record(treeResponse)?.frameTree);
  const snapshot = record(legacy);
  if (
    Array.isArray(snapshot?.frameOwnerIds) &&
    (!Array.isArray(snapshot.frameDocuments) ||
      snapshot.frameOwnerIds.length !== snapshot.frameDocuments.length)
  )
    return true;
  if (
    !tree ||
    !Array.isArray(tree.childFrames) ||
    tree.childFrames.length === 0
  )
    return false;
  const count = (node: Record<string, unknown>, depth: number): number => {
    if (depth > 8) return 33;
    const children = node.childFrames;
    if (children === undefined) return 1;
    if (!Array.isArray(children)) return 33;
    let size = 1;
    for (const child of children) {
      const value = record(child);
      if (!value) return 33;
      size += count(value, depth + 1);
      if (size > 32) return 33;
    }
    return size;
  };
  return (
    !Array.isArray(snapshot?.frameDocuments) ||
    count(tree, 0) !== snapshot.frameDocuments.length + 1
  );
}

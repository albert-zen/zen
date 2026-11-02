import {
  attachBrowserModelRoute,
  attachBrowserModelTargets,
  readBrowserModelRoute,
  readBrowserModelTargets,
  type BrowserModelRoute,
} from "./model-browser-metadata.js";
import { withBrowserOperationOrder } from "./browser-operation-order.js";
import { BROWSER_PLUGIN_VERSION } from "../../../../../packages/zenx-browser-plugin/src/version.js";
import type { ToolInvocation } from "../../../../../src/tool.js";
import {
  BrowserZenXCapabilityPackage,
  browserCapabilityManifest,
  type ZenXBrowserBackend,
} from "./browser-provider.js";
import { userBrowserManifest } from "./provider-catalog.js";
import type { ZenXCapabilityPackage, ZenXPluginManifestV2 } from "./types.js";
import type {
  BrowserThreadListener,
  BrowserThreadRequest,
  BrowserThreadEvent,
  BrowserThreadTarget,
} from "./browser-thread-observation.js";

import {
  browserConnectionScopeKey,
  type BrowserConnectionSource,
} from "./browser-connections.js";

type BackendId = string;
const workspacePrefix = "browser_workspace_";
const connectedPrefix = "browser_connected_";
const referenceKeys = new Set([
  "tabId",
  "observationId",
  "actionObservationId",
  "baseObservationId",
  "targetId",
  "cursor",
  "nextCursor",
]);

/** Static tool namespaces keep remembered tool approvals local to one backend. */
export function concurrentBrowserManifest(): ZenXPluginManifestV2 {
  const workspace = structuredClone(browserCapabilityManifest);
  const connected = userBrowserManifest();
  for (const tool of workspace.tools)
    qualifySchemaDescriptions(tool.inputSchema, workspacePrefix);
  for (const tool of connected.tools)
    qualifySchemaDescriptions(tool.inputSchema, connectedPrefix);
  return {
    ...workspace,
    version: BROWSER_PLUGIN_VERSION,
    description:
      "The shared ZenX browser and an explicitly connected external browser, available together with independent targets and tool approvals.",
    provider: {
      ...workspace.provider,
      id: "concurrent-browser",
      capabilities: [
        ...workspace.provider.capabilities,
        "user_session",
        "backend_isolation",
      ],
    },
    mainDocument: `${workspace.mainDocument.replaceAll("browser_", workspacePrefix)} Browser backends coexist: browser_workspace_* uses the shared Workspace browser; browser_connected_* uses only the explicitly enabled external connection. Start with each backend's list_tabs using a sessionId. Results identify backendId. Pass returned tabId, observationId, targetId and cursor unchanged to tools in the same namespace; cross-backend references reject. An unavailable external connection never redirects to the Workspace browser. Closing a connected tab/session only detaches ZenX and leaves the user's page open. Approvals for one tool namespace do not approve the other. Only one external browser connection is supported at a time; disconnect it explicitly before connecting another.`,
    permissions: [
      ...workspace.permissions,
      ...connected.permissions.map((permission) => ({
        ...permission,
        id: permission.id.replace("browser.", "browser.connected."),
        title: `Connected browser: ${permission.title}`,
      })),
    ],
    tools: [
      ...workspace.tools.map((tool) => ({
        ...tool,
        name: tool.name.replace("browser_", workspacePrefix),
        description: `[Workspace browser] ${
          tool.name === "browser_open"
            ? "Open an HTTP(S) URL in a shared Thread-owned Workspace tab visible to the user; this does not connect an external browser."
            : tool.name === "browser_close_session"
              ? "Detach this Agent session without closing the user's shared Workspace pages or clearing their storage."
              : tool.description
                  .replaceAll("dedicated", "shared")
                  .replaceAll("ephemeral", "shared")
                  .replaceAll("browser_", workspacePrefix)
        }`,
      })),
      ...connected.tools.map((tool) => ({
        ...tool,
        name: tool.name.replace("browser_", connectedPrefix),
        description: `[Connected external browser] ${tool.description.replaceAll("browser_", connectedPrefix)}`,
        permissions: tool.permissions.map((permission) =>
          permission.replace("browser.", "browser.connected."),
        ),
      })),
    ],
  };
}

/** One catalog, not a copy of each tool per connected profile. */
export function multiBrowserManifest(): ZenXPluginManifestV2 {
  const manifest = concurrentBrowserManifest();
  manifest.version = BROWSER_PLUGIN_VERSION;
  manifest.provider.id = "multi-browser";
  manifest.description =
    "Workspace, Chrome and Edge browser instances with separate targets and approvals.";
  manifest.mainDocument = manifest.mainDocument.replace(
    "Only one external browser connection is supported at a time; disconnect it explicitly before connecting another.",
    "Start with browser_connections to discover non-sensitive connection IDs and labels. Every browser_connected_* call requires an explicit connectionId. Choose that instance before listing tabs; separate instances need separate approvals, including instances of the same browser. References are bound to the exact connection generation, so reconnect requires fresh list/inspect and never retries an old action. No unavailable target falls back to another browser.",
  );
  for (const tool of manifest.tools) {
    if (!tool.name.startsWith(connectedPrefix)) continue;
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    schema.properties.connectionId = {
      type: "string",
      description:
        "Exact opaque connectionId from browser_connections. Required even when only one browser is connected.",
    };
    schema.required = [...(schema.required ?? []), "connectionId"];
  }
  const template = structuredClone(
    manifest.tools.find((tool) => tool.name === "browser_workspace_list_tabs")!,
  );
  manifest.tools.unshift({
    ...template,
    name: "browser_connections",
    description:
      "Discover connected browser instances by opaque ID, browser label and connection state only. Does not list tabs or expose page titles, URLs or account/profile information.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    permissions: [],
  });
  return manifest;
}

/** Process-local resource routing only; no new Thread history or permission authority. */
export class BrowserBackendRegistry implements ZenXCapabilityPackage {
  readonly manifest: ZenXPluginManifestV2;
  readonly #source?: BrowserConnectionSource;
  readonly #pendingConnections = new Map<
    string,
    Promise<BrowserZenXCapabilityPackage>
  >();
  readonly #stopConnections?: () => void;
  readonly #packages = new Map<BackendId, BrowserZenXCapabilityPackage>();
  readonly #connectedUnavailable: string;
  readonly #observers = new Set<{
    threadId: string;
    refresh: () => void;
    syncPackages: () => void;
    stop: () => void;
    retire: () => void;
    finish: (
      event: Extract<BrowserThreadEvent, { type: "turn-ended" }>,
    ) => void;
  }>();
  readonly #finishingThreads = new Map<
    string,
    { throughSequence: number; failed: boolean }
  >();
  #closed = false;

  constructor(
    workspace: ZenXBrowserBackend,
    connected?: ZenXBrowserBackend,
    connectedUnavailable = "Enable the external browser connection in Settings, restart ZenX, and connect the extension.",
    source?: BrowserConnectionSource,
  ) {
    this.#source = source;
    this.manifest =
      source === undefined
        ? concurrentBrowserManifest()
        : multiBrowserManifest();
    this.#stopConnections = source?.onConnectionsChanged(() =>
      this.#syncConnections(),
    );
    this.#packages.set(
      "workspace",
      new BrowserZenXCapabilityPackage(workspace, undefined, {
        ownsBackend: false,
      }),
    );
    if (connected !== undefined)
      this.#packages.set(
        "connected",
        new BrowserZenXCapabilityPackage(connected, userBrowserManifest()),
      );
    this.#connectedUnavailable = connectedUnavailable;
  }

  #syncConnections(): void {
    const current = new Set(
      this.#source
        ?.connections()
        .filter((value) => value.state === "connected")
        .map((value) => `connected/${value.connectionId}/${value.generation}`),
    );
    for (const [key, capability] of this.#packages) {
      if (!key.startsWith("connected/") || current.has(key)) continue;
      this.#packages.delete(key);
      void capability.close().catch(() => undefined);
    }
    for (const observer of [...this.#observers]) observer.syncPackages();
  }

  async #instance(
    invocation: ToolInvocation,
  ): Promise<{ key: string; capability: BrowserZenXCapabilityPackage }> {
    const id = invocation.arguments.connectionId;
    if (typeof id !== "string")
      throw new Error("An explicit browser connectionId is required");
    const connection = this.#source
      ?.connections()
      .find(
        (value) => value.connectionId === id && value.state === "connected",
      );
    if (connection === undefined)
      throw new Error(
        "Browser connection is unavailable; discover connections again",
      );
    const scope = invocation.approvalScope;
    if (scope?.key !== browserConnectionScopeKey(id))
      throw new Error(
        "Browser instance approval scope is missing or mismatched",
      );
    if (scope.generation !== connection.generation)
      throw new Error(
        "Browser connection generation changed; discover and inspect again",
      );
    const key = `connected/${id}/${connection.generation}`;
    const existing = this.#packages.get(key);
    if (existing !== undefined) return { key, capability: existing };
    let pending = this.#pendingConnections.get(key);
    if (pending === undefined) {
      pending = this.#source!.connectInstance(
        id,
        connection.generation,
        invocation.signal,
      )
        .then(async (result) => {
          if (
            this.#closed ||
            !this.#source!.connections().some(
              (value) =>
                value.connectionId === id &&
                value.generation === connection.generation &&
                value.state === "connected",
            )
          ) {
            await result.backend.close();
            throw new Error(
              "Browser connection generation changed while connecting",
            );
          }
          const capability = new BrowserZenXCapabilityPackage(
            result.backend,
            userBrowserManifest(),
          );
          this.#packages.set(key, capability);
          for (const observer of [...this.#observers]) observer.syncPackages();
          return capability;
        })
        .finally(() => this.#pendingConnections.delete(key));
      this.#pendingConnections.set(key, pending);
    }
    const capability = await pending;
    invocation.signal.throwIfAborted();
    if (
      !this.#source!.connections().some(
        (value) =>
          value.connectionId === id &&
          value.generation === scope.generation &&
          value.state === "connected",
      )
    )
      throw new Error("Browser connection generation changed before dispatch");
    return { key, capability };
  }

  invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    return withBrowserOperationOrder(() =>
      this.#invokeOrdered(toolName, invocation),
    );
  }

  async #invokeOrdered(
    toolName: string,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    if (this.#closed) throw new Error("Browser registry is closed");
    if (toolName === "browser_connections" && this.#source !== undefined)
      return this.#source
        .connections()
        .map(({ connectionId, browser, label, state }) => ({
          connectionId,
          browser,
          label,
          state,
        }));
    const tool = this.manifest.tools.find((entry) => entry.name === toolName);
    if (tool === undefined)
      throw new Error(`Unsupported browser tool: ${toolName}`);
    const instance =
      toolName.startsWith(connectedPrefix) && this.#source !== undefined
        ? await this.#instance(invocation)
        : undefined;
    const backendId: BackendId =
      instance?.key ??
      (toolName.startsWith(connectedPrefix) ? "connected" : "workspace");
    const selected = instance?.capability ?? this.#packages.get(backendId);
    if (selected === undefined)
      throw new Error(
        `Connected browser unavailable: ${this.#connectedUnavailable}`,
      );
    const expected = readBrowserModelRoute(invocation);
    if (expected) {
      if (expected.backend !== backendId)
        throw Error("Browser reference backend changed; read again");
      this.assertModelTarget(expected, invocation.threadId);
    }
    const args = { ...invocation.arguments };
    if (instance !== undefined) delete args.connectionId;
    for (const key of referenceKeys) {
      if (args[key] !== undefined)
        args[key] = unqualify(backendId, args[key], key);
    }
    const canonicalName = toolName.replace(
      backendId.startsWith("connected") ? connectedPrefix : workspacePrefix,
      "browser_",
    );
    const nativeInvocation = {
      ...invocation,
      name: canonicalName,
      arguments: args,
    };
    if (expected)
      attachBrowserModelRoute(nativeInvocation, {
        ...expected,
        ...(expected.tabId === undefined
          ? {}
          : {
              tabId: unqualify(backendId, expected.tabId, "tabId"),
              targetId: unqualify(backendId, expected.targetId!, "targetId"),
            }),
      });
    const result = await selected.invoke(canonicalName, nativeInvocation);
    const project = (value: unknown) => ({
      ...(qualifyResult(backendId, value) as object),
      backendId: backendId === "workspace" ? "workspace" : "connected",
      ...(instance === undefined
        ? {}
        : { connectionId: invocation.arguments.connectionId }),
    });
    const projected = Array.isArray(result)
      ? result.map(project)
      : project(result);
    const metadata = readBrowserModelTargets(result);
    return metadata
      ? attachBrowserModelTargets(projected, {
          route: {
            ...metadata.route,
            backend: backendId,
            ...(instance
              ? {
                  connectionId: invocation.arguments.connectionId as string,
                  generation: invocation.approvalScope!.generation!,
                }
              : {}),
          },
          targets: metadata.targets.map((t) => ({
            tabId: qualify(backendId, t.tabId),
            targetId: qualify(backendId, t.targetId),
          })),
        })
      : projected;
  }

  /** Uses only the existing native registry; does not connect or create UI state. */
  assertModelTarget(
    route: BrowserModelRoute,
    threadId: string | undefined,
  ): void {
    const backend = route.backend;
    const capability = backend && this.#packages.get(backend);
    if (
      this.#closed ||
      !capability ||
      (route.connectionId !== undefined &&
        !this.#source
          ?.connections()
          .some(
            (c) =>
              c.connectionId === route.connectionId &&
              c.generation === route.generation &&
              c.state === "connected",
          ))
    )
      throw Error(
        "Browser connection is unavailable; discover and inspect again",
      );
    capability.assertModelTarget(
      {
        ...route,
        ...(route.tabId === undefined
          ? {}
          : {
              tabId: unqualify(backend!, route.tabId, "tabId"),
              targetId: unqualify(backend!, route.targetId!, "targetId"),
            }),
      },
      threadId,
    );
  }

  async readModelTarget(
    threadId: string,
    targetId: string,
  ): Promise<BrowserModelRoute | undefined> {
    const backendId = targetId.split(":")[0]!;
    const capability = this.#packages.get(backendId);
    if (this.#closed || !capability) return;
    const instance = this.#source
      ?.connections()
      .find(
        (connection) =>
          connection.state === "connected" &&
          backendId ===
            `connected/${connection.connectionId}/${connection.generation}`,
      );
    if (backendId.startsWith("connected/") && !instance) return;
    const route = await capability.readModelTarget(
      threadId,
      unqualify(backendId, targetId, "targetId"),
    );
    if (
      !route?.tabId ||
      !route.targetId ||
      this.#closed ||
      this.#packages.get(backendId) !== capability
    )
      return;
    const qualified: BrowserModelRoute = {
      ...route,
      backend: backendId,
      ...(instance
        ? {
            connectionId: instance.connectionId,
            generation: instance.generation,
          }
        : {}),
      tabId: qualify(backendId, route.tabId),
      targetId: qualify(backendId, route.targetId),
    };
    this.assertModelTarget(qualified, threadId);
    return qualified;
  }

  async readTargetUrl(threadId: string, targetId: string): Promise<string> {
    const backendId = targetId.split(":")[0]!;
    const capability = this.#packages.get(backendId);
    const current = () =>
      !this.#closed &&
      this.#packages.get(backendId) === capability &&
      (this.#source === undefined ||
        !backendId.startsWith("connected/") ||
        this.#source
          .connections()
          .some(
            (connection) =>
              connection.state === "connected" &&
              backendId ===
                `connected/${connection.connectionId}/${connection.generation}`,
          ));
    if (!capability || !current())
      throw new Error("Browser connection is unavailable");
    const url = await capability.readTargetUrl(
      threadId,
      unqualify(backendId, targetId, "targetId"),
    );
    if (!current()) throw new Error("Browser connection is no longer current");
    return url;
  }

  observeThread(
    request: BrowserThreadRequest,
    listener: BrowserThreadListener,
  ): () => void {
    const targets = new Map<BackendId, BrowserThreadTarget[]>();
    let active = true;
    let selectedId: string | undefined;
    let stopFrames: (() => void) | undefined;
    let frameGeneration = 0;
    let refreshGeneration = 0;
    const stops = new Map<BackendId, () => void>();
    const stop = () => {
      if (!active) return;
      active = false;
      ++frameGeneration;
      this.#observers.delete(observer);
      const cleanup = [stopFrames, ...stops.values()];
      stopFrames = undefined;
      stops.clear();
      for (const dispose of cleanup) {
        try {
          dispose?.();
        } catch {
          // Renderer observation cleanup must not fail an Agent action.
        }
      }
    };
    const send: BrowserThreadListener = (event) => {
      if (!active) return;
      try {
        listener(event);
      } catch {
        stop();
      }
    };
    const refresh = () => {
      if (!active) return;
      const refreshRevision = ++refreshGeneration;
      const all = [...targets.values()].flat();
      const next = all.find((target) => target.id === request.targetId);
      send({
        type: "targets",
        targets: all,
        ...(next === undefined ? {} : { selectedId: next.id }),
      });
      if (!active || refreshRevision !== refreshGeneration) return;
      if (next?.id === selectedId && stopFrames !== undefined) return;
      selectedId = next?.id;
      const generation = ++frameGeneration;
      const previousStop = stopFrames;
      // observeThread can synchronously replay metadata into refresh. Reserve the
      // subscription before calling it, and dispose late returns after a switch.
      stopFrames = () => {};
      try {
        previousStop?.();
      } catch {
        // A retired renderer subscription cannot fail the completed tool call.
      }
      if (!active || generation !== frameGeneration) return;
      if (next === undefined || !request.frames) {
        send({
          type: "status",
          status: "idle",
          message: "No browser page is selected for this thread.",
        });
        return;
      }
      const backendId = next.id.split(":")[0]!;
      const dispose = this.#packages.get(backendId)!.observeThread(
        {
          ...request,
          targetId: unqualify(backendId, next.id, "targetId"),
        },
        (event) => {
          if (
            active &&
            generation === frameGeneration &&
            event.type !== "targets" &&
            event.type !== "activity"
          )
            send(event);
        },
      );
      if (!active || generation !== frameGeneration) dispose();
      else stopFrames = dispose;
    };
    const observer = {
      threadId: request.threadId,
      refresh,
      syncPackages: () => syncPackages(),
      stop,
      finish: (event: Extract<BrowserThreadEvent, { type: "turn-ended" }>) =>
        send(event),
      retire: () => {
        send({ type: "targets", targets: [] });
        send({
          type: "status",
          status: "unavailable",
          message: "The Browser provider is no longer available.",
        });
        stop();
      },
    };
    if (this.#closed) {
      observer.retire();
      return stop;
    }
    const syncPackages = () => {
      if (!active) return;
      for (const [key, dispose] of stops) {
        if (this.#packages.has(key)) continue;
        stops.delete(key);
        dispose();
        targets.delete(key);
      }
      for (const [backendId, capability] of this.#packages) {
        if (!active) break;
        if (stops.has(backendId)) continue;
        stops.set(backendId, () => {});
        const dispose = capability.observeThread(
          { threadId: request.threadId, frames: false },
          (event) => {
            if (!active || this.#packages.get(backendId) !== capability) return;
            if (event.type === "turn-ended") {
              const finishing = this.#finishingThreads.get(request.threadId);
              if (finishing) {
                finishing.failed ||= event.failed;
                finishing.throughSequence = Math.max(
                  finishing.throughSequence,
                  event.throughSequence,
                );
              }
              if (
                !request.frames &&
                !this.#finishingThreads.has(request.threadId)
              )
                send(event);
              return;
            }
            if (event.type === "activity") {
              if (!request.frames)
                send({
                  ...event,
                  targetId: qualify(backendId, event.targetId),
                  sessionEpoch: qualify(backendId, event.sessionEpoch),
                });
              return;
            }
            if (event.type !== "targets") return;
            targets.set(
              backendId,
              event.targets.map((target) => ({
                ...target,
                backendId:
                  backendId === "workspace"
                    ? ("workspace" as const)
                    : ("connected" as const),
                ...(backendId.startsWith("connected/")
                  ? {
                      connectionId: backendId.split("/")[1],
                      connectionLabel: this.#source
                        ?.connections()
                        .find(
                          (value) =>
                            value.connectionId === backendId.split("/")[1],
                        )?.label,
                    }
                  : {}),
                id: qualify(backendId, target.id),
                tabId: qualify(backendId, target.tabId),
              })),
            );
            refresh();
          },
        );
        if (!active) dispose();
        else stops.set(backendId, dispose);
      }
      refresh();
    };
    this.#observers.add(observer);
    syncPackages();
    return stop;
  }

  async finishTurn(threadId: string, failed = false): Promise<void> {
    const finishing = { throughSequence: 0, failed };
    this.#finishingThreads.set(threadId, finishing);
    try {
      const results = await Promise.allSettled(
        [...this.#packages.values()].map((p) => p.finishTurn(threadId, failed)),
      );
      const failure = results.find((r) => r.status === "rejected");
      const throughSequence = Math.max(
        finishing.throughSequence,
        ...results.map((r) => (r.status === "fulfilled" ? r.value : 0)),
      );
      for (const observer of [...this.#observers]) {
        if (observer.threadId === threadId)
          observer.finish({
            type: "turn-ended",
            threadId,
            throughSequence,
            failed: finishing.failed || failure !== undefined,
            ...(failure?.status === "rejected"
              ? { message: String(failure.reason) }
              : {}),
          });
      }
      if (failure?.status === "rejected") throw failure.reason;
    } finally {
      if (this.#finishingThreads.get(threadId) === finishing)
        this.#finishingThreads.delete(threadId);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopConnections?.();
    for (const observer of [...this.#observers]) observer.retire();
    await Promise.allSettled([...this.#pendingConnections.values()]);
    await Promise.all(
      [...this.#packages.values()].map((capability) => capability.close()),
    );
  }
}

function qualify(backendId: BackendId, value: string): string {
  return `${backendId}:${value}`;
}
function unqualify(backendId: BackendId, value: unknown, key: string): string {
  const prefix = `${backendId}:`;
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.length === prefix.length
  )
    throw new Error(
      `${key} belongs to a different browser backend or is invalid; list/inspect this backend again`,
    );
  return value.slice(prefix.length);
}

function qualifyResult(
  backendId: BackendId,
  value: unknown,
  key?: string,
): unknown {
  if (key === "nextAction" && typeof value === "string")
    return value.replaceAll(
      "browser_",
      backendId.startsWith("connected") ? connectedPrefix : workspacePrefix,
    );
  if (typeof value === "string" && key !== undefined && referenceKeys.has(key))
    return qualify(backendId, value);
  if (Array.isArray(value)) {
    if (key === "removedFromView" || key === "order")
      return value.map((id) =>
        typeof id === "string" ? qualify(backendId, id) : id,
      );
    return value.map((entry) => qualifyResult(backendId, entry));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([field, entry]) => [
      field,
      qualifyResult(backendId, entry, field),
    ]),
  );
}

/** Both inputs are cloned manifests; rewrite only documentation, never schema values. */
function qualifySchemaDescriptions(value: unknown, prefix: string): void {
  if (typeof value !== "object" || value === null) return;
  if ("description" in value && typeof value.description === "string")
    value.description = value.description.replaceAll("browser_", prefix);
  for (const child of Object.values(value))
    qualifySchemaDescriptions(child, prefix);
}

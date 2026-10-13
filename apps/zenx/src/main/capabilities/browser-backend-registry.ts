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
  BrowserThreadTarget,
} from "./browser-thread-observation.js";

type BackendId = "workspace" | "connected";
const workspacePrefix = "browser_workspace_";
const maxTrackedThreads = 512;
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
    version: "1.0.6",
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

/** Process-local resource routing only; no new Thread history or permission authority. */
export class BrowserBackendRegistry implements ZenXCapabilityPackage {
  readonly manifest = concurrentBrowserManifest();
  readonly #packages = new Map<BackendId, BrowserZenXCapabilityPackage>();
  readonly #connectedUnavailable: string;
  readonly #lastAction = new Map<
    string,
    { backendId: BackendId; sessionId: string }
  >();
  readonly #observers = new Set<{
    threadId: string;
    refresh: () => void;
    stop: () => void;
    retire: () => void;
  }>();
  #closed = false;

  constructor(
    workspace: ZenXBrowserBackend,
    connected?: ZenXBrowserBackend,
    connectedUnavailable = "Enable the external browser connection in Settings, restart ZenX, and connect the extension.",
  ) {
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

  async invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    if (this.#closed) throw new Error("Browser registry is closed");
    const tool = this.manifest.tools.find((entry) => entry.name === toolName);
    if (tool === undefined)
      throw new Error(`Unsupported browser tool: ${toolName}`);
    const backendId: BackendId = toolName.startsWith(connectedPrefix)
      ? "connected"
      : "workspace";
    const selected = this.#packages.get(backendId);
    if (selected === undefined)
      throw new Error(
        `Connected browser unavailable: ${this.#connectedUnavailable}`,
      );
    const args = { ...invocation.arguments };
    for (const key of referenceKeys) {
      if (args[key] !== undefined)
        args[key] = unqualify(backendId, args[key], key);
    }
    const canonicalName = toolName.replace(
      backendId === "connected" ? connectedPrefix : workspacePrefix,
      "browser_",
    );
    const result = await selected.invoke(canonicalName, {
      ...invocation,
      name: canonicalName,
      arguments: args,
    });
    const threadId = invocation.threadId;
    if (!this.#closed && threadId !== undefined) {
      if (canonicalName === "browser_close_session") {
        const last = this.#lastAction.get(threadId);
        if (last?.backendId === backendId && last.sessionId === args.sessionId)
          this.#lastAction.delete(threadId);
      } else if (canonicalName !== "browser_list_tabs") {
        // A bounded UI preference only. Listing or a failed action cannot move it.
        this.#lastAction.delete(threadId);
        this.#lastAction.set(threadId, {
          backendId,
          sessionId: args.sessionId as string,
        });
        if (this.#lastAction.size > maxTrackedThreads)
          this.#lastAction.delete(this.#lastAction.keys().next().value!);
      }
      if (canonicalName !== "browser_list_tabs")
        for (const observer of [...this.#observers])
          if (observer.threadId === threadId) observer.refresh();
    }
    const project = (value: unknown) => ({
      ...(qualifyResult(backendId, value) as object),
      backendId,
    });
    return Array.isArray(result) ? result.map(project) : project(result);
  }

  observeThread(
    request: BrowserThreadRequest,
    listener: BrowserThreadListener,
  ): () => void {
    const targets = new Map<BackendId, BrowserThreadTarget[]>();
    const childSelections = new Map<BackendId, string>();
    let active = true;
    let selectedId: string | undefined;
    let stopFrames: (() => void) | undefined;
    let frameGeneration = 0;
    let refreshGeneration = 0;
    const stops: Array<() => void> = [];
    const stop = () => {
      if (!active) return;
      active = false;
      ++frameGeneration;
      this.#observers.delete(observer);
      const cleanup = [stopFrames, ...stops];
      stopFrames = undefined;
      stops.length = 0;
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
      const lastBackend = this.#lastAction.get(request.threadId)?.backendId;
      const priorBackend = all.find(
        (target) => target.id === selectedId,
      )?.backendId;
      const following = lastBackend ?? priorBackend;
      const next =
        request.targetId === undefined
          ? (all.find(
              (target) =>
                target.id ===
                (following === undefined
                  ? undefined
                  : childSelections.get(following)),
            ) ?? all.at(-1))
          : all.find((target) => target.id === request.targetId);
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
          message: "No browser page is selected for live observation.",
        });
        return;
      }
      const backendId = next.backendId as BackendId;
      const dispose = this.#packages.get(backendId)!.observeThread(
        {
          ...request,
          targetId: unqualify(backendId, next.id, "targetId"),
        },
        (event) => {
          if (
            active &&
            generation === frameGeneration &&
            event.type !== "targets"
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
      stop,
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
    this.#observers.add(observer);
    for (const [backendId, capability] of this.#packages) {
      if (!active) break;
      const dispose = capability.observeThread(
        { threadId: request.threadId, frames: false },
        (event) => {
          if (!active || event.type !== "targets") return;
          targets.set(
            backendId,
            event.targets.map((target) => ({
              ...target,
              backendId,
              id: qualify(backendId, target.id),
              tabId: qualify(backendId, target.tabId),
            })),
          );
          if (event.selectedId === undefined) childSelections.delete(backendId);
          else
            childSelections.set(
              backendId,
              qualify(backendId, event.selectedId),
            );
          refresh();
        },
      );
      if (!active) dispose();
      else stops.push(dispose);
    }
    return stop;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#lastAction.clear();
    for (const observer of [...this.#observers]) observer.retire();
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
      backendId === "connected" ? connectedPrefix : workspacePrefix,
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

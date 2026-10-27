import type { ModelTool } from "../../../../../src/model.js";
import type { ModelReferenceScope } from "../../../../../src/model-references.js";
import {
  sidebarTabId,
  type ThreadSidebarTab,
} from "../../thread-sidebar-state.js";
import {
  MODEL_REF,
  object,
  record,
  asJson,
  pick,
  only,
} from "./model-facade-fields.js";
export const isSidebarModelTool = (name: string) =>
  name === "zenx_self_control_sidebar_read" ||
  name === "zenx_self_control_sidebar_update";
export function sidebarModelDefinition<T extends ModelTool>(source: T): T {
  const tool = structuredClone(source),
    scope = {
      anyOf: [{ const: "self" }, MODEL_REF],
      description:
        "Authorized scope ref returned by sidebar_read, a local Thread/Room ref, or self for your private Thread. Omit read scope to use product default.",
    };
  const newTab = {
    type: "object",
    properties: {
      kind: {
        enum: [
          "file",
          "webpage",
          "plugin",
          "thread",
          "terminal",
          "computer",
          "custom",
        ],
      },
      path: { type: "string" },
      url: { type: "string" },
      pluginId: { type: "string" },
      panelId: { type: "string" },
      thread: MODEL_REF,
      id: {
        type: "string",
        description:
          "User-authored semantic custom-tab identifier only. Existing tabs use ref.",
      },
    },
    required: ["kind"],
    additionalProperties: false,
  };
  tool.inputSchema = source.name.endsWith("_read")
    ? { type: "object", properties: { scope }, additionalProperties: false }
    : {
        type: "object",
        properties: {
          snapshot: MODEL_REF,
          patch: {
            type: "object",
            properties: {
              open: { type: "boolean" },
              fullscreen: { type: "boolean" },
              tabs: {
                type: "array",
                maxItems: 64,
                items: {
                  anyOf: [
                    {
                      type: "object",
                      properties: { ref: MODEL_REF },
                      required: ["ref"],
                      additionalProperties: false,
                    },
                    newTab,
                  ],
                },
              },
              selectedTab: { anyOf: [MODEL_REF, { type: "null" }] },
            },
            additionalProperties: false,
          },
        },
        required: ["snapshot", "patch"],
        additionalProperties: false,
      };
  tool.description = source.name.endsWith("_read")
    ? "Read authorized sidebar presentation, not screen visibility. Returns semantic scope choices, immutable snapshot and exact existing-tab refs. Paths/URLs stay literal. Default follows current Room/private Thread rules."
    : "Patch sidebar against the exact immutable snapshot. tabs replaces ordered descriptors: preserve existing tabs with {ref}, or add a typed descriptor. selectedTab uses a returned tab ref. Conflict applied:false requires fresh read and deliberate reconsideration, never automatic retry. No file contents are read/written or saved/discarded; existing live membership and resource-owner guards run.";
  return tool;
}
export function decodeSidebarArguments(
  name: string,
  input: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  const args = structuredClone(input);
  if (name.endsWith("_read")) {
    only(args, ["scope"]);
    if (args.scope === "self")
      args.scope = { kind: "thread", id: refs.ownerThreadId };
    else if (args.scope !== undefined) {
      const binding = refs.lookup(args.scope);
      if (binding?.namespace === "rooms" && binding.kind === "room")
        args.scope = {
          kind: "room",
          id: object(refs.resolve(args.scope, "rooms", "room")).id,
        };
      else if (binding?.namespace === "threads" && binding.kind === "thread") {
        const bound = object(refs.resolve(args.scope, "threads", "thread"));
        if (bound.device !== "local")
          throw Error("Sidebar scope requires a local Thread");
        args.scope = { kind: "thread", id: bound.id };
      } else args.scope = refs.resolve(args.scope, "sidebar", "scope");
    }
    return args;
  }
  only(args, ["snapshot", "patch"]);
  const baseline = object(
      refs.resolve(args.snapshot, "sidebar", "snapshot", epoch),
    ),
    patch = object(args.patch);
  only(patch, ["open", "fullscreen", "tabs", "selectedTab"]);
  const tabBinding = (ref: unknown) => {
    const bound = object(refs.resolve(ref, "sidebar", "tab", epoch));
    if (JSON.stringify(bound.owner) !== JSON.stringify(baseline.owner))
      throw Error("Sidebar tab belongs to another scope");
    return bound;
  };
  if (Array.isArray(patch.tabs))
    patch.tabs = patch.tabs.map((value) => {
      const tab = object(value);
      if (tab.ref !== undefined) {
        only(tab, ["ref"]);
        return tabBinding(tab.ref).tab;
      }
      only(tab, ["kind", "path", "url", "pluginId", "panelId", "thread", "id"]);
      if (["browser", "external-browser"].includes(String(tab.kind)))
        throw Error(
          "Preserve existing Browser sidebar tabs by their exact returned ref; new Browser descriptors need the Browser typed-ref boundary",
        );
      if (tab.id !== undefined && tab.kind !== "custom")
        throw Error(
          "New webpage tabs mint their own identity; preserve existing tabs by ref",
        );
      if (tab.kind === "thread") {
        const bound = object(refs.resolve(tab.thread, "threads", "thread"));
        if (bound.device !== "local")
          throw Error("Sidebar Thread tab must be local");
        return { kind: "thread", threadId: bound.id };
      }
      return tab;
    });
  if (patch.selectedTab !== undefined && patch.selectedTab !== null)
    patch.selectedTab = tabBinding(patch.selectedTab).id;
  return { scope: baseline.owner, expectedRevision: baseline.revision, patch };
}
export function projectSidebarResult(
  result: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  const scope = (value: unknown): unknown => {
    const entry = record(value);
    if (!entry) return value;
    return {
      ref: refs.bind(
        "sidebar",
        "scope",
        asJson({ kind: entry.kind, id: entry.id }),
      ),
      kind: entry.kind,
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    };
  };
  const output = pick(result, [
    "visibility",
    "defaultReason",
    "applied",
    "status",
    "error",
  ]);
  if (result.effectiveScope) output.scope = scope(result.effectiveScope);
  if (Array.isArray(result.authorizedScopes))
    output.authorizedScopes = result.authorizedScopes.map(scope);
  const state = record(result.state);
  if (!state) return output;
  const owner = object(state.owner),
    tabRefs = new Map<string, string>();
  const tabs = Array.isArray(state.tabs)
    ? state.tabs.map((value) => {
        const tab = object(value),
          id = sidebarTabId(tab as unknown as ThreadSidebarTab),
          ref = refs.bind("sidebar", "tab", asJson({ owner, id, tab }), epoch);
        tabRefs.set(id, ref);
        return {
          ref,
          ...pick(tab, ["kind", "path", "url", "pluginId", "panelId"]),
          ...(tab.kind === "custom" ? { id: tab.id } : {}),
          ...(typeof tab.threadId === "string"
            ? {
                thread: refs.bind("threads", "thread", {
                  id: tab.threadId,
                  device: "local",
                }),
              }
            : {}),
          ...(typeof tab.resourceThreadId === "string"
            ? {
                resourceThread: refs.bind("threads", "thread", {
                  id: tab.resourceThreadId,
                  device: "local",
                }),
              }
            : {}),
        };
      })
    : [];
  output.snapshot = refs.bind(
    "sidebar",
    "snapshot",
    asJson({ owner, revision: state.revision }),
    epoch,
  );
  output.state = {
    ...pick(state, ["open", "fullscreen"]),
    tabs,
    selectedTab:
      typeof state.selectedTab === "string"
        ? (tabRefs.get(state.selectedTab) ?? null)
        : null,
    ...(typeof state.resourceThreadId === "string"
      ? {
          resourceThread: refs.bind("threads", "thread", {
            id: state.resourceThreadId,
            device: "local",
          }),
        }
      : {}),
  };
  return output;
}

import { browserSidebarDescriptor } from "./model-browser-facade.js";
import {
  attachBrowserSidebarTargets,
  type BrowserModelRoute,
} from "./model-browser-metadata.js";
import type { ModelTool } from "../../../../../src/model.js";
import type { ModelReferenceScope } from "../../../../../src/model-references.js";
import { informationEditSchema } from "../../information-layout.js";
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
          "browser",
          "external-browser",
          "custom",
        ],
      },
      path: { type: "string" },
      url: { type: "string" },
      pluginId: { type: "string" },
      panelId: { type: "string" },
      thread: MODEL_REF,
      tab: MODEL_REF,
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
    ? {
        type: "object",
        properties: {
          scope,
          includeInformation: { type: "boolean" },
          cursor: MODEL_REF,
          pageSize: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      }
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
              information: informationEditSchema(MODEL_REF),
            },
            additionalProperties: false,
          },
        },
        required: ["snapshot", "patch"],
        additionalProperties: false,
      };
  tool.description = source.name.endsWith("_read")
    ? "Read authorized sidebar presentation, not screen visibility. The sidebar belongs to its owner and a Room's sidebar is that Room's, one shared state for all its members, so its presentation is not a per-viewer view. Returns semantic scope choices, immutable snapshot and exact existing-tab refs. includeInformation returns a paged static component catalog/layout, never provider content or availability. Follow cursor without scope to read remaining instances; pageSize is a response preference, not a component limit. Default follows current Room/private Thread rules."
    : "Patch sidebar against the exact immutable snapshot. The sidebar belongs to its owner: a Room's sidebar is that Room's shared state, so every member sees the result of open/fullscreen/selectedTab and of the tab list you write. tabs is a whole-list replacement for the same reason; keep the descriptors you want to stay and read again before replacing. information accepts local add/move/set/remove/reset operations against a snapshot from includeInformation; instance id/before use widget refs, never native owner/binding IDs. Ordinary local edits preserve unseen instances; explicit reset only restores ordering/visibility as described. No content/Ask state is modified. Another member's opaque widget may only be moved. Conflict applied:false requires fresh read and deliberate reconsideration, never automatic retry; no foreground navigation or provider execution.";
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
    only(args, ["scope", "includeInformation", "cursor", "pageSize"]);
    if (args.cursor !== undefined) {
      if (args.scope !== undefined || args.includeInformation === false)
        throw Error("Information cursor already binds its exact scope");
      const cursor = object(
        refs.resolve(args.cursor, "sidebar", "information-cursor", epoch),
      );
      return {
        scope: cursor.owner,
        includeInformation: true,
        informationPage: {
          offset: cursor.offset,
          revision: cursor.revision,
          basis: cursor.basis,
          ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        },
      };
    }
    if (args.pageSize !== undefined) {
      if (args.includeInformation !== true)
        throw Error("pageSize requires includeInformation");
      args.informationPage = { pageSize: args.pageSize };
      delete args.pageSize;
    }
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
  only(patch, ["open", "fullscreen", "tabs", "selectedTab", "information"]);
  if (patch.information !== undefined) {
    if (typeof baseline.informationBase !== "string")
      throw Error("Read includeInformation before editing components");
    const information = object(patch.information);
    only(information, ["operations"]);
    if (!Array.isArray(information.operations))
      throw Error("Information operations required");
    const widgetId = (value: unknown) => {
      const widget = object(
        refs.resolve(value, "sidebar", "information-widget", epoch),
      );
      if (
        JSON.stringify(widget.owner) !== JSON.stringify(baseline.owner) ||
        widget.revision !== baseline.revision ||
        widget.basis !== baseline.informationBase
      )
        throw Error(
          "Information reference belongs to another scope or snapshot",
        );
      return widget.id;
    };
    information.operations = information.operations.map((value) => {
      const operation = object(value);
      if (operation.op === "add")
        only(operation, ["op", "type", "config", "before"]);
      else if (operation.op === "move") only(operation, ["op", "id", "before"]);
      else if (operation.op === "set")
        only(operation, ["op", "id", "visible", "collapsed", "config"]);
      else if (operation.op === "remove") only(operation, ["op", "id"]);
      else if (operation.op === "reset") only(operation, ["op"]);
      else throw Error("Unknown information operation");
      return {
        ...operation,
        ...(operation.id === undefined ? {} : { id: widgetId(operation.id) }),
        ...(operation.before === undefined || operation.before === null
          ? {}
          : { before: widgetId(operation.before) }),
      };
    });
  }
  const tabBinding = (ref: unknown) => {
    const bound = object(refs.resolve(ref, "sidebar", "tab", epoch));
    if (JSON.stringify(bound.owner) !== JSON.stringify(baseline.owner))
      throw Error("Sidebar tab belongs to another scope");
    return bound;
  };
  const browserTargets: BrowserModelRoute[] = [];
  if (Array.isArray(patch.tabs))
    patch.tabs = patch.tabs.map((value) => {
      const tab = object(value);
      if (tab.ref !== undefined) {
        only(tab, ["ref"]);
        return tabBinding(tab.ref).tab;
      }
      only(tab, [
        "kind",
        "path",
        "url",
        "pluginId",
        "panelId",
        "thread",
        "id",
        "tab",
      ]);
      if (["browser", "external-browser"].includes(String(tab.kind))) {
        only(tab, ["kind", "tab"]);
        const browser = browserSidebarDescriptor(
          tab.tab,
          tab.kind,
          refs,
          epoch,
        );
        browserTargets.push(browser.route);
        return browser.tab;
      }
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
  const output = {
    scope: baseline.owner,
    expectedRevision: baseline.revision,
    ...(patch.information === undefined
      ? {}
      : { informationBase: baseline.informationBase }),
    patch,
  };
  return browserTargets.length
    ? attachBrowserSidebarTargets(output, browserTargets)
    : output;
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
  const information = record(result.information);
  output.snapshot = refs.bind(
    "sidebar",
    "snapshot",
    asJson({
      owner,
      revision: state.revision,
      ...(information ? { informationBase: information.basis } : {}),
    }),
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
  if (information) {
    output.information = {
      ...pick(information, [
        "catalog",
        "content",
        "availability",
        "offset",
        "total",
        "hasMore",
      ]),
      widgets: Array.isArray(information.widgets)
        ? information.widgets.map((value) => {
            const widget = object(value);
            return {
              ref: refs.bind(
                "sidebar",
                "information-widget",
                asJson({
                  owner,
                  revision: state.revision,
                  basis: information.basis,
                  id: widget.id,
                }),
                epoch,
              ),
              ...pick(widget, ["type", "visible", "collapsed", "editable"]),
              ...(widget.editable === true ? pick(widget, ["config"]) : {}),
            };
          })
        : [],
      cursor:
        typeof information.nextOffset === "number"
          ? refs.bind(
              "sidebar",
              "information-cursor",
              asJson({
                owner,
                revision: state.revision,
                basis: information.basis,
                offset: information.nextOffset,
              }),
              epoch,
            )
          : null,
    };
  }
  return output;
}

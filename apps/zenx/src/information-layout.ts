import type { SidebarOwner } from "./thread-sidebar-state.js";
import { normalizeBoardInstanceKey } from "../../../packages/zenx-board-plugin/src/board.js";

/** Static definitions only: neither provider availability nor provider content. */
export const informationCatalog = [
  { type: "pull-requests", title: "Related pull requests", source: "thread" },
  { type: "lineage", title: "Subagents", source: "thread" },
  { type: "artifacts", title: "Related artifacts", source: "thread" },
  { type: "triggers", title: "Triggers", source: "thread" },
  { type: "shell", title: "Background commands", source: "thread" },
  { type: "room-members", title: "Room members", source: "room" },
  {
    type: "board",
    title: "Board",
    source: "owner",
  },
] as const;
export type InformationType = (typeof informationCatalog)[number]["type"];
type Configurations = {
  "pull-requests": Record<never, never>;
  lineage: Record<never, never>;
  artifacts: Record<never, never>;
  triggers: { filter: "all" | "timer" | "event"; showPaused: boolean };
  shell: Record<never, never>;
  "room-members": Record<never, never>;
  board: { instanceKey: string };
};
export type InformationBinding =
  { kind: "owner" } | { kind: "member"; resourceThreadId: string };
export type InformationWidget = {
  [K in InformationType]: {
    id: string;
    type: K;
    binding: InformationBinding;
    visible: boolean;
    collapsed: boolean;
    config: Configurations[K];
  };
}[InformationType];
export interface InformationLayout {
  version: 1;
  widgets: InformationWidget[];
}
/** Host-bound operations; model/UI edits are admitted before reaching this codec. */
export type InformationOperation =
  | { op: "add"; widget: InformationWidget; before: string | null }
  | { op: "move"; id: string; before: string | null }
  | {
      op: "set";
      id: string;
      visible?: boolean;
      collapsed?: boolean;
      config?: InformationWidget["config"];
    }
  | { op: "remove"; id: string }
  | { op: "reset"; defaults: InformationLayout };
export interface InformationOperations {
  operations: InformationOperation[];
  /** Exact first-edit defaults are logged; replay never consults a live Room. */
  initial?: InformationLayout;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Information object required");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw Error("Unknown information field");
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw Error("Invalid information identity");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw Error("Information boolean required");
  return value;
}
export function informationDefinition(value: unknown) {
  const definition = informationCatalog.find((entry) => entry.type === value);
  if (!definition) throw Error("Unknown information component type");
  return definition;
}
export function informationConfig(type: InformationType, value: unknown = {}) {
  const config = object(value);
  if (type === "triggers") {
    only(config, ["filter", "showPaused"]);
    const filter = config.filter ?? "all";
    if (filter !== "all" && filter !== "timer" && filter !== "event")
      throw Error("Invalid Trigger display filter");
    return {
      filter,
      showPaused:
        config.showPaused === undefined ? true : bool(config.showPaused),
    };
  }
  if (type === "board") {
    only(config, ["instanceKey"]);
    return { instanceKey: normalizeBoardInstanceKey(config.instanceKey) };
  }
  only(config, []);
  return {};
}
export function parseInformationWidget(value: unknown): InformationWidget {
  const widget = object(value);
  only(widget, ["id", "type", "binding", "visible", "collapsed", "config"]);
  const type = informationDefinition(widget.type).type;
  const source = object(widget.binding);
  let binding: InformationBinding;
  if (source.kind === "owner") {
    only(source, ["kind"]);
    binding = { kind: "owner" };
  } else if (source.kind === "member") {
    only(source, ["kind", "resourceThreadId"]);
    binding = {
      kind: "member",
      resourceThreadId: text(source.resourceThreadId),
    };
  } else throw Error("Invalid information data binding");
  return {
    id: text(widget.id),
    type,
    binding,
    visible: bool(widget.visible),
    collapsed: bool(widget.collapsed),
    config: informationConfig(type, widget.config),
  } as InformationWidget;
}
export function parseInformationLayout(value: unknown): InformationLayout {
  const layout = object(value);
  only(layout, ["version", "widgets"]);
  if (layout.version !== 1 || !Array.isArray(layout.widgets))
    throw Error("Unsupported information layout");
  const widgets = layout.widgets.map(parseInformationWidget);
  if (new Set(widgets.map((widget) => widget.id)).size !== widgets.length)
    throw Error("Duplicate information instance identity");
  // A layout already belongs to one owner. Uniqueness is per document address,
  // not per Board component type; later independent addresses may coexist.
  const boardAddresses = new Set<string>();
  for (const widget of widgets)
    if (widget.type === "board") {
      if (boardAddresses.has(widget.config.instanceKey))
        throw Error("Duplicate Board document placement");
      boardAddresses.add(widget.config.instanceKey);
    }
  return { version: 1, widgets };
}
export function defaultInformationLayout(
  owner: SidebarOwner,
  assistantThreadId?: string,
): InformationLayout {
  const resourceThreadId =
    owner.kind === "thread" ? owner.id : assistantThreadId;
  return {
    version: 1,
    widgets: informationCatalog
      .filter((entry) =>
        entry.source === "thread"
          ? !!resourceThreadId
          : entry.source !== "room" || owner.kind === "room",
      )
      .map((entry) =>
        parseInformationWidget({
          id: `default:${entry.type}${entry.source === "thread" && owner.kind === "room" ? `@${encodeURIComponent(resourceThreadId!)}` : ""}`,
          type: entry.type,
          binding:
            entry.source === "thread" && owner.kind === "room"
              ? { kind: "member", resourceThreadId }
              : { kind: "owner" },
          visible: true,
          collapsed: false,
          config: informationConfig(entry.type),
        }),
      ),
  };
}
export function parseInformationOperations(
  value: unknown,
): InformationOperations {
  const input = object(value);
  only(input, ["operations", "initial"]);
  if (!Array.isArray(input.operations) || input.operations.length === 0)
    throw Error("Information operations required");
  const operations = input.operations.map((value): InformationOperation => {
    const op = object(value);
    if (op.op === "add") {
      only(op, ["op", "widget", "before"]);
      return {
        op: "add",
        widget: parseInformationWidget(op.widget),
        before: op.before === null ? null : text(op.before),
      };
    }
    if (op.op === "reset") {
      only(op, ["op", "defaults"]);
      return { op: "reset", defaults: parseInformationLayout(op.defaults) };
    }
    if (op.op === "move") {
      only(op, ["op", "id", "before"]);
      return {
        op: "move",
        id: text(op.id),
        before: op.before === null ? null : text(op.before),
      };
    }
    if (op.op === "remove") {
      only(op, ["op", "id"]);
      return { op: "remove", id: text(op.id) };
    }
    if (op.op === "set") {
      only(op, ["op", "id", "visible", "collapsed", "config"]);
      if (
        !["visible", "collapsed", "config"].some((key) =>
          Object.hasOwn(op, key),
        )
      )
        throw Error("An information edit must change a presentation field");
      return {
        op: "set",
        id: text(op.id),
        ...(op.visible === undefined ? {} : { visible: bool(op.visible) }),
        ...(op.collapsed === undefined
          ? {}
          : { collapsed: bool(op.collapsed) }),
        ...(op.config === undefined
          ? {}
          : { config: structuredClone(object(op.config)) }),
      };
    }
    throw Error("Unknown information operation");
  });
  return {
    operations,
    ...(input.initial === undefined
      ? {}
      : { initial: parseInformationLayout(input.initial) }),
  };
}
export function applyInformationOperations(
  current: InformationLayout | undefined,
  input: InformationOperations,
): InformationLayout {
  const patch = parseInformationOperations(input);
  if (current && patch.initial)
    throw Error("Information defaults cannot replace a saved layout");
  const layout = parseInformationLayout(current ?? patch.initial);
  for (const operation of patch.operations)
    applyInformationOperation(layout, operation);
  return parseInformationLayout(layout);
}

/** Mutates only an already cloned, validated in-call draft; never persisted state. */
function applyInformationOperation(
  layout: InformationLayout,
  op: InformationOperation,
): void {
  const find = (id: string) => {
    const index = layout.widgets.findIndex((widget) => widget.id === id);
    if (index < 0) throw Error("Information instance is no longer present");
    return index;
  };
  const insert = (widget: InformationWidget, before: string | null) => {
    layout.widgets.splice(
      before === null ? layout.widgets.length : find(before),
      0,
      widget,
    );
  };
  if (op.op === "add") {
    if (layout.widgets.some((widget) => widget.id === op.widget.id))
      throw Error("Information instance already exists");
    const boardAddress =
      op.widget.type === "board" ? op.widget.config.instanceKey : undefined;
    if (
      boardAddress !== undefined &&
      layout.widgets.some(
        (widget) =>
          widget.type === "board" && widget.config.instanceKey === boardAddress,
      )
    )
      throw Error(
        "Duplicate Board document placement: this document is already placed",
      );
    insert(op.widget, op.before);
  } else if (op.op === "reset") {
    const existing = new Map(
      layout.widgets.map((widget) => [widget.id, widget]),
    );
    const restored = op.defaults.widgets.map((widget) => ({
      ...(existing.get(widget.id) ??
        (widget.type === "board"
          ? layout.widgets.find(
              (candidate) =>
                candidate.type === "board" &&
                candidate.config.instanceKey === widget.config.instanceKey,
            )
          : undefined) ??
        widget),
      visible: true,
      collapsed: false,
    }));
    const restoredIds = new Set(restored.map((widget) => widget.id));
    layout.widgets = [
      ...restored,
      ...layout.widgets
        .filter((widget) => !restoredIds.has(widget.id))
        .map((widget) => ({ ...widget, visible: false })),
    ];
  } else {
    const index = find(op.id);
    const widget = layout.widgets[index]!;
    if (op.op === "move") {
      if (op.before === op.id) return;
      layout.widgets.splice(index, 1);
      insert(widget, op.before);
    } else if (op.op === "remove") layout.widgets.splice(index, 1);
    else
      layout.widgets[index] = parseInformationWidget({
        ...widget,
        ...(op.visible === undefined ? {} : { visible: op.visible }),
        ...(op.collapsed === undefined ? {} : { collapsed: op.collapsed }),
        config:
          op.config === undefined
            ? widget.config
            : { ...widget.config, ...op.config },
      });
  }
}

export function canEditInformationWidget(
  widget: InformationWidget,
  callerThreadId: string,
) {
  return (
    widget.binding.kind === "owner" ||
    widget.binding.resourceThreadId === callerThreadId
  );
}

export function assertInformationOwner(
  layout: InformationLayout,
  owner: SidebarOwner,
): void {
  for (const widget of layout.widgets) {
    const source = informationDefinition(widget.type).source;
    if (source === "room" && owner.kind !== "room")
      throw Error("Room information requires a Room owner");
    const binding =
      source === "thread" && owner.kind === "room" ? "member" : "owner";
    if (widget.binding.kind !== binding)
      throw Error(
        "Information binding does not match its owner and component type",
      );
  }
}
/** Pure binding helper shared by trusted entry points; it grants no provider read/action. */
export function bindInformationEdits(
  value: unknown,
  context: {
    owner: SidebarOwner;
    callerThreadId: string;
    current: InformationLayout;
    defaults: InformationLayout;
    /** Already live-admitted member choices from a trusted human entry point. */
    editableThreadIds?: readonly string[];
    newId(): string;
  },
): InformationOperation[] {
  const input = object(value);
  only(input, ["operations"]);
  if (!Array.isArray(input.operations) || input.operations.length === 0)
    throw Error("Information operations required");
  const current = parseInformationLayout(context.current);
  const editable = (widget: InformationWidget) =>
    canEditInformationWidget(widget, context.callerThreadId) ||
    (widget.binding.kind === "member" &&
      context.editableThreadIds?.includes(widget.binding.resourceThreadId));
  return input.operations.map((value) => {
    const edit = object(value);
    let operation: InformationOperation;
    if (edit.op === "add") {
      only(edit, ["op", "type", "config", "before"]);
      const definition = informationDefinition(edit.type);
      let config = informationConfig(definition.type, edit.config);
      if (
        definition.type === "board" &&
        !Object.hasOwn(object(edit.config ?? {}), "instanceKey") &&
        current.widgets.some(
          (widget) =>
            widget.type === "board" && widget.config.instanceKey === "default",
        )
      )
        config = informationConfig("board", {
          instanceKey: `board-${context.newId()}`,
        });
      if (definition.source === "room" && context.owner.kind !== "room")
        throw Error("Room information requires a Room owner");
      operation = {
        op: "add",
        before:
          edit.before === undefined || edit.before === null
            ? null
            : text(edit.before),
        widget: parseInformationWidget({
          id: context.newId(),
          type: definition.type,
          binding:
            definition.source === "thread" && context.owner.kind === "room"
              ? { kind: "member", resourceThreadId: context.callerThreadId }
              : { kind: "owner" },
          visible: true,
          collapsed: false,
          config,
        }),
      };
    } else if (edit.op === "reset") {
      only(edit, ["op"]);
      if (
        [...current.widgets, ...context.defaults.widgets].some(
          (widget) => !editable(widget),
        )
      )
        throw Error("Cannot reset another member's information instances");
      operation = { op: "reset", defaults: context.defaults };
    } else {
      const id = text(edit.id);
      const widget = current.widgets.find((widget) => widget.id === id);
      if (!widget) throw Error("Information instance is no longer present");
      if (edit.op !== "move" && !editable(widget))
        throw Error(
          "Another member's information instance may only be preserved or moved",
        );
      operation = parseInformationOperations({ operations: [edit] })
        .operations[0]!;
      if (
        widget.type === "board" &&
        operation.op === "set" &&
        operation.config !== undefined &&
        "instanceKey" in operation.config &&
        operation.config.instanceKey !== widget.config.instanceKey
      )
        throw Error(
          "A placed Board document cannot be retargeted; remove its placement and add the desired address",
        );
    }
    applyInformationOperation(current, operation);
    return operation;
  });
}

export function informationConfigSchema(type: InformationType) {
  return {
    type: "object",
    properties:
      type === "triggers"
        ? {
            filter: { enum: ["all", "timer", "event"] },
            showPaused: { type: "boolean" },
          }
        : type === "board"
          ? {
              instanceKey: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$",
              },
            }
          : {},
    additionalProperties: false,
  };
}
/** Same operation grammar for native admission and the model's opaque refs. */
export function informationEditSchema(identity: Record<string, unknown>) {
  const operation = (
    properties: Record<string, unknown>,
    required: string[],
  ) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  return operation(
    {
      operations: {
        type: "array",
        minItems: 1,
        items: {
          anyOf: [
            ...informationCatalog.map(({ type }) =>
              operation(
                {
                  op: { const: "add" },
                  type: { const: type },
                  config: informationConfigSchema(type),
                  before: { anyOf: [identity, { type: "null" }] },
                },
                ["op", "type"],
              ),
            ),
            operation(
              {
                op: { const: "move" },
                id: identity,
                before: { anyOf: [identity, { type: "null" }] },
              },
              ["op", "id", "before"],
            ),
            operation(
              {
                op: { const: "set" },
                id: identity,
                visible: { type: "boolean" },
                collapsed: { type: "boolean" },
                config: {
                  anyOf: informationCatalog.map(({ type }) =>
                    informationConfigSchema(type),
                  ),
                },
              },
              ["op", "id"],
            ),
            operation({ op: { const: "remove" }, id: identity }, ["op", "id"]),
            {
              ...operation({ op: { const: "reset" } }, ["op"]),
              description:
                "Explicitly restore default order/visibility and hide extra instances, preserving all configurations and bindings. Refused if any affected instance belongs to another member.",
            },
          ],
        },
      },
    },
    ["operations"],
  );
}

export function informationPage(
  layout: InformationLayout,
  revision: number,
  callerThreadId: string,
  value: unknown = {},
  basis = "saved",
) {
  const request = object(value);
  only(request, ["offset", "pageSize", "revision", "basis"]);
  if (
    (request.revision !== undefined && request.revision !== revision) ||
    (request.basis !== undefined && request.basis !== basis)
  )
    throw Error(
      "Information layout changed; start a fresh read instead of continuing this page",
    );
  const offset = request.offset ?? 0;
  // A response page, not a component-count limit. Callers can request any safe
  // positive page size, and all subsequent pages remain explicitly reachable.
  const pageSize = request.pageSize ?? 50;
  if (
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    (offset as number) > layout.widgets.length ||
    !Number.isSafeInteger(pageSize) ||
    (pageSize as number) < 1
  )
    throw Error("Invalid information page");
  const end = Math.min(
    layout.widgets.length,
    (offset as number) + (pageSize as number),
  );
  return {
    catalog: informationCatalog.map((definition) => ({
      ...definition,
      configSchema: informationConfigSchema(definition.type),
      defaultConfig: informationConfig(definition.type),
    })),
    content: "not-read" as const,
    availability: "not-observed" as const,
    revision,
    basis,
    offset,
    total: layout.widgets.length,
    hasMore: end < layout.widgets.length,
    nextOffset: end < layout.widgets.length ? end : null,
    widgets: layout.widgets.slice(offset as number, end).map((widget) => {
      const editable = canEditInformationWidget(widget, callerThreadId);
      return {
        id: widget.id,
        type: widget.type,
        visible: widget.visible,
        collapsed: widget.collapsed,
        editable,
        ...(editable ? { config: structuredClone(widget.config) } : {}),
      };
    }),
  };
}

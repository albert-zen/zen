/** Model-facing Browser vocabulary. This module has no Host, Core or native provider dependency. */
export const browserModelDocument =
  "Browser refs bind an exact backend, tab, observation and owner. Inspect gives a bounded capture; query searches captured targets only, and cursor continues that immutable capture. Actions observe by default with a small captured subset; pass since with a retained observation ref for an exact diff, or full:true for a broader self-contained capture. Diffs replace old action refs via targetChanges.replacements. Discard prior continuation pages after every new observation or first-page diff and follow the new nextCursor. Human takeover requires fresh inspection after return. After actionCompleted plus observationError inspect again; never replay unknown effects.";
export const browserOperations = [
  "list_tabs",
  "open",
  "navigate",
  "inspect",
  "click",
  "type",
  "select",
  "scroll",
  "pointer_click",
  "key_press",
  "close",
  "close_session",
] as const;

export function browserOperation(name: string): string {
  return name.replace(/^browser_(?:workspace_|connected_)?/u, "");
}

export function browserNamespace(
  name: string,
): "workspace" | "connected" | "legacy" {
  return name.startsWith("browser_workspace_")
    ? "workspace"
    : name.startsWith("browser_connected_")
      ? "connected"
      : "legacy";
}

export const browserModelDescriptions: Readonly<Record<string, string>> = {
  list_tabs:
    "List tabs in one semantic session. Use the exact returned tab refs.",
  open: "Open an HTTP(S) page in a background Browser tab. Observes by default.",
  navigate:
    "Navigate the exact tab. Shared Workspace tabs may require a post-takeover observation.",
  inspect:
    "Capture one bounded tab view. Optional query filters actual captured role/name/value targets; cursor continues the same capture.",
  click:
    "Click an exact observed target; optional newer observation ref revalidates a retained target.",
  type: "Replace text in an exact observed target; optional submit can submit its form.",
  select: "Select an option on an exact observed target.",
  scroll: "Scroll the exact observed tab viewport.",
  pointer_click:
    "Click CSS viewport coordinates in the exact observed tab. Requires a real screenshot and inputViewport.",
  key_press: "Press a named key in the exact tab's already-focused element.",
  close:
    "Close the exact tab. Shared Workspace tabs may require a post-takeover observation.",
  close_session: "Close the exact session and its tabs.",
};

export const sessionTools = new Set(["list_tabs", "open", "close_session"]);
export const targetTools = new Set(["click", "type", "select"]);
export const observationTools = new Set([
  "scroll",
  "pointer_click",
  "key_press",
]);
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildBrowserModelDefinition<
  T extends {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  },
>(source: T, MODEL_REF: Readonly<Record<string, unknown>>): T {
  const tool = structuredClone(source),
    op = browserOperation(tool.name),
    fields: Record<string, unknown> = {},
    required: string[] = [];
  if (op !== "connections") {
    if (sessionTools.has(op)) {
      fields.session =
        op === "close_session"
          ? MODEL_REF
          : {
              type: "string",
              description:
                "Semantic session name or exact session ref; defaults to main.",
            };
      if (op === "close_session") required.push("session");
      if (browserNamespace(tool.name) === "connected")
        fields.connection = MODEL_REF;
    } else {
      const field = targetTools.has(op)
        ? "target"
        : observationTools.has(op)
          ? "observation"
          : "tab";
      fields[field] = MODEL_REF;
      if (op === "inspect") {
        fields.cursor = MODEL_REF;
        fields.query = { type: "string", minLength: 1, maxLength: 120 };
      } else required.push(field);
      if (op === "navigate" || op === "close" || targetTools.has(op))
        fields.observation = MODEL_REF;
    }
    const native = asRecord(tool.inputSchema.properties) ?? {};
    for (const key of [
      "url",
      "text",
      "submit",
      "option",
      "direction",
      "pixels",
      "x",
      "y",
      "key",
      "observe",
      "full",
    ])
      if (native[key] !== undefined) fields[key] = native[key];
    if (
      op === "inspect" ||
      [
        "open",
        "navigate",
        "click",
        "type",
        "select",
        "scroll",
        "pointer_click",
        "key_press",
      ].includes(op)
    )
      fields.since = {
        ...MODEL_REF,
        description:
          "Exact retained observation ref to compare with the new capture.",
      };
    for (const key of Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required
      : [])
      if (
        [
          "url",
          "text",
          "option",
          "direction",
          "pixels",
          "x",
          "y",
          "key",
        ].includes(String(key))
      )
        required.push(String(key));
  }
  tool.inputSchema = {
    type: "object",
    properties: fields,
    required,
    additionalProperties: false,
    ...(op === "inspect"
      ? { oneOf: [{ required: ["tab"] }, { required: ["cursor"] }] }
      : {}),
  };
  tool.description = `${op}: ${browserModelDescriptions[op] ?? tool.description}`;
  return tool;
}

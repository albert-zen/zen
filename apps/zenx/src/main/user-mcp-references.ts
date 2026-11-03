/** Transport envelopes only typed facade reference slots, never authored string data. */
export function mapUserMcpReferences(
  name: string,
  value: Record<string, unknown>,
  direction: "input" | "output",
  map: (ref: unknown) => string,
): void {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const fields = (value: unknown, keys: readonly string[]) => {
    const entry = record(value);
    if (!entry) return;
    for (const key of keys)
      if (entry[key] !== undefined && entry[key] !== null)
        entry[key] = map(entry[key]);
  };
  const each = (value: unknown, visit: (value: unknown) => void) => {
    if (Array.isArray(value)) value.forEach(visit);
  };
  const actions = (value: unknown) => {
    each(value, (value) => {
      const action = record(value);
      if (!action) return;
      const target = record(action.target);
      if (
        action.kind === "navigate" &&
        (target?.kind === "browser" || target?.kind === "external-browser")
      )
        fields(target, ["tab"]);
      if (action.kind === "if") {
        actions(action.then);
        actions(action.otherwise);
      }
    });
  };
  fields(value, ["snapshot"]);
  if (name.startsWith("zenx_board_")) {
    fields(value.owner, ["room"]);
    const document = record(value.document);
    fields(document?.owner, ["room"]);
    each(document?.events, (event) => actions(record(event)?.actions));
    return;
  }
  if (name.startsWith("zenx_self_control_sidebar_")) {
    if (direction === "input") {
      fields(value, ["cursor"]);
      const patch = record(value.patch);
      fields(patch, ["selectedTab"]);
      each(patch?.tabs, (tab) => fields(tab, ["ref", "thread", "tab"]));
      each(record(patch?.information)?.operations, (op) =>
        fields(op, ["id", "before"]),
      );
      return;
    }
    fields(value.scope, ["ref"]);
    each(value.authorizedScopes, (scope) => fields(scope, ["ref"]));
    const state = record(value.state);
    fields(state, ["selectedTab", "resourceThread"]);
    each(state?.tabs, (tab) =>
      fields(tab, ["ref", "thread", "resourceThread"]),
    );
    const information = record(value.information);
    fields(information, ["cursor"]);
    each(information?.widgets, (widget) => fields(widget, ["ref"]));
    return;
  }
  if (name === "zenx_threads_read") {
    if (direction === "input") {
      fields(value, ["cursor", "turn", "item", "through"]);
      return;
    }
    const summary = (value: unknown) => {
      fields(value, ["ref", "parent", "source"]);
      fields(record(value)?.lastTurn, ["turn"]);
    };
    const item = (value: unknown) =>
      fields(value, ["ref", "turn", "sourceRef"]);
    fields(value, [
      "ref",
      "turn",
      "activeTurn",
      "item",
      "message",
      "through",
      "nextCursor",
      "parent",
    ]);
    fields(value.lastTurn, ["turn"]);
    summary(value.thread);
    each(value.threads, summary);
    each(value.candidates, summary);
    each(value.items, item);
    each(value.turns, (turn) => {
      fields(turn, ["turn"]);
      each(record(turn)?.items, item);
    });
    const delivery = record(value.delivery);
    if (delivery) mapUserMcpReferences(name, delivery, direction, map);
  }
}

/** Rewrite only schema nodes, without inspecting any user-authored payload. */
export function mapUserMcpReferenceSchema(
  schema: Record<string, unknown>,
  pattern: string,
): void {
  if (schema.pattern === "^r[1-9][0-9]*$") {
    schema.pattern = pattern;
    schema.description = "Exact scoped reference from this MCP connection.";
  }
  const visit = (value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value))
      mapUserMcpReferenceSchema(value as Record<string, unknown>, pattern);
  };
  if (schema.properties && typeof schema.properties === "object")
    Object.values(schema.properties).forEach(visit);
  visit(schema.items);
  for (const key of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(schema[key])) schema[key].forEach(visit);
}

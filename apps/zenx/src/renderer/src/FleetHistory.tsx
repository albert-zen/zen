/** Public snapshot rendering only; never resolves target assets against local files. */
export function FleetHistory({ value }: { value: unknown }) {
  const items = record(value).items;
  if (!Array.isArray(items))
    return <p>Read the remote Thread to view its public history</p>;
  if (!items.length) return <p>No history items returned</p>;
  return (
    <>
      {items.map((entry, index) => {
        const row = record(entry);
        const item = record(row.item ?? row);
        const type = string(row.type ?? item.type);
        const explicit = string(row.text ?? row.preview);
        const text =
          type === "reasoning" && item.contentVisibility === "opaque"
            ? string(item.summary) || "Private reasoning is not displayed"
            : explicit ||
              string(
                item.text ?? item.output ?? item.message ?? item.summary,
              ) ||
              contentText(item.content);
        const message = type === "user_message" || type === "agent_message";
        const label =
          type === "user_message"
            ? "You"
            : type === "agent_message"
              ? "Agent"
              : type.replaceAll("_", " ") || "Item";
        const detail =
          type === "tool_call"
            ? text || JSON.stringify(item.arguments ?? {}, null, 2)
            : text;
        const summary =
          type === "tool_call"
            ? string(item.name) || label
            : type === "turn_completed"
              ? `Turn ${string(item.status) || "completed"}`
              : type === "model_usage"
                ? `Usage · ${String(item.inputTokens ?? "?")} input / ${String(item.outputTokens ?? "?")} output tokens`
                : label;
        const truncated =
          row.truncated || row.textTruncated || detail.length > 16384;
        return (
          <article key={string(row.itemId ?? row.id ?? item.id) || index}>
            {message ? (
              <>
                <strong>{label}</strong>
                <p className="fleet-history-text">
                  {text.slice(0, 16384) || "Remote attachment"}
                </p>
              </>
            ) : detail ? (
              <details>
                <summary>{summary}</summary>
                <p className="fleet-history-text">{detail.slice(0, 16384)}</p>
              </details>
            ) : (
              <small className="settings-note">{summary}</small>
            )}
            {truncated ? (
              <small className="settings-note">Bounded excerpt</small>
            ) : null}
          </article>
        );
      })}
    </>
  );
}
function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      const item = record(block);
      return item.type === "text"
        ? string(item.text)
        : item.type === "image"
          ? "[Remote image attachment]"
          : "";
    })
    .filter(Boolean)
    .join("\n");
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

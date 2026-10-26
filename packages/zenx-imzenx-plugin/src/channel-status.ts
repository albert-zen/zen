export type ImZenXChannelState =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "disconnected"
  | "failed"
  | "unknown";

export interface ImZenXChannelStatus {
  id: "qq" | "telegram" | "feishu" | "weixin";
  state: ImZenXChannelState;
}

const ids = new Set(["qq", "telegram", "feishu", "weixin"]);
const states = new Set([
  "connecting",
  "ready",
  "reconnecting",
  "disconnected",
  "failed",
  "unknown",
]);

/** The private pipe exposes fixed connection facts, never raw diagnostics. */
export function readChannelStatus(
  value: Record<string, unknown>,
): ImZenXChannelStatus[] | undefined {
  if (
    value.type !== "channel-status" ||
    Object.keys(value).some((key) => !["type", "channels"].includes(key))
  )
    return;
  if (!Array.isArray(value.channels) || value.channels.length > ids.size)
    return;
  const result: ImZenXChannelStatus[] = [];
  const seen = new Set<string>();
  for (const item of value.channels) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !["id", "state"].includes(key)) ||
      !ids.has(item.id) ||
      !states.has(item.state) ||
      seen.has(item.id)
    )
      return;
    seen.add(item.id);
    result.push({ id: item.id, state: item.state });
  }
  return result;
}

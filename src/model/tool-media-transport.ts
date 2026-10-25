import type { UserInput } from "../item.js";

/** Host-owned evidence for an exact transport target, never Thread state. */
export interface ChatToolMediaCapability {
  readonly protocol: "chat-completions";
  /** Fully resolved request URL, not a provider label or URL prefix. */
  readonly endpoint: string;
  readonly model: string;
  readonly media: readonly ("image" | "audio")[];
  /** Human-readable documentation or verification reference; not sent on wire. */
  readonly evidence: string;
  /** Date the transport evidence was reviewed (YYYY-MM-DD), not a live probe. */
  readonly reviewedOn: string;
}

export interface ToolMediaTransportDecision {
  readonly encoding: "native-tool-content" | "user-after-tool-batch";
  readonly reason: "declared-support" | "unknown-target" | "undeclared-media";
}

/** Pure selection: no probes, retries, provider-name guesses or media removal. */
export function selectChatToolMediaTransport(
  capabilities: readonly ChatToolMediaCapability[],
  endpoint: string,
  model: string,
  content: UserInput,
): ToolMediaTransportDecision {
  const declared = capabilities.filter(
    (entry) =>
      entry.protocol === "chat-completions" &&
      entry.endpoint === endpoint &&
      entry.model === model &&
      entry.evidence.trim().length > 0 &&
      /^\d{4}-\d{2}-\d{2}$/u.test(entry.reviewedOn),
  );
  if (declared.length === 0)
    return { encoding: "user-after-tool-batch", reason: "unknown-target" };
  const media = content.filter((part) => part.type !== "text");
  // One declaration must cover the entire result. Never split a result's
  // modalities across contradictory/partial transport declarations.
  if (
    declared.some((entry) =>
      media.every((part) => entry.media.includes(part.type)),
    )
  )
    return { encoding: "native-tool-content", reason: "declared-support" };
  return { encoding: "user-after-tool-batch", reason: "undeclared-media" };
}

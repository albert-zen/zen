/** Synthetic native observations with no public text, summary, or opaque payload. */
import type { CanonicalItem } from "../../../../src/item.js";
import {
  applyNativeThreadEvent,
  projectNativeRecovery,
} from "../../src/renderer/src/thread-view-state.js";
import { nativeRecoveryForThread } from "../native-recovery-fixture.js";
import { runtimeThread } from "./agent-runtime-data.js";

export type EmptyReasoningPhase =
  | "started"
  | "completed"
  | "interrupted"
  | "restored-completed"
  | "restored-interrupted";

export function emptyReasoningScenario(phase: EmptyReasoningPhase) {
  let thread = runtimeThread([], "inProgress", "synthetic-empty-reasoning");
  const turnId = thread.turns[0]!.id;
  thread.turns[0]!.items.push({
    type: "userMessage",
    id: "empty-user",
    clientId: null,
    content: [
      { type: "text", text: "保留没有摘要或正文的思考项。", text_elements: [] },
    ],
  });
  thread = applyNativeThreadEvent(thread, {
    type: "item_started",
    threadId: thread.id,
    turnId,
    itemId: "empty-observation",
    itemType: "reasoning",
  });
  if (phase === "started") return thread;
  const interrupted = phase.endsWith("interrupted");
  const observation: CanonicalItem = {
    type: "reasoning",
    id: "empty-observation",
    threadId: thread.id,
    turnId,
    createdAt: "2026-11-04T14:00:00.000Z",
    contentVisibility: "public",
    reasoningContent: "",
    ...(interrupted ? { incomplete: true as const } : {}),
  };
  thread = applyNativeThreadEvent(thread, {
    type: "item_completed",
    item: observation,
  });
  thread = applyNativeThreadEvent(thread, {
    type: "turn_completed",
    threadId: thread.id,
    turnId,
    status: interrupted ? "interrupted" : "completed",
  });
  if (!phase.startsWith("restored")) return thread;
  const recovery = nativeRecoveryForThread(thread);
  // Round-trip a native recovery snapshot with the exact canonical empty fact.
  recovery.thread.items = recovery.thread.items.map((item) =>
    item.id === observation.id ? observation : item,
  );
  recovery.thread.turns[0]!.items = recovery.thread.turns[0]!.items.map(
    (item) => (item.id === observation.id ? observation : item),
  );
  return projectNativeRecovery(JSON.parse(JSON.stringify(recovery)));
}

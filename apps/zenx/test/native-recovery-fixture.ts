import type { CanonicalItem, ToolCallItem } from "../../../src/item.js";
import type { NativeThreadRecoverySnapshot } from "../../../src/protocol/native/recovery.js";
import type { Thread, ThreadItem } from "../src/protocol-client/index.js";

export function nativeRecoveryForThread(
  thread: Thread,
  options: {
    processEpoch?: string;
    watermark?: number;
    model?: string;
    modelProvider?: string;
    reasoningEffort?: string | null;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "never" | "on-request";
  } = {},
): NativeThreadRecoverySnapshot {
  const providerProfileId = options.modelProvider ?? thread.modelProvider;
  const modelId = options.model ?? "fake";
  const reasoningEffort =
    options.reasoningEffort === undefined ? "medium" : options.reasoningEffort;
  const sandbox = options.sandbox ?? "danger-full-access";
  const approvalPolicy =
    options.approvalPolicy === "on-request" ? "always" : "never";
  const createdAt = new Date(
    Math.max(1, thread.createdAt) * 1_000,
  ).toISOString();
  const metadata: CanonicalItem = {
    id: `${thread.id}-metadata`,
    type: "thread_metadata",
    threadId: thread.id,
    createdAt,
    cwd: thread.cwd,
    providerProfileId,
    modelId,
    reasoningEffort,
    sandbox,
    approvalPolicy,
  };
  const items: CanonicalItem[] = [metadata];
  const turns = thread.turns.map((turn, turnIndex) => {
    const turnId = turn.id;
    const started: CanonicalItem = {
      id: `${turnId}-started`,
      type: "turn_started",
      threadId: thread.id,
      turnId,
      createdAt: new Date(
        (turn.startedAt ?? turnIndex + 2) * 1_000,
      ).toISOString(),
      selection: { providerProfileId, modelId, reasoningEffort },
    };
    const canonical: CanonicalItem[] = [started];
    for (const item of turn.items)
      canonical.push(...canonicalItems(thread.id, turnId, item));
    if (turn.status === "interrupted") {
      canonical.push({
        id: `${turnId}-aborted`,
        type: "turn_aborted",
        threadId: thread.id,
        turnId,
        createdAt: new Date(
          (turn.completedAt ?? turnIndex + 3) * 1_000,
        ).toISOString(),
        reason: "Interrupted",
      });
    } else if (turn.status !== "inProgress") {
      canonical.push({
        id: `${turnId}-completed`,
        type: "turn_completed",
        threadId: thread.id,
        turnId,
        createdAt: new Date(
          (turn.completedAt ?? turnIndex + 3) * 1_000,
        ).toISOString(),
        status: turn.status,
      });
    }
    items.push(...canonical);
    return {
      id: turnId,
      items: canonical,
      status: turn.status,
      selection: { providerProfileId, modelId, reasoningEffort },
      model: modelId,
    };
  });
  return {
    processEpoch: options.processEpoch ?? "test-process-epoch",
    threadId: thread.id,
    watermark: options.watermark ?? 0,
    thread: {
      id: thread.id,
      items,
      turns,
      cwd: thread.cwd,
      providerProfileId,
      modelId,
      reasoningEffort,
      model: modelId,
      provider: providerProfileId,
      sandbox,
      approvalPolicy,
      ...(thread.name === null ? {} : { name: thread.name }),
      archived: false,
    },
    events: [],
  };
}

function canonicalItems(
  threadId: string,
  turnId: string,
  item: ThreadItem,
): CanonicalItem[] {
  const createdAt = new Date(10_000).toISOString();
  if (item.type === "userMessage") {
    return [
      {
        id: item.id,
        type: "user_message",
        threadId,
        turnId,
        createdAt,
        ...(item.clientId === null ? {} : { clientId: item.clientId }),
        text: item.content.map((part) => part.text).join("\n"),
        ...(item.deliveryAfter === undefined
          ? {}
          : { deliveryAfter: item.deliveryAfter }),
      },
    ];
  }
  if (item.type === "agentMessage") {
    return [
      {
        id: item.id,
        type: "agent_message",
        threadId,
        turnId,
        createdAt,
        text: item.text,
      },
    ];
  }
  if (item.type === "reasoning") {
    return [
      {
        id: item.id,
        type: "reasoning",
        threadId,
        turnId,
        createdAt,
        reasoningContent: item.content.join("\n"),
        contentVisibility: item.content.length > 0 ? "public" : "opaque",
        ...(item.summary.length === 0
          ? {}
          : { summary: item.summary.join("\n") }),
        ...(item.status === "interrupted" ? { incomplete: true as const } : {}),
      },
    ];
  }
  const callId = item.callId ?? `${item.id}-call`;
  const call: ToolCallItem = {
    id: item.id,
    type: "tool_call",
    threadId,
    turnId,
    createdAt,
    callId,
    name: item.toolName ?? "shell",
    arguments:
      item.toolArguments === undefined ? {} : { ...item.toolArguments },
    ...(item.modelResponseId === undefined
      ? {}
      : { modelResponseId: item.modelResponseId }),
    ...(item.parentCallId === undefined
      ? {}
      : { parentCallId: item.parentCallId }),
  };
  if (item.status === "inProgress") return [call];
  return [
    call,
    {
      id: `${item.id}-result`,
      type: "tool_result",
      threadId,
      turnId,
      createdAt,
      callId,
      output: item.aggregatedOutput ?? "",
      exitCode: item.exitCode ?? (item.status === "completed" ? 0 : 1),
      executionStatus: item.status,
      ...(item.contentType === undefined
        ? {}
        : { contentType: item.contentType }),
      ...(item.structuredContent === undefined
        ? {}
        : { structuredContent: item.structuredContent }),
    },
  ];
}

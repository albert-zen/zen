import { contextItemsFromLegacy, type ContextItem } from "./item-list.js";
import {
  compileWorkspaceInstructionMessages,
  filePermissionContext,
  type ModelTool,
} from "./model.js";
import type {
  CanonicalItem,
  SandboxMode,
  WorkspaceInstructionFile,
} from "./item.js";

/** Pure compiler admission. Caller commits each source/semantic Item before dispatch. */
export function prepareSampleContext(options: {
  threadId: string;
  turnId?: string;
  sampleId: string;
  items: readonly CanonicalItem[];
  itemList: readonly ContextItem[];
  sandbox: SandboxMode;
  instructions?: string;
  tools: readonly ModelTool[];
  workspaceInstructions?: readonly WorkspaceInstructionFile[];
  inputModalities: readonly string[] | null;
  notice?: string;
  id(): string;
  now(): string;
}): ContextItem[] {
  const result: ContextItem[] = [];
  const base = () => ({
    id: options.id(),
    threadId: options.threadId,
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    createdAt: options.now(),
  });
  // Supplemental context does not consume a legacy compatibility ordinal.
  const sequence = Math.max(
    0,
    options.items.length - 1,
    ...options.itemList.map((item) => item.source.sequence),
  );
  const addText = (
    kind:
      | "workspace_instructions"
      | "permission_instruction"
      | "model_instructions"
      | "context_notice"
      | "media_unavailable",
    role: "system" | "developer" | "user",
    text: string,
    sampleOnly = false,
  ) => {
    const content = { text, parts: [{ type: "text" as const, text }] };
    const previous = options.itemList.findLast(
      (item) => item.source.kind === kind,
    );
    if (
      !sampleOnly &&
      previous?.kind === "message" &&
      JSON.stringify(previous.content) === JSON.stringify(content)
    )
      return;
    if (!sampleOnly && text === "" && previous === undefined) return;
    result.push({
      ...base(),
      source: {
        kind,
        sequence,
        ...(sampleOnly ? { metadata: { onlySampleId: options.sampleId } } : {}),
      },
      kind: "message",
      role,
      content,
    });
  };
  addText("model_instructions", "system", options.instructions ?? "");
  const latestWorkspace = options.items.findLast(
    (item) =>
      (item.type === "turn_started" || item.type === "context_compaction") &&
      item.workspaceInstructions !== undefined,
  );
  const workspace =
    options.workspaceInstructions ??
    (latestWorkspace?.type === "turn_started" ||
    latestWorkspace?.type === "context_compaction"
      ? latestWorkspace.workspaceInstructions
      : undefined);
  if (workspace !== undefined)
    addText(
      "workspace_instructions",
      "developer",
      compileWorkspaceInstructionMessages(workspace)
        .map((message) => ("text" in message ? message.text : ""))
        .join("\n\n"),
    );
  if (
    options.sandbox !== "danger-full-access" ||
    options.itemList.some(
      (item) => item.source.kind === "permission_instruction",
    )
  )
    addText(
      "permission_instruction",
      "developer",
      filePermissionContext(options.sandbox),
    );
  const tools = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(tool.pluginId === undefined ? {} : { pluginId: tool.pluginId }),
    ...(tool.fullDescription === undefined
      ? {}
      : { fullDescription: tool.fullDescription }),
    inputSchema: structuredClone(tool.inputSchema),
    ...(tool.rawSource === undefined
      ? {}
      : { rawSource: structuredClone(tool.rawSource) }),
  }));
  const previousTools = options.itemList.findLast(
    (item) => item.kind === "tools",
  );
  if (
    previousTools?.kind !== "tools" ||
    JSON.stringify(previousTools.content.tools) !== JSON.stringify(tools)
  )
    result.push({
      ...base(),
      source: { kind: "tool_definitions", sequence },
      kind: "tools",
      role: "developer",
      content: { tools },
    });
  if (options.notice !== undefined)
    addText("context_notice", "user", options.notice, true);
  const ended = new Set(
    options.items.flatMap((item) =>
      item.type === "turn_completed" || item.type === "turn_aborted"
        ? [item.turnId]
        : [],
    ),
  );
  const omittedOccurrences = options.items.flatMap((item) =>
    item.type === "failure" &&
    item.recovery !== undefined &&
    (item.recovery.mediaScope === "exact" || !ended.has(item.turnId))
      ? item.recovery.withheldMedia
      : [],
  );
  if (omittedOccurrences.length) {
    const text =
      "Unavailable image/audio occurrences were withheld after a provider rejection. This diagnostic sample has not read its contents; original material and prior observations remain preserved. It is not proven damaged. Unattributed diagnostic withholding expires when that Turn ends. Do not guess the contents.";
    result.push({
      ...base(),
      source: {
        kind: "media_unavailable",
        sequence,
        metadata: {
          onlySampleId: options.sampleId,
          omittedMedia: omittedOccurrences.map((value) => ({ ...value })),
        },
      },
      kind: "message",
      role: "user",
      content: { text, parts: [{ type: "text", text }] },
    });
  }
  const supported = new Set(options.inputModalities ?? ["text"]);
  const omitted = new Set<string>();
  for (const item of options.itemList)
    if (item.kind === "message" || item.kind === "tool_result")
      for (const part of item.content.parts ?? [])
        if (part.type !== "text" && !supported.has(part.type))
          omitted.add(part.type);
  for (const kind of omitted)
    addText(
      "media_unavailable",
      "user",
      `[${kind} input is unavailable for this selected model. Stored ${kind} attachments were not sent or read in this sample.]`,
      true,
    );
  return result;
}

/** Existing committed semantics win; only prospective facts are materialized for estimates. */
export function contextForFacts(
  items: readonly CanonicalItem[],
  existing: readonly ContextItem[],
): ContextItem[] {
  const ids = new Set(items.map((item) => item.id));
  const boundary = Math.max(
    -1,
    ...existing
      .filter((item) => ids.has(item.id))
      .map((item) => item.source.sequence),
  );
  const contexts = existing.filter(
    (item) =>
      ids.has(item.id) ||
      (![
        "user_message",
        "host_message",
        "thread_message",
        "thread_instruction",
        "agent_message",
        "tool_call",
        "tool_result",
        "reasoning",
        "context_compaction",
        "failure",
      ].includes(item.source.kind) &&
        item.source.sequence <= boundary),
  );
  const present = new Set(contexts.map((item) => item.id));
  for (const [index, item] of items.entries())
    if (!present.has(item.id)) {
      const added = contextItemsFromLegacy(
        item,
        items.slice(0, index),
        Math.max(index, boundary + 1),
        contexts,
      );
      contexts.push(...added);
      for (const item of added) present.add(item.id);
    }
  return contexts;
}

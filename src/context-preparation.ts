import type { ContextItem } from "./item-list.js";
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
  const tools = structuredClone([...options.tools]);
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

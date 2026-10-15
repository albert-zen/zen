import { createHash } from "node:crypto";
import {
  IMPORTED_TOOL_RESULT_CONTENT_TYPE,
  MAX_THREAD_IMPORT_BYTES,
  MAX_THREAD_IMPORT_RECORDS,
  type ImportedHistoryItem,
  type ThreadImportHistory,
} from "../../thread-import.js";

export const CODEX_ROLLOUT_FORMAT = "codex-rollout-0.146.0";
const MAX_LINE_BYTES = 2 * 1024 * 1024;

/** Pure selected-file parser. Never follows paths, restores authority, or runs calls. */
export function parseCodexRollout(contents: string): ThreadImportHistory {
  if (Buffer.byteLength(contents, "utf8") > MAX_THREAD_IMPORT_BYTES)
    throw new Error("Import exceeds the 16 MiB limit.");
  const rawLines = contents.split("\n");
  if (rawLines.length > MAX_THREAD_IMPORT_RECORDS + 1)
    throw new Error("Import exceeds the 20,000 record limit.");
  const records: { line: number; value: Record<string, unknown> }[] = [];
  for (const [index, line] of rawLines.entries()) {
    if (!line.trim()) continue;
    try {
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
        throw new Error("Record exceeds the 2 MiB limit.");
      const value = object(
        JSON.parse(index === 0 ? line.replace(/^\uFEFF/u, "") : line),
      );
      object(value.payload);
      if (!Number.isFinite(Date.parse(text(value.timestamp, "timestamp"))))
        throw new Error("Invalid timestamp.");
      records.push({ line: index + 1, value });
    } catch (error) {
      throw new Error(
        `Codex import line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (
    records[0]?.value.type !== "session_meta" ||
    records.filter((entry) => entry.value.type === "session_meta").length !== 1
  )
    throw new Error("Expected exactly one initial session_meta record.");
  const checkpointIndex = records.findLastIndex(
    (entry) => entry.value.type === "compacted",
  );
  if (checkpointIndex < 0) return parseFlatRollout(contents);
  const checkpoint = records[checkpointIndex]!;
  const payload = object(checkpoint.value.payload);
  let replacement: unknown[];
  let kind: "replacement-history" | "summary-checkpoint";
  if (
    Array.isArray(payload.replacement_history) &&
    payload.replacement_history.length
  ) {
    replacement = payload.replacement_history;
    kind = "replacement-history";
  } else if (
    payload.replacement_history == null &&
    typeof payload.message === "string" &&
    payload.message.trim()
  ) {
    replacement = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: payload.message }],
      },
    ];
    kind = "summary-checkpoint";
  } else
    throw new Error(
      `Codex import line ${checkpoint.line}: checkpoint has no usable explicit replacement history or summary.`,
    );
  const flattened = [
    records[0]!.value,
    ...replacement.map((item) => ({
      type: "response_item",
      timestamp: checkpoint.value.timestamp,
      payload: item,
    })),
    ...records.slice(checkpointIndex + 1).map((entry) => entry.value),
  ];
  const history = parseFlatRollout(
    flattened.map((entry) => JSON.stringify(entry)).join("\n"),
    true,
    [
      records[0]!.line,
      ...replacement.map(() => checkpoint.line),
      ...records.slice(checkpointIndex + 1).map((entry) => entry.line),
    ],
  );
  history.source.sha256 = createHash("sha256").update(contents).digest("hex");
  history.source.contextBasis = {
    kind,
    sourceLine: checkpoint.line,
    earlierRecords: checkpointIndex - 1,
  };
  history.source.exclusions.unshift(
    `Continuing from the latest explicit ${kind} at source line ${checkpoint.line}; ${checkpointIndex - 1} earlier records remain only in the original export (not a full transcript archive)`,
  );
  return history;
}

function parseFlatRollout(
  contents: string,
  checkpoint = false,
  sourceLines?: readonly number[],
): ThreadImportHistory {
  if (Buffer.byteLength(contents, "utf8") > MAX_THREAD_IMPORT_BYTES)
    throw new Error("Import exceeds the 16 MiB limit.");
  const lines = contents.split("\n");
  if (lines.length > MAX_THREAD_IMPORT_RECORDS + 1)
    throw new Error("Import exceeds the 20,000 record limit.");
  const turns: ThreadImportHistory["turns"] = [];
  const omitted = new Map<string, number>();
  const omit = (reason: string) =>
    omitted.set(reason, (omitted.get(reason) ?? 0) + 1);
  let source: ThreadImportHistory["source"] | undefined;
  let current: ThreadImportHistory["turns"][number] | undefined;
  let pending = new Map<
    string,
    "function_call_output" | "custom_tool_call_output"
  >();
  const seenCalls = new Set<string>();
  let resultsStarted = false;
  let lastStamp = "";
  const close = (status: "completed" | "interrupted", at: string) => {
    if (pending.size)
      throw new Error(
        "Unpaired tool calls cannot be imported; select a complete export.",
      );
    if (current) {
      current.status = status;
      current.endedAt = at;
      current = undefined;
    }
  };
  const append = (item: ImportedHistoryItem) => {
    if (!current) {
      if (!checkpoint || turns.length || item.type !== "agent_message")
        throw new Error("History must begin with a user message.");
      current = {
        createdAt: item.createdAt,
        endedAt: item.createdAt,
        status: "interrupted",
        items: [],
      };
      turns.push(current);
    }
    current.items.push(item);
    current.endedAt = item.createdAt;
  };
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    try {
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
        throw new Error("Record exceeds the 2 MiB limit.");
      const record = object(
        JSON.parse(index === 0 ? line.replace(/^\uFEFF/u, "") : line),
      );
      const stamp = text(record.timestamp, "timestamp");
      if (!Number.isFinite(Date.parse(stamp)))
        throw new Error("Invalid timestamp.");
      lastStamp = stamp;
      const payload = object(record.payload);
      if (record.type === "session_meta") {
        if (source || turns.length)
          throw new Error("Expected exactly one initial session_meta record.");
        const version = text(payload.cli_version, "cli_version");
        if (version !== "0.146.0")
          throw new Error(
            `Unsupported Codex version ${version}; expected 0.146.0.`,
          );
        if (
          payload.history_base != null ||
          payload.subagent_history_start_ordinal != null
        )
          throw new Error(
            "Paginated or inherited subagent histories require a standalone export.",
          );
        source = {
          format: CODEX_ROLLOUT_FORMAT,
          sourceId: text(payload.id, "session id"),
          sourceVersion: version,
          sourceCwd: text(payload.cwd, "cwd"),
          sha256: createHash("sha256").update(contents).digest("hex"),
          exclusions: [],
          ...(typeof payload.model_provider === "string" &&
          payload.model_provider
            ? { sourceProvider: payload.model_provider }
            : {}),
        };
        if (payload.base_instructions != null)
          omit("Source base instructions (not restored)");
        if (payload.dynamic_tools != null)
          omit("Source tool definitions (not restored)");
        continue;
      }
      if (!source) throw new Error("The first record must be session_meta.");
      if (record.type === "compacted")
        throw new Error(
          "Compacted history is not yet supported; no partial import was written.",
        );
      if (record.type === "world_state") {
        if (typeof payload.full !== "boolean" || !("state" in payload))
          throw new Error("Invalid source world_state snapshot.");
        omit("Source world-state configuration (not restored)");
        continue;
      }
      if (record.type === "turn_context") {
        if (typeof payload.model === "string" && payload.model)
          source.sourceModel = payload.model;
        omit("Source execution/instruction configuration (not restored)");
        continue;
      }
      if (record.type === "event_msg") {
        if (payload.type === "task_complete") close("completed", stamp);
        else if (payload.type === "turn_aborted") close("interrupted", stamp);
        else if (payload.type === "thread_rolled_back")
          throw new Error("Rolled-back histories are not yet supported.");
        else
          omit("Noncanonical event records (response_item is authoritative)");
        continue;
      }
      if (record.type !== "response_item")
        throw new Error(`Unsupported rollout record ${String(record.type)}.`);
      switch (payload.type) {
        case "message": {
          const role = text(payload.role, "message role");
          if (role === "system" || role === "developer") {
            omit(`Source ${role} instructions (not restored)`);
            break;
          }
          if (role !== "user" && role !== "assistant")
            throw new Error(`Unsupported message role ${role}.`);
          const content = textParts(payload.content);
          if (pending.size)
            throw new Error(
              "A message interrupts an incomplete tool-call batch.",
            );
          if (role === "user") {
            close("interrupted", stamp);
            current = {
              createdAt: stamp,
              endedAt: stamp,
              status: "interrupted",
              items: [],
            };
            turns.push(current);
          }
          append({
            type: role === "user" ? "user_message" : "agent_message",
            text: content,
            createdAt: stamp,
          });
          break;
        }
        case "reasoning": {
          if (pending.size)
            throw new Error(
              "Reasoning interrupts an incomplete tool-call batch.",
            );
          if (payload.encrypted_content != null || payload.content != null)
            omit("Private/opaque reasoning (not restored)");
          const summary = textParts(payload.summary, "summary_text", true);
          if (summary) append({ type: "reasoning", summary, createdAt: stamp });
          break;
        }
        case "function_call":
        case "custom_tool_call": {
          if (pending.size && resultsStarted)
            throw new Error(
              "A new call interrupts an incomplete tool-result batch.",
            );
          if (!pending.size) resultsStarted = false;
          const id = text(payload.call_id, "call_id");
          if (seenCalls.has(id)) throw new Error("Duplicate tool call id.");
          const name = text(payload.name, "tool name");
          if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(name))
            throw new Error("Unsupported tool name.");
          const namespace =
            payload.namespace == null
              ? undefined
              : text(payload.namespace, "tool namespace");
          if (
            namespace !== undefined &&
            !/^[A-Za-z0-9_.-]{1,128}$/u.test(namespace)
          )
            throw new Error("Unsupported tool namespace.");
          const args =
            payload.type === "function_call"
              ? object(JSON.parse(text(payload.arguments, "tool arguments")))
              : { input: text(payload.input, "custom tool input", true) };
          append({
            type: "tool_call",
            callId: id,
            name,
            arguments: args,
            imported: {
              inputFormat: payload.type === "function_call" ? "json" : "text",
              ...(namespace === undefined ? {} : { namespace }),
            },
            createdAt: stamp,
          });
          seenCalls.add(id);
          pending.set(
            id,
            payload.type === "function_call"
              ? "function_call_output"
              : "custom_tool_call_output",
          );
          break;
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          const id = text(payload.call_id, "call_id");
          if (pending.get(id) !== payload.type)
            throw new Error("Orphaned, repeated, or mismatched tool result.");
          // String outputs have no trustworthy process exit status. Preserve bytes as observation.
          const output =
            typeof payload.output === "string"
              ? payload.output
              : textParts(payload.output);
          append({
            type: "tool_result",
            callId: id,
            output,
            exitCode: null,
            createdAt: stamp,
            contentType: IMPORTED_TOOL_RESULT_CONTENT_TYPE,
            structuredContent: { outcome: "unknown", source: "historical" },
          });
          pending.delete(id);
          resultsStarted = true;
          break;
        }
        default:
          throw new Error(
            `Unsupported response item ${String(payload.type)}; no partial import was written.`,
          );
      }
    } catch (error) {
      throw new Error(
        `Codex import line ${sourceLines?.[index] ?? index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  close("interrupted", lastStamp);
  if (!source || !turns.length)
    throw new Error("No importable user conversation found.");
  source.exclusions = [...omitted].map(
    ([reason, count]) => `${reason}: ${count}`,
  );
  return { source, turns };
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.length))
    throw new Error(`Invalid ${field}.`);
  return value;
}
function textParts(
  value: unknown,
  requiredType?: string,
  allowEmpty = false,
): string {
  if (!Array.isArray(value) || (!allowEmpty && !value.length))
    throw new Error("Expected nonempty text content.");
  return value
    .map((part) => {
      const entry = object(part);
      if (
        requiredType
          ? entry.type !== requiredType
          : entry.type !== "input_text" && entry.type !== "output_text"
      )
        throw new Error(
          "Media or unsupported content is not imported; text-only exports are currently supported.",
        );
      return text(entry.text, "content text", true);
    })
    .join("\n");
}

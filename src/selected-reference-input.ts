import {
  contentFromUserMessage,
  type ContextCompactionItem,
  type JsonValue,
  type UserInput,
  type UserInputPart,
  type UserMessageItem,
} from "./item.js";
import type { ContextItem } from "./item-list.js";
import {
  validateModelReferenceBindings,
  type ModelReferenceBinding,
} from "./model-references.js";
import {
  parseSentReferenceV3,
  type Reference,
} from "./selected-reference-protocol.js";

export interface SelectedReferenceInput {
  parts: UserInput;
  referenceBindings: ModelReferenceBinding[];
}

/** Allocate only from existing provenance; this disposable map is not another store. */
function selectedSources(
  ownerThreadId: string,
  previous: readonly ContextItem[],
) {
  const history = previous.flatMap((item) =>
    item.source.metadata?.referenceBindings === undefined
      ? []
      : validateModelReferenceBindings(item.source.metadata.referenceBindings),
  );
  let next = 1;
  const owned = new Map<string, ModelReferenceBinding>();
  const used = new Map<string, ModelReferenceBinding>();
  for (const binding of history) {
    if (binding.ref.startsWith("s"))
      next = Math.max(next, Number(binding.ref.slice(1)) + 1);
    if (binding.ownerThreadId !== ownerThreadId) continue;
    const old = owned.get(binding.ref);
    if (old && JSON.stringify(old) !== JSON.stringify(binding))
      throw new Error("Conflicting selected source provenance");
    owned.set(binding.ref, binding);
  }
  return {
    bind(kind: string, value: JsonValue): string {
      let binding = [...owned.values()].find(
        (entry) =>
          entry.ref.startsWith("s") &&
          entry.namespace === "selected-reference" &&
          entry.kind === kind &&
          entry.epoch === undefined &&
          JSON.stringify(entry.value) === JSON.stringify(value),
      );
      if (!binding) {
        if (!Number.isSafeInteger(next))
          throw new Error("Selected source reference scope exhausted");
        binding = {
          ref: `s${next++}`,
          ownerThreadId,
          namespace: "selected-reference",
          kind,
          value,
        };
        validateModelReferenceBindings([binding]);
        owned.set(binding.ref, binding);
      }
      used.set(binding.ref, binding);
      return binding.ref;
    },
    get bindings(): ModelReferenceBinding[] {
      return structuredClone([...used.values()]);
    },
  };
}

function sourceTime(
  reference: Reference,
  previous: readonly ContextItem[],
): string {
  if (reference.kind !== "message") return "source time unavailable";
  const source = previous.find(
    (item) => item.threadId === reference.threadId && item.id === reference.id,
  );
  // Only reuse the encoder's already-persisted receipt fact. In particular,
  // createdAt may be an import/checkpoint time and is never a fallback here.
  const first =
    source?.kind === "message" ? source.content.parts[0] : undefined;
  if (
    source?.source.kind === "user_message" &&
    source.source.metadata?.bodyStart === 1 &&
    first?.type === "text" &&
    first.text.startsWith("[Message received at ") &&
    first.text.endsWith("]")
  )
    return `source received at ${first.text.slice(21, -1)}`;
  return "source time unavailable";
}

/**
 * Prepare semantic parts before persistence/dispatch. Recognition is not
 * authentication: excerpts retain user role and refs never grant permission.
 * The durable input fact must retain item unchanged; this is not its inverse.
 */
export function compileSelectedReferenceInput(
  item: UserMessageItem,
  previous: readonly ContextItem[],
): SelectedReferenceInput | undefined {
  if (item.type !== "user_message" || !item.clientId) return undefined;
  const original = contentFromUserMessage(item);
  const textParts = original.filter((part) => part.type === "text");
  // The real Composer emits one text envelope, optionally alongside media.
  // Never concatenate independent user parts to manufacture a recognized one.
  if (textParts.length !== 1) return undefined;
  const parsed = parseSentReferenceV3(textParts[0]!.text, item.clientId);
  if (!parsed) return undefined;
  const sources = selectedSources(item.threadId, previous);
  let text = "";
  let cursor = 0;
  for (const reference of parsed.references) {
    const position = reference.position!;
    text += parsed.text.slice(cursor, position);
    const label = JSON.stringify(reference.name);
    if (reference.kind === "file") {
      // There is no native selected-file reader. Keep exact source coordinates
      // rather than minting an unusable s ref or guessing the current workspace.
      text += `[Selected file ${label}; workspace ${JSON.stringify(reference.cwd)}; relative path ${JSON.stringify(reference.path)}]`;
    } else {
      const value: JsonValue =
        reference.kind === "message"
          ? {
              threadId: reference.threadId,
              id: reference.id,
              cwd: reference.cwd,
            }
          : { id: reference.id, cwd: reference.cwd };
      const ref = sources.bind(reference.kind, value);
      if (reference.kind === "message")
        text += `[Selected message ${label}; ${ref}; ${sourceTime(reference, previous)}; read-only]\n${reference.excerpt}\n[End selected excerpt]`;
      else
        text += `[Selected thread ${label}; ${ref}; source time unavailable; read-only]`;
    }
    cursor = position + 1;
  }
  text += parsed.text.slice(cursor);
  const parts: UserInputPart[] = original.map((part) =>
    part.type === "text" ? { type: "text", text } : structuredClone(part),
  );
  return { parts, referenceBindings: sources.bindings };
}

/** The encoder persists this footer with its summary, never the old UUID URI. */
export function compileOriginalHistoryReference(
  item: ContextCompactionItem,
  previous: readonly ContextItem[],
): { text: string; referenceBindings: ModelReferenceBinding[] } | undefined {
  if (item.includeOriginalReference === false) return undefined;
  const sources = selectedSources(item.threadId, previous);
  const ref = sources.bind("history", {
    threadId: item.threadId,
    throughItemId: item.coveredThroughItemId,
  });
  return {
    text: `[Original conversation history; ${ref}; exact read-only prefix, subject to current permissions. Omitted content and source times are unavailable until read.]`,
    referenceBindings: sources.bindings,
  };
}

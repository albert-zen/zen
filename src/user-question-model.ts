import type { ContextItem } from "./item-list.js";
import { textFromUserInput, type UserInput } from "./item.js";
import {
  ASK_USER_QUESTION_NAME,
  USER_QUESTION_PUBLICATION_KIND,
  parseUserQuestionSpecification,
  validateUserQuestionPublication,
  parseUserQuestionReply,
  normalizeUserQuestionReply,
  matchesUserQuestionReplyBody,
  renderUserQuestionAnswer,
  type QuestionIdentity,
  type UserQuestionSpecification,
} from "./user-question.js";

type Call = Extract<ContextItem, { kind: "tool_call" }>;
type Receipt = Extract<ContextItem, { kind: "tool_result" }>;
interface Publication {
  call: Call;
  specification: UserQuestionSpecification;
  identity: QuestionIdentity;
  receipts: { item: Receipt; position: number; requestRef?: string }[];
  completeAt: number;
  numbers: string[];
}

function identityKey(identity: QuestionIdentity): string {
  return JSON.stringify([identity.threadId, identity.callItemId]);
}

/** Display provenance only. Native admission never consults inherited origins. */
function origin(call: Call): QuestionIdentity | undefined {
  const value = call.source.metadata?.questionOrigin;
  if (value === undefined)
    return { threadId: call.threadId, callItemId: call.id };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  )
    return;
  const identity = value as { threadId?: unknown; callItemId?: unknown };
  if (
    typeof identity.threadId !== "string" ||
    typeof identity.callItemId !== "string"
  )
    return;
  return { threadId: identity.threadId, callItemId: identity.callItemId };
}

/** A recognized native machine fact must never fall back to private-ID text. */
class UserQuestionDisplayError extends Error {
  constructor(itemId: string, reason: string) {
    super(
      `Cannot safely display user question publication ${itemId}: ${reason}`,
    );
    this.name = "UserQuestionDisplayError";
  }
}

/** Read the complete native result frame, never search arbitrary user prose. */
function publicationBody(
  item: Receipt,
): { marker: unknown; offset: number } | undefined {
  const prefixes = [
    "Exit code: 0\n",
    item.content.exitCode === null
      ? "Outcome: unknown\n"
      : `Exit code: ${item.content.exitCode}\n`,
  ];
  const prefix =
    prefixes.find((value) => item.content.text.startsWith(value)) ?? "";
  const body = item.content.text.slice(prefix.length);
  let marker: unknown;
  try {
    marker = JSON.parse(body);
  } catch {
    return;
  }
  if (
    marker !== null &&
    typeof marker === "object" &&
    !Array.isArray(marker) &&
    "kind" in marker &&
    marker.kind === USER_QUESTION_PUBLICATION_KIND
  )
    return { marker, offset: prefix.length };
  return;
}

function receiptPrefix(part: UserInput[number] | undefined): boolean {
  return (
    part?.type === "text" &&
    part.skillSource === undefined &&
    (part.text === "[Message receipt time unavailable]" ||
      (part.text.startsWith("[Message received at ") &&
        part.text.endsWith("]")))
  );
}

/**
 * Deterministic display of complete committed question facts, before selection.
 * No registry, mutation, native address resolution or free-text replacement.
 */
export function userQuestionModelProjection(
  items: readonly ContextItem[],
): ReadonlyMap<string, ContextItem> {
  const calls = new Map<string, { call: Call; position: number }[]>();
  const key = (item: Call | Receipt) =>
    JSON.stringify([item.turnId, item.content.callId]);
  items.forEach((item, position) => {
    if (item.kind === "tool_call") {
      const values = calls.get(key(item)) ?? [];
      values.push({ call: item, position });
      calls.set(key(item), values);
    }
  });
  const publications = new Map<string, Publication>();
  items.forEach((item, position) => {
    if (item.kind !== "tool_result") return;
    const candidates = calls.get(key(item));
    // A known non-Ask tool can quote the very same JSON as ordinary content.
    // Neither its text nor user/third-party messages become native publications.
    if (
      candidates?.length &&
      candidates.every(
        ({ call }) => call.content.name !== ASK_USER_QUESTION_NAME,
      )
    )
      return;
    if (
      item.source.kind !== "tool_result" &&
      !candidates?.some(
        ({ call }) => call.content.name === ASK_USER_QUESTION_NAME,
      )
    )
      return;
    const observed = publicationBody(item);
    if (observed === undefined) return;
    const fail: (reason: string) => never = (reason) => {
      throw new UserQuestionDisplayError(item.id, reason);
    };
    if (candidates?.length !== 1)
      fail("original source call is unavailable or ambiguous");
    const { call, position: callPosition } = candidates[0]!;
    if (
      call.content.name !== ASK_USER_QUESTION_NAME ||
      call.source.kind !== "tool_call" ||
      item.source.kind !== "tool_result"
    )
      fail("original source call provenance is inconsistent");
    if (
      item.content.exitCode !== 0 ||
      item.source.metadata?.executionStatus !== "completed"
    )
      fail("publication is not a successful completed result");
    const identity = origin(call);
    const offset = item.source.metadata?.bodyStart;
    if (!identity || offset !== observed.offset)
      fail(
        "original request provenance or body offset is unavailable or inconsistent",
      );
    if (item.content.parts?.length)
      fail("publication has unsupported additional model content");
    const publication = validateUserQuestionPublication(
      observed.marker,
      identity,
      call.source.sequence,
    );
    if (publication === undefined)
      fail("original request provenance is unavailable or inconsistent");
    try {
      const specification = parseUserQuestionSpecification(
        call.content.arguments,
      );
      let entry = publications.get(call.id);
      if (entry === undefined) {
        entry = {
          call,
          specification,
          identity,
          receipts: [],
          completeAt: Math.max(callPosition, position),
          numbers: [],
        };
        publications.set(call.id, entry);
      }
      entry.receipts.push({ item, position, ...publication });
    } catch {
      // A successful machine publication with an invalid specification is
      // corrupt history, not a plain-text fallback carrying private IDs.
      throw new UserQuestionDisplayError(
        item.id,
        "original question specification is invalid",
      );
    }
  });
  const ordered = [...publications.values()].sort(
    (a, b) => a.completeAt - b.completeAt,
  );
  const projected = new Map<string, ContextItem>();
  const byIdentity = new Map<string, Publication[]>();
  let next = 1;
  for (const entry of ordered) {
    entry.numbers = entry.specification.questions.map(() => `Q${next++}`);
    const identities = byIdentity.get(identityKey(entry.identity)) ?? [];
    if (identities.length !== 0)
      throw new UserQuestionDisplayError(
        entry.call.id,
        "original request identity is ambiguous",
      );
    identities.push(entry);
    byIdentity.set(identityKey(entry.identity), identities);
    for (const { item } of entry.receipts) {
      const offset = Number(item.source.metadata!.bodyStart);
      const authored = entry.call.content.arguments.questions as Record<
        string,
        unknown
      >[];
      const text =
        item.content.text.slice(0, offset) +
        JSON.stringify({
          questions: entry.numbers.map((id, index) => ({
            id,
            ...(authored[index]?.id === undefined
              ? {}
              : { key: entry.specification.questions[index]!.id }),
          })),
        });
      projected.set(item.id, { ...item, content: { ...item.content, text } });
    }
  }
  for (const item of items) {
    if (
      item.kind !== "message" ||
      item.role !== "user" ||
      item.source.kind !== "user_message" ||
      item.source.metadata?.questionReply === undefined
    )
      continue;
    try {
      const reply = parseUserQuestionReply(item.source.metadata.questionReply);
      const candidates = byIdentity.get(identityKey(reply.request));
      if (candidates?.length !== 1) continue;
      const entry = candidates[0]!;
      const normalized = normalizeUserQuestionReply(entry.specification, reply);
      const offset = item.source.metadata.bodyStart;
      const matchesAt = (position: number) =>
        matchesUserQuestionReplyBody(
          entry.specification,
          normalized,
          textFromUserInput(item.content.parts.slice(position)),
          entry.receipts[0]!.requestRef,
        );
      const validOffset =
        typeof offset === "number" &&
        Number.isSafeInteger(offset) &&
        offset >= 0 &&
        offset <= item.content.parts.length;
      const machineOffset =
        receiptPrefix(item.content.parts[0]) && matchesAt(1)
          ? 1
          : matchesAt(0)
            ? 0
            : validOffset && matchesAt(offset)
              ? offset
              : undefined;
      if (machineOffset === undefined) continue; // Literal or forged body stays literal.
      if (
        !validOffset ||
        offset !== machineOffset ||
        (machineOffset !== 0 &&
          (machineOffset !== 1 || !receiptPrefix(item.content.parts[0])))
      )
        throw new UserQuestionDisplayError(
          item.id,
          "generated reply body offset is unavailable or inconsistent",
        );
      const bodyParts = item.content.parts.slice(machineOffset);
      if (
        bodyParts.length !== 1 ||
        bodyParts[0]?.type !== "text" ||
        bodyParts[0].skillSource !== undefined
      )
        throw new UserQuestionDisplayError(
          item.id,
          "generated reply has unsupported body parts or annotations",
        );
      let text: string;
      if (normalized.outcome === "cancel")
        text = `I chose not to answer ${entry.numbers.join(", ")}.`;
      else if (entry.call.content.arguments.answerTemplate !== undefined) {
        text = `Reply to ${entry.numbers.join(", ")}:\n${renderUserQuestionAnswer(entry.specification, normalized.answers)}`;
      } else {
        const answers = entry.specification.questions.map((question, index) => {
          const answer = normalized.answers[index]!;
          const values = (question.options ?? [])
            .filter((option) => answer.optionIds.includes(option.id))
            .map((option) => option.label);
          if (answer.text !== undefined) values.push(answer.text);
          return values.join("\n");
        });
        text =
          entry.numbers.length === 1
            ? `Reply to ${entry.numbers[0]}:\n${answers[0]}`
            : entry.numbers
                .map(
                  (number, index) => `Reply to ${number}:\n${answers[index]}`,
                )
                .join("\n\n");
      }
      const parts: UserInput = [
        ...item.content.parts.slice(0, offset),
        { type: "text", text },
      ];
      projected.set(item.id, {
        ...item,
        content: { text: textFromUserInput(parts), parts },
      });
    } catch (error) {
      if (error instanceof UserQuestionDisplayError) throw error;
      /* Invalid provenance/body remains original untrusted content. */
    }
  }
  return projected;
}

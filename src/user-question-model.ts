import type { ContextItem } from "./item-list.js";
import { textFromUserInput, type UserInput } from "./item.js";
import {
  ASK_USER_QUESTION_NAME,
  USER_QUESTION_PUBLICATION_KIND,
  parseUserQuestionSpecification,
  parseUserQuestionPublication,
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
    if (
      item.kind === "tool_call" &&
      item.content.name === ASK_USER_QUESTION_NAME
    ) {
      const values = calls.get(key(item)) ?? [];
      values.push({ call: item, position });
      calls.set(key(item), values);
    }
  });
  if (calls.size === 0) return new Map();
  const publications = new Map<string, Publication>();
  items.forEach((item, position) => {
    if (
      item.kind !== "tool_result" ||
      item.content.exitCode !== 0 ||
      item.source.metadata?.executionStatus !== "completed"
    )
      return;
    const candidates = calls.get(key(item));
    if (candidates?.length !== 1) return;
    const { call, position: callPosition } = candidates[0]!;
    const identity = origin(call);
    const offset = item.source.metadata?.bodyStart;
    if (
      !identity ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      return;
    const publication = parseUserQuestionPublication(
      item.content.text.slice(offset),
      identity,
      call.source.sequence,
    );
    if (publication === undefined) {
      // Old forks discarded their origin Item-ID mapping. A recognizable
      // machine receipt must never fall back to exposing its private IDs to
      // the model when provenance cannot be verified. Do not guess an origin
      // from the receipt itself or rewrite ordinary user/Tool text.
      let marker: unknown;
      try {
        marker = JSON.parse(item.content.text.slice(offset));
      } catch {
        return;
      }
      if (
        marker !== null &&
        typeof marker === "object" &&
        "kind" in marker &&
        marker.kind === USER_QUESTION_PUBLICATION_KIND
      )
        throw new Error(
          `Cannot safely display user question publication ${item.id}: original request provenance is unavailable or inconsistent`,
        );
      return;
    }
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
      throw new Error(
        `Cannot safely display user question publication ${item.id}: original question specification is invalid`,
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
      if (
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        continue;
      const body = textFromUserInput(item.content.parts.slice(offset));
      if (
        !matchesUserQuestionReplyBody(
          entry.specification,
          normalized,
          body,
          entry.receipts[0]!.requestRef,
        )
      )
        continue;
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
    } catch {
      /* Invalid provenance/body remains original untrusted content. */
    }
  }
  return projected;
}

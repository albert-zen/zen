import type { ContextItem } from "./item-list.js";
import { textFromUserInput, type CanonicalItem } from "./item.js";
import { pendingQueuedMessages } from "./input-queue.js";
import { recordedTimestamp } from "./model.js";
import {
  ASK_USER_QUESTION_NAME,
  USER_QUESTION_PUBLICATION_KIND,
  parseUserQuestionSpecification,
  parseUserQuestionReply,
  normalizeUserQuestionReply,
  matchesUserQuestionReplyBody,
  userQuestionRequestRef,
  type QuestionIdentity,
  type UserQuestionReply,
  type UserQuestionSpecification,
} from "./user-question.js";

export interface UserQuestionState {
  request: QuestionIdentity;
  resultItemId: string;
  /** Display-only ref issued by a v2 publication; native authority stays request. */
  requestRef?: string;
  createdAt: string;
  specification: UserQuestionSpecification;
  state:
    | "open"
    | "answer-pending"
    | "cancel-pending"
    | "answered"
    | "cancelled"
    | "unavailable";
  response?: { clientId: string; itemId: string; reply: UserQuestionReply };
}

export const USER_QUESTION_PAGE_SIZE = 32;
export interface UserQuestionSummary {
  /** Answerable request groups, excluding pending/claimed/unavailable replies. */
  openCount: number;
  /** Original local publication time, retained after response or recall. */
  latestPublishedAt?: string;
}
export interface UserQuestionPage {
  questions: readonly UserQuestionState[];
  totalPending: number;
  /** A local request identity, not a persistent cursor or permission token. */
  nextAfter?: string;
}
export interface UserQuestionReadback {
  question?: UserQuestionState;
  response: {
    clientId: string;
    status:
      | "not-found"
      | "unknown"
      | "pending"
      | "claimed"
      | "withdrawn"
      | "conflict";
    itemId?: string;
    queuedItemId?: string;
    turnId?: string;
    reply?: UserQuestionReply;
  };
}

const emptyQuestions: readonly UserQuestionState[] = Object.freeze([]);

/** Thread-owned disposable index, folded with existing decode/append work. */
export class ThreadUserQuestionProjection {
  #importedThrough = -1;
  #dirty = false;
  readonly #localCalls = new Set<string>();
  readonly #callKeys = new Map<
    string,
    { callItemId: string; resultSeen: boolean }
  >();
  readonly #replyClients = new Map<string, string>();
  readonly #queuedIds = new Map<string, string>();
  readonly #attentionCandidates = new Set<string>();
  #value: readonly UserQuestionState[] = emptyQuestions;
  #summary: UserQuestionSummary = { openCount: 0 };
  readonly #byRequest = new Map<
    string,
    { question: UserQuestionState; position: number }
  >();
  #pending: { question: UserQuestionState; position: number }[] = [];

  observeFact(threadId: string, item: CanonicalItem, position: number): void {
    if (item.threadId !== threadId) return;
    if (item.type === "thread_metadata")
      this.#importedThrough = item.importedFrom?.historyItemCount ?? -1;
    if (item.type === "thread_forked") {
      this.#importedThrough = position;
      this.#attentionCandidates.clear();
      this.#localCalls.clear();
      this.#callKeys.clear();
      this.#replyClients.clear();
      this.#queuedIds.clear();
      this.#value = emptyQuestions;
      this.#summary = { openCount: 0 };
      this.#byRequest.clear();
      this.#pending = [];
      this.#dirty = false;
    }
    if (position <= this.#importedThrough) return;
    if (
      item.type === "tool_call" &&
      item.name === ASK_USER_QUESTION_NAME &&
      item.parentCallId === undefined &&
      item.imported === undefined
    ) {
      this.#localCalls.add(item.id);
      // Compilation repair can append a missing semantic call after its result.
      // Index only known local Ask candidates; ordinary tool results need no map.
      this.#callKeys.set(JSON.stringify([item.turnId, item.callId]), {
        callItemId: item.id,
        resultSeen: false,
      });
    }
    if (
      item.type === "user_message_queued" &&
      item.questionReply !== undefined
    ) {
      this.#queuedIds.set(item.id, item.questionReply.request.callItemId);
      this.#replyClients.set(
        item.clientId,
        item.questionReply.request.callItemId,
      );
      this.#attentionCandidates.add(item.questionReply.request.callItemId);
      this.#dirty = true;
    } else if (
      item.type === "user_message" &&
      (item.questionReply !== undefined ||
        (item.clientId !== undefined && this.#replyClients.has(item.clientId)))
    ) {
      this.#dirty = true;
      const request =
        item.questionReply?.request.callItemId ??
        this.#replyClients.get(item.clientId!);
      if (request !== undefined) this.#attentionCandidates.add(request);
    } else if (item.type === "user_message_steer_recalled") {
      for (const target of item.targets) {
        const request = this.#queuedIds.get(target.queuedItemId);
        if (request !== undefined) {
          this.#attentionCandidates.add(request);
          this.#dirty = true;
        }
      }
    } else if (
      (item.type === "user_message_queue_cancelled" ||
        item.type === "user_message_queue_edited") &&
      this.#queuedIds.has(item.queuedItemId)
    ) {
      this.#dirty = true;
      this.#attentionCandidates.add(this.#queuedIds.get(item.queuedItemId)!);
    }
  }

  observeContext(threadId: string, item: ContextItem): void {
    if (item.threadId !== threadId) return;
    if (
      item.kind === "tool_call" &&
      item.content.name === ASK_USER_QUESTION_NAME &&
      this.#localCalls.has(item.id)
    ) {
      const key = JSON.stringify([item.turnId, item.content.callId]);
      const resultSeen = this.#callKeys.get(key)?.resultSeen ?? false;
      this.#callKeys.set(key, { callItemId: item.id, resultSeen });
      // Skip bare call work only when this candidate has no earlier result.
      if (resultSeen) {
        this.#dirty = true;
        this.#attentionCandidates.add(item.id);
      }
    } else if (
      item.kind === "tool_result" &&
      this.#callKeys.size !== 0 &&
      this.#callKeys.has(JSON.stringify([item.turnId, item.content.callId]))
    ) {
      this.#dirty = true;
      const candidate = this.#callKeys.get(
        JSON.stringify([item.turnId, item.content.callId]),
      )!;
      candidate.resultSeen = true;
      this.#attentionCandidates.add(candidate.callItemId);
    } else if (
      item.kind === "message" &&
      item.source.metadata?.questionReply !== undefined
    ) {
      this.#dirty = true;
      const reply = item.source.metadata
        .questionReply as unknown as UserQuestionReply;
      this.#attentionCandidates.add(reply.request.callItemId);
    }
  }

  discardAttentionInvalidation(): void {
    this.#attentionCandidates.clear();
  }

  takeAttentionInvalidation(
    threadId: string,
    contexts: readonly ContextItem[],
    facts: readonly CanonicalItem[],
  ): boolean {
    if (this.#attentionCandidates.size === 0) return false;
    this.#refresh(threadId, contexts, facts);
    const changed = [...this.#attentionCandidates].some((id) =>
      this.#byRequest.has(id),
    );
    this.#attentionCandidates.clear();
    return changed;
  }

  #refresh(
    threadId: string,
    contexts: readonly ContextItem[],
    facts: readonly CanonicalItem[],
  ): void {
    if (!this.#dirty) return;
    this.#value =
      this.#callKeys.size === 0
        ? emptyQuestions
        : readUserQuestions(threadId, contexts, facts);
    this.#byRequest.clear();
    this.#pending = [];
    let openCount = 0;
    let latestPublishedAt: string | undefined;
    this.#value.forEach((question, position) => {
      const entry = { question, position };
      this.#byRequest.set(question.request.callItemId, entry);
      if (question.state !== "answered" && question.state !== "cancelled")
        this.#pending.push(entry);
      if (question.state === "open") openCount++;
      const timestamp = recordedTimestamp(question.createdAt);
      if (
        timestamp !== null &&
        (latestPublishedAt === undefined ||
          Date.parse(timestamp) > Date.parse(latestPublishedAt))
      )
        latestPublishedAt = timestamp;
    });
    this.#summary = {
      openCount,
      ...(latestPublishedAt === undefined ? {} : { latestPublishedAt }),
    };
    this.#dirty = false;
  }

  summary(
    threadId: string,
    contexts: readonly ContextItem[],
    facts: readonly CanonicalItem[],
  ): UserQuestionSummary {
    this.#refresh(threadId, contexts, facts);
    return { ...this.#summary };
  }

  read(
    threadId: string,
    contexts: readonly ContextItem[],
    facts: readonly CanonicalItem[],
  ): readonly UserQuestionState[] {
    this.#refresh(threadId, contexts, facts);
    return this.#value.length === 0
      ? emptyQuestions
      : structuredClone(this.#value);
  }

  get(
    threadId: string,
    contexts: readonly ContextItem[],
    facts: readonly CanonicalItem[],
    callItemId: string,
  ): UserQuestionState | undefined {
    this.#refresh(threadId, contexts, facts);
    const entry = this.#byRequest.get(callItemId);
    return entry === undefined ? undefined : structuredClone(entry.question);
  }

  page(
    threadId: string,
    contexts: readonly ContextItem[],
    facts: readonly CanonicalItem[],
    after?: string,
  ): UserQuestionPage {
    this.#refresh(threadId, contexts, facts);
    const cursor = after === undefined ? undefined : this.#byRequest.get(after);
    if (after !== undefined && cursor === undefined)
      throw new Error("Unknown question page cursor in this Thread");
    // Binary search a stable publication position, including after a cursor is answered.
    let left = 0;
    let right = this.#pending.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (this.#pending[middle]!.position <= (cursor?.position ?? -1))
        left = middle + 1;
      else right = middle;
    }
    const entries = this.#pending.slice(left, left + USER_QUESTION_PAGE_SIZE);
    return {
      questions: structuredClone(entries.map(({ question }) => question)),
      totalPending: this.#pending.length,
      ...(left + entries.length < this.#pending.length
        ? { nextAfter: entries.at(-1)!.question.request.callItemId }
        : {}),
    };
  }
}

/** Existing native Trace read projection supplies the fork/import boundary. */
function localFactIds(
  threadId: string,
  facts: readonly CanonicalItem[],
): Set<string> {
  const forkIndex = facts.findLastIndex(
    (item) => item.threadId === threadId && item.type === "thread_forked",
  );
  const metadata = facts.find(
    (item) => item.type === "thread_metadata" && item.threadId === threadId,
  );
  const boundary =
    forkIndex >= 0
      ? forkIndex
      : metadata?.type === "thread_metadata"
        ? (metadata.importedFrom?.historyItemCount ?? -1)
        : -1;
  return new Set(
    facts
      .slice(boundary + 1)
      .filter((item) => item.threadId === threadId)
      .map((item) => item.id),
  );
}

function matches(reply: UserQuestionReply, request: QuestionIdentity): boolean {
  return (
    reply.request.threadId === request.threadId &&
    reply.request.callItemId === request.callItemId
  );
}

/** Actual semantic call/result and native input facts, not client metadata or a new event log. */
export function readUserQuestions(
  threadId: string,
  itemList: readonly ContextItem[],
  facts: readonly CanonicalItem[],
): UserQuestionState[] {
  const localIds = localFactIds(threadId, facts);
  const results = itemList.filter(
    (item): item is Extract<ContextItem, { kind: "tool_result" }> =>
      item.threadId === threadId &&
      item.kind === "tool_result" &&
      item.content.exitCode === 0 &&
      item.source.metadata?.executionStatus === "completed" &&
      localIds.has(item.id),
  );
  const pending = pendingQueuedMessages(facts).filter(
    (item) => item.threadId === threadId && localIds.has(item.id),
  );
  const questions: UserQuestionState[] = [];
  for (const call of itemList) {
    if (
      call.threadId !== threadId ||
      call.kind !== "tool_call" ||
      call.content.name !== ASK_USER_QUESTION_NAME ||
      !localIds.has(call.id) ||
      call.source.metadata?.imported !== undefined
    )
      continue;
    let specification: UserQuestionSpecification;
    try {
      specification = parseUserQuestionSpecification(call.content.arguments);
    } catch {
      continue;
    }
    const request = { threadId, callItemId: call.id };
    const accepted = results.filter((result) => {
      if (
        result.turnId !== call.turnId ||
        result.content.callId !== call.content.callId
      )
        return false;
      const offset = result.source.metadata?.bodyStart;
      if (
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        return false;
      try {
        const envelope = JSON.parse(result.content.text.slice(offset)) as {
          kind?: unknown;
          version?: unknown;
          request?: QuestionIdentity;
          requestRef?: unknown;
        };
        return (
          envelope.kind === USER_QUESTION_PUBLICATION_KIND &&
          ((envelope.version === 1 && Object.keys(envelope).length === 3) ||
            (envelope.version === 2 &&
              Object.keys(envelope).length === 4 &&
              envelope.requestRef ===
                userQuestionRequestRef(call.source.sequence))) &&
          envelope.request?.threadId === threadId &&
          envelope.request.callItemId === call.id
        );
      } catch {
        return false;
      }
    });
    if (accepted.length === 0) continue;
    const result = accepted[0]!;
    const envelope = JSON.parse(
      result.content.text.slice(Number(result.source.metadata?.bodyStart)),
    );
    const question: UserQuestionState = {
      request,
      ...(envelope.version === 2
        ? { requestRef: envelope.requestRef as string }
        : {}),
      resultItemId: result.id,
      createdAt: result.createdAt,
      specification,
      state: accepted.length === 1 ? "open" : "unavailable",
    };
    const responses: {
      clientId: string;
      itemId: string;
      reply: UserQuestionReply;
      pending: boolean;
    }[] = [];
    const addResponse = (
      clientId: unknown,
      itemId: string,
      raw: unknown,
      body: string,
      isPending: boolean,
    ) => {
      try {
        const candidate = parseUserQuestionReply(raw);
        if (!matches(candidate, request)) return;
        const reply = normalizeUserQuestionReply(specification, candidate);
        if (
          typeof clientId !== "string" ||
          !matchesUserQuestionReplyBody(
            specification,
            reply,
            body,
            question.requestRef,
          )
        )
          throw new Error("Question response provenance/body mismatch");
        responses.push({ clientId, itemId, reply, pending: isPending });
      } catch {
        question.state = "unavailable";
      }
    };
    for (const item of itemList) {
      if (
        item.threadId !== threadId ||
        item.kind !== "message" ||
        item.role !== "user" ||
        item.source.kind !== "user_message" ||
        !localIds.has(item.id) ||
        item.source.metadata?.questionReply === undefined
      )
        continue;
      const offset = item.source.metadata.bodyStart;
      addResponse(
        item.source.metadata.clientId,
        item.id,
        item.source.metadata.questionReply,
        textFromUserInput(
          item.content.parts.slice(typeof offset === "number" ? offset : 0),
        ),
        false,
      );
    }
    for (const item of pending) {
      if (
        item.type === "user_message_queued" &&
        item.questionReply !== undefined
      )
        addResponse(
          item.clientId,
          item.id,
          item.questionReply,
          textFromUserInput(item.input),
          true,
        );
    }
    // A native claim whose semantic association went missing is unknown, not open.
    for (const item of facts) {
      if (
        item.threadId !== threadId ||
        !localIds.has(item.id) ||
        (item.type !== "user_message_queued" && item.type !== "user_message") ||
        !item.questionReply ||
        !matches(item.questionReply, request)
      )
        continue;
      const claimed = facts.find(
        (fact) =>
          fact.threadId === threadId &&
          fact.type === "user_message" &&
          fact.clientId === item.clientId,
      );
      if (
        claimed &&
        !responses.some(
          (response) => !response.pending && response.itemId === claimed.id,
        )
      )
        question.state = "unavailable";
    }
    if (question.state !== "unavailable") {
      if (responses.length > 1) question.state = "unavailable";
      else if (responses[0]) {
        const { pending: isPending, ...response } = responses[0];
        question.response = response;
        question.state = isPending
          ? response.reply.outcome === "answer"
            ? "answer-pending"
            : "cancel-pending"
          : response.reply.outcome === "answer"
            ? "answered"
            : "cancelled";
      }
    }
    questions.push(question);
  }
  return questions;
}

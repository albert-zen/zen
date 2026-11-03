import {
  normalizeUserQuestionReply,
  parseUserQuestionSpecification,
  type UserQuestionAnswer,
  type UserQuestionSpecification,
} from "../../../src/user-question.js";

/** Room product resource. Origin is provenance, never a Thread ownership binding. */
export interface RoomQuestion {
  roomId: string;
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  origin: { threadId: string; callItemId: string };
  specification: UserQuestionSpecification;
  state: "open" | "answered" | "cancelled" | "withdrawn";
  response?: {
    clientId: string;
    questionRevision: number;
    outcome: "answer" | "cancel";
    answers?: UserQuestionAnswer[];
    messageId: string;
    operationId: string;
    receivedAt: number;
  };
}
export interface RoomQuestionWorkspace {
  roomId: string;
  revision: number;
  openCount: number;
  totalQuestions: number;
  questions: readonly RoomQuestion[];
  nextAfter?: string;
}
export interface RoomQuestionResponseInput {
  roomId: string;
  questionId: string;
  expectedRevision: number;
  clientId: string;
  outcome: "answer" | "cancel";
  answers?: UserQuestionAnswer[];
}
export interface RoomQuestionWriteInput {
  roomId: string;
  questionId: string;
  expectedRevision: number;
  specification: unknown;
}
export interface RoomQuestionWorkspaceReadOptions {
  afterQuestionId?: string;
  expectedWorkspaceRevision?: number;
  includeClosed?: boolean;
}
function object(
  value: unknown,
  fields: string[],
  name: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
export function roomQuestionIdentity(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw Error("Exact bounded Room question identity required");
  return value;
}
export function roomQuestionRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw Error("Positive Room question revision required");
  return Number(value);
}
function time(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw Error("Invalid Room question timestamp");
  return value;
}
export function canonicalRoomQuestion(value: unknown): RoomQuestion {
  const input = object(
    value,
    [
      "roomId",
      "id",
      "revision",
      "createdAt",
      "updatedAt",
      "origin",
      "specification",
      "state",
      "response",
    ],
    "Room question",
  );
  const origin = object(
    input.origin,
    ["threadId", "callItemId"],
    "Room question origin",
  );
  const result: RoomQuestion = {
    roomId: roomQuestionIdentity(input.roomId),
    id: roomQuestionIdentity(input.id),
    revision: roomQuestionRevision(input.revision),
    createdAt: time(input.createdAt),
    updatedAt: time(input.updatedAt),
    origin: {
      threadId: roomQuestionIdentity(origin.threadId),
      callItemId: roomQuestionIdentity(origin.callItemId),
    },
    specification: parseUserQuestionSpecification(input.specification),
    state: input.state as RoomQuestion["state"],
  };
  if (
    result.updatedAt < result.createdAt ||
    !["open", "answered", "cancelled", "withdrawn"].includes(result.state)
  )
    throw Error("Invalid Room question state");
  if (input.response !== undefined) {
    const response = object(
      input.response,
      [
        "clientId",
        "questionRevision",
        "outcome",
        "answers",
        "messageId",
        "operationId",
        "receivedAt",
      ],
      "Room question response",
    );
    const reply = normalizeUserQuestionReply(result.specification, {
      version: 1,
      request: result.origin,
      outcome: response.outcome,
      ...(response.answers === undefined ? {} : { answers: response.answers }),
    });
    if (
      (result.state !== "answered" && result.state !== "cancelled") ||
      (result.state === "answered") !== (reply.outcome === "answer")
    )
      throw Error("Room question response disagrees with resource state");
    const questionRevision = roomQuestionRevision(response.questionRevision);
    if (questionRevision >= result.revision)
      throw Error(
        "Room question response must refer to its previous content revision",
      );
    result.response = {
      clientId: roomQuestionIdentity(response.clientId),
      questionRevision,
      outcome: reply.outcome,
      ...(reply.outcome === "answer" ? { answers: reply.answers } : {}),
      messageId: roomQuestionIdentity(response.messageId),
      operationId: roomQuestionIdentity(response.operationId),
      receivedAt: time(response.receivedAt),
    };
  } else if (result.state === "answered" || result.state === "cancelled")
    throw Error("Resolved Room question has no Room receipt");
  if (new TextEncoder().encode(JSON.stringify(result)).length > 131072)
    throw Error("Room question resource exceeds 128 KiB");
  return result;
}

export interface RoomQuestionResponseReadback {
  question: RoomQuestion | null;
  response: {
    clientId: string;
    status: "not-found" | "saved" | "conflict";
    messageId?: string;
    operationId?: string;
  };
  /** Existing Room delivery facts, never an inferred Thread admission. */
  delivery?: import("./main/trigger-types.js").RoomDeliveryView;
}

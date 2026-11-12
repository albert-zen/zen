import {
  type RoomUserQuestionPublicationInput,
  type RoomUserQuestionPublicationReceipt,
} from "../../../src/user-question-tool.js";
import { parseUserQuestionSpecification } from "../../../src/user-question.js";
import {
  roomQuestionIdentity,
  roomQuestionRevision,
} from "./room-questions.js";

/** Host runtime provenance, not an authored model or renderer request. */
export function validateRoomQuestionPublication(
  value: unknown,
): RoomUserQuestionPublicationInput {
  const input = record(value, ["roomId", "origin", "specification"]);
  const origin = record(input.origin, ["threadId", "callItemId"]);
  return {
    roomId: roomQuestionIdentity(input.roomId),
    origin: {
      threadId: roomQuestionIdentity(origin.threadId),
      callItemId: roomQuestionIdentity(origin.callItemId),
    },
    specification: parseUserQuestionSpecification(input.specification),
  };
}

export function validateRoomQuestionPublicationReceipt(
  value: unknown,
): RoomUserQuestionPublicationReceipt {
  const input = record(value, ["roomId", "questionId", "revision"]);
  return {
    roomId: roomQuestionIdentity(input.roomId),
    questionId: roomQuestionIdentity(input.questionId),
    revision: roomQuestionRevision(input.revision),
  };
}

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid Room question publication envelope");
  return value as Record<string, unknown>;
}

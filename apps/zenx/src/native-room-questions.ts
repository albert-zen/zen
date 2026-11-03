import { parseUserQuestionReply } from "../../../src/user-question.js";
import {
  roomQuestionIdentity,
  roomQuestionRevision,
  type RoomQuestion,
  type RoomQuestionResponseInput,
  type RoomQuestionResponseReadback,
  type RoomQuestionWorkspace,
  type RoomQuestionWorkspaceReadOptions,
} from "./room-questions.js";

export type NativeRoomQuestionRequest =
  | {
      method: "list";
      roomId: string;
      options?: RoomQuestionWorkspaceReadOptions;
    }
  | { method: "read"; roomId: string; questionId: string }
  | { method: "respond"; params: RoomQuestionResponseInput }
  | {
      method: "read-response";
      roomId: string;
      questionId: string;
      clientId: string;
    };
export interface NativeRoomQuestionResults {
  list: RoomQuestionWorkspace;
  read: RoomQuestion | null;
  respond: RoomQuestionResponseReadback;
  "read-response": RoomQuestionResponseReadback;
}
export type NativeRoomQuestionResult =
  NativeRoomQuestionResults[keyof NativeRoomQuestionResults];
export interface NativeRoomQuestionApi {
  request<T extends NativeRoomQuestionRequest>(
    input: T,
  ): Promise<NativeRoomQuestionResults[T["method"]]>;
  onChanged(listener: (roomId: string) => void): () => void;
}

function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw Error("Invalid native Room question fields");
  return value as Record<string, unknown>;
}
export function validateNativeRoomQuestionRequest(
  value: unknown,
): NativeRoomQuestionRequest {
  try {
    const request = object(value, [
      "method",
      "roomId",
      "questionId",
      "clientId",
      "options",
      "params",
    ]);
    if (request.method === "respond") {
      object(request, ["method", "params"]);
      const params = object(request.params, [
        "roomId",
        "questionId",
        "expectedRevision",
        "clientId",
        "outcome",
        "answers",
      ]);
      const reply = parseUserQuestionReply({
        version: 1,
        request: {
          threadId: "native-room-resource",
          callItemId: "native-room-resource",
        },
        outcome: params.outcome,
        ...(params.answers === undefined ? {} : { answers: params.answers }),
      });
      return {
        method: "respond",
        params: {
          roomId: roomQuestionIdentity(params.roomId),
          questionId: roomQuestionIdentity(params.questionId),
          expectedRevision: roomQuestionRevision(params.expectedRevision),
          clientId: roomQuestionIdentity(params.clientId),
          outcome: reply.outcome,
          ...(reply.outcome === "answer" ? { answers: reply.answers } : {}),
        },
      };
    }
    const roomId = roomQuestionIdentity(request.roomId);
    if (request.method === "list") {
      object(request, ["method", "roomId", "options"]);
      if (request.options === undefined) return { method: "list", roomId };
      const options = object(request.options, [
        "afterQuestionId",
        "expectedWorkspaceRevision",
        "includeClosed",
      ]);
      if (
        options.expectedWorkspaceRevision !== undefined &&
        (!Number.isSafeInteger(options.expectedWorkspaceRevision) ||
          Number(options.expectedWorkspaceRevision) < 0)
      )
        throw Error("Invalid Room workspace revision");
      if (
        options.includeClosed !== undefined &&
        typeof options.includeClosed !== "boolean"
      )
        throw Error("Invalid Room question filter");
      return {
        method: "list",
        roomId,
        options: {
          ...(options.afterQuestionId === undefined
            ? {}
            : {
                afterQuestionId: roomQuestionIdentity(options.afterQuestionId),
              }),
          ...(options.expectedWorkspaceRevision === undefined
            ? {}
            : {
                expectedWorkspaceRevision: Number(
                  options.expectedWorkspaceRevision,
                ),
              }),
          ...(options.includeClosed === undefined
            ? {}
            : { includeClosed: options.includeClosed }),
        },
      };
    }
    if (request.method === "read") {
      object(request, ["method", "roomId", "questionId"]);
      return {
        method: "read",
        roomId,
        questionId: roomQuestionIdentity(request.questionId),
      };
    }
    if (request.method === "read-response") {
      object(request, ["method", "roomId", "questionId", "clientId"]);
      return {
        method: "read-response",
        roomId,
        questionId: roomQuestionIdentity(request.questionId),
        clientId: roomQuestionIdentity(request.clientId),
      };
    }
    throw Error("Unknown native Room question method");
  } catch (error) {
    throw Object.assign(
      new Error(
        error instanceof Error
          ? error.message
          : "Invalid native Room question request",
      ),
      { code: "room_question_invalid_request" },
    );
  }
}

const errorType = "zenx.room-question-error.v1";
const rejectedCodes = new Set([
  "room_question_invalid_request",
  "room_question_conflict",
]);
export interface NativeRoomQuestionFailure {
  type: typeof errorType;
  outcome: "rejected" | "unknown";
  message: string;
  code?: string;
  currentRevision?: number;
}
export function nativeRoomQuestionFailure(
  error: unknown,
): NativeRoomQuestionFailure {
  const value = error as {
    message?: unknown;
    code?: unknown;
    currentRevision?: unknown;
  } | null;
  const code = typeof value?.code === "string" ? value.code : undefined;
  return {
    type: errorType,
    outcome:
      code !== undefined && rejectedCodes.has(code) ? "rejected" : "unknown",
    message: typeof value?.message === "string" ? value.message : String(error),
    ...(code === undefined ? {} : { code }),
    ...(Number.isSafeInteger(value?.currentRevision) &&
    Number(value?.currentRevision) >= 0
      ? { currentRevision: Number(value?.currentRevision) }
      : {}),
  };
}
export function unwrapNativeRoomQuestionReply<T>(
  reply: T | NativeRoomQuestionFailure,
): T {
  if (
    reply &&
    typeof reply === "object" &&
    "type" in reply &&
    reply.type === errorType
  ) {
    const failure = reply as NativeRoomQuestionFailure;
    const rejected =
      failure.outcome === "rejected" &&
      failure.code !== undefined &&
      rejectedCodes.has(failure.code);
    throw Object.assign(new Error(failure.message), {
      roomQuestionRejected: rejected,
      roomQuestionUnknown: !rejected,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(failure.currentRevision === undefined
        ? {}
        : { currentRevision: failure.currentRevision }),
    });
  }
  return reply as T;
}

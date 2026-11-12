export const CODEX_PROTOCOL_VERSION = "codex-cli 0.146.0";

export type RequestId = string | number;

export interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  id: RequestId;
  result: unknown;
}

export interface JsonRpcFailure {
  id: RequestId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export type SendJson = (message: JsonRpcMessage) => void;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRequest(message: unknown): message is JsonRpcRequest {
  return (
    isRecord(message) &&
    typeof message.method === "string" &&
    (typeof message.id === "string" || typeof message.id === "number")
  );
}

export function isNotification(
  message: unknown,
): message is JsonRpcNotification {
  return (
    isRecord(message) &&
    typeof message.method === "string" &&
    !("id" in message)
  );
}

export function isResponse(
  message: unknown,
): message is JsonRpcSuccess | (JsonRpcFailure & { id: RequestId }) {
  return (
    isRecord(message) &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    !("method" in message) &&
    ("result" in message || "error" in message)
  );
}

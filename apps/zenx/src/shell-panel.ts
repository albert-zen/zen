import type {
  ShellSessionRead,
  ShellSessionSummary,
} from "../../../src/shell-session.js";

export type ShellPanelRequest =
  | { operation: "list"; threadId: string }
  | { operation: "create"; threadId: string; cols: number; rows: number }
  | { operation: "read"; threadId: string; taskId: string; cursor?: number }
  | { operation: "write"; threadId: string; taskId: string; data: string }
  | {
      operation: "resize";
      threadId: string;
      taskId: string;
      cols: number;
      rows: number;
    }
  | { operation: "stop"; threadId: string; taskId: string };
export interface ShellPanelListing {
  sessions: ShellSessionSummary[];
  cwd: string;
  host: "local";
  canCreate: boolean;
  restriction?: string;
}
export type ShellPanelResult =
  ShellPanelListing | ShellSessionRead | ShellSessionSummary | null;
export interface ShellPanelBridge {
  request(input: ShellPanelRequest): Promise<ShellPanelResult>;
}

export function validateShellPanelRequest(
  value: unknown,
): asserts value is ShellPanelRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Shell request");
  const input = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    list: [],
    create: ["cols", "rows"],
    read: ["taskId", "cursor"],
    write: ["taskId", "data"],
    resize: ["taskId", "cols", "rows"],
    stop: ["taskId"],
  };
  if (
    typeof input.operation !== "string" ||
    !Object.hasOwn(fields, input.operation)
  )
    throw new Error("Invalid Shell operation");
  const allowed = ["operation", "threadId", ...fields[input.operation]!];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error(
      "Shell requests cannot override the Host, directory or execution policy",
    );
  for (const field of [
    "threadId",
    ...(input.operation === "list" || input.operation === "create"
      ? []
      : ["taskId"]),
  ]) {
    if (
      typeof input[field] !== "string" ||
      !input[field] ||
      (input[field] as string).length > 512
    )
      throw new Error(`Invalid Shell ${field}`);
  }
  if (["create", "resize"].includes(input.operation)) {
    for (const [field, max] of [
      ["cols", 500],
      ["rows", 200],
    ] as const) {
      const n = input[field];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max)
        throw new Error(`Invalid Shell ${field}`);
    }
  }
  if (
    input.operation === "write" &&
    (typeof input.data !== "string" || !input.data || input.data.length > 65536)
  )
    throw new Error("Invalid Shell input");
  if (
    input.cursor !== undefined &&
    (typeof input.cursor !== "number" ||
      !Number.isSafeInteger(input.cursor) ||
      input.cursor < 0)
  )
    throw new Error("Invalid Shell cursor");
}

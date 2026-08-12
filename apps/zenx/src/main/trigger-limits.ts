export const MAX_TRIGGER_COUNT = 256;
export const MAX_HISTORY_COUNT = 256;
export const MAX_ROOM_COUNT = 128;
export const MAX_ROOM_MEMBERS = 64;
export const MAX_ROOM_MESSAGES = 256;

export const MAX_ID_BYTES = 512;
export const MAX_TRIGGER_LABEL_BYTES = 256;
export const MAX_TRIGGER_PROMPT_BYTES = 4_096;
export const MAX_REASON_BYTES = 4_000;
export const MAX_ERROR_BYTES = 4_000;
export const MAX_ROOM_NAME_BYTES = 256;
export const MAX_MEMBER_NAME_BYTES = 128;
export const MAX_MESSAGE_AUTHOR_BYTES = 256;
export const MAX_MESSAGE_TEXT_BYTES = 8_000;

export const MAX_PROGRAM_COMMAND_BYTES = 4_096;
export const MAX_PROGRAM_ARGUMENTS = 64;
export const MAX_PROGRAM_ARGUMENT_BYTES = 4_096;
export const MAX_PROGRAM_CWD_BYTES = 4_096;
export const MAX_PROGRAM_ENV_ENTRIES = 64;
export const MAX_PROGRAM_ENV_KEY_BYTES = 256;
export const MAX_PROGRAM_ENV_VALUE_BYTES = 4_096;
export const MAX_PROGRAM_ENV_BYTES = 16 * 1_024;
export const MAX_PROGRAM_MATCH_REGEX_BYTES = 4_096;
export const MAX_PROGRAM_FLAGS_BYTES = 64;
export const MAX_PROGRAM_OUTCOMES = 4;

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function withinBytes(value: string, maximum: number): boolean {
  return utf8Bytes(value) <= maximum;
}

export function retainHistory<
  T extends { status: string; error?: string | null },
>(history: T[]): T[] {
  const live = history.filter(
    (entry) => entry.status === "starting" || entry.status === "running",
  ).length;
  if (live > 64)
    throw new Error("ZenX trigger registry has too many live wakeups");
  let terminalBudget = Math.max(0, MAX_HISTORY_COUNT - live);
  const admission = history.find((entry) =>
    entry.error?.includes("wakeup admission is full"),
  );
  const selected = new Set<T>(
    history.filter(
      (entry) => entry.status === "starting" || entry.status === "running",
    ),
  );
  if (admission !== undefined && terminalBudget > 0) {
    selected.add(admission);
    terminalBudget -= 1;
  }
  for (const entry of history) {
    if (entry.status === "starting" || entry.status === "running") continue;
    if (entry === admission || terminalBudget === 0) continue;
    selected.add(entry);
    terminalBudget -= 1;
  }
  return history.filter((entry) => selected.has(entry));
}

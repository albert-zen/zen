import { randomUUID } from "node:crypto";
import { BoundedLocalDiagnosticLog } from "./bounded-diagnostic-log.js";

export const providerValidationReasons = [
  "display_name_missing",
  "model_id_missing",
  "model_id_duplicate",
  "reasoning_efforts_missing",
  "reasoning_efforts_duplicate",
  "reasoning_default_invalid",
  "context_window_invalid",
  "provider_name_missing",
  "api_key_missing",
  "base_url_invalid",
  "base_url_scheme_invalid",
  "base_url_credentials",
  "base_url_query_fragment",
  "logo_invalid",
  "logo_loading",
  "replacement_default_missing",
  "replacement_title_missing",
  "validation_issues_truncated",
] as const;

export type ProviderValidationReason =
  (typeof providerValidationReasons)[number];
export type ProviderOperation = "add" | "edit";
export type ProviderSaveOutcome =
  "success" | "failed" | "committed-error" | "unconfirmed";

export type SettingsDiagnosticEvent =
  | {
      event: "provider-validation-rejected";
      attemptId: string;
      operation: ProviderOperation;
      reason: ProviderValidationReason;
      modelIndex?: number;
    }
  | {
      event: "provider-save-outcome";
      attemptId: string;
      operation: ProviderOperation;
      outcome: ProviderSaveOutcome;
    }
  | {
      event: "provider-save-reconciled";
      attemptId: string;
      operation: ProviderOperation;
      outcome: Exclude<ProviderSaveOutcome, "success">;
    };

type DiagnosticRecord = SettingsDiagnosticEvent & { timestamp: string };

const operations = new Set<ProviderOperation>(["add", "edit"]);
const reasons = new Set<string>(providerValidationReasons);
const outcomes = new Set<ProviderSaveOutcome>([
  "success",
  "failed",
  "committed-error",
  "unconfirmed",
]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// Never serialize a renderer object directly: it may contain keys, URLs,
// profile/model identifiers, error text, or unexpected enumerable properties.
export function normalizeSettingsDiagnostic(
  input: unknown,
  now = new Date(),
): DiagnosticRecord | null {
  if (input === null || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (
    typeof value.attemptId !== "string" ||
    !uuidPattern.test(value.attemptId) ||
    !operations.has(value.operation as ProviderOperation)
  )
    return null;
  const common = {
    timestamp: now.toISOString(),
    attemptId: value.attemptId.toLowerCase(),
    operation: value.operation as ProviderOperation,
  };
  if (value.event === "provider-validation-rejected") {
    if (typeof value.reason !== "string" || !reasons.has(value.reason))
      return null;
    if (
      value.modelIndex !== undefined &&
      (!Number.isInteger(value.modelIndex) ||
        (value.modelIndex as number) < 0 ||
        (value.modelIndex as number) > 1023)
    )
      return null;
    return {
      timestamp: common.timestamp,
      event: "provider-validation-rejected",
      attemptId: common.attemptId,
      operation: common.operation,
      reason: value.reason as ProviderValidationReason,
      ...(value.modelIndex === undefined
        ? {}
        : { modelIndex: value.modelIndex as number }),
    };
  }
  if (value.event === "provider-save-outcome") {
    if (!outcomes.has(value.outcome as ProviderSaveOutcome)) return null;
    return {
      timestamp: common.timestamp,
      event: "provider-save-outcome",
      attemptId: common.attemptId,
      operation: common.operation,
      outcome: value.outcome as ProviderSaveOutcome,
    };
  }
  if (value.event === "provider-save-reconciled") {
    if (
      value.outcome !== "failed" &&
      value.outcome !== "committed-error" &&
      value.outcome !== "unconfirmed"
    )
      return null;
    return {
      timestamp: common.timestamp,
      event: "provider-save-reconciled",
      attemptId: common.attemptId,
      operation: common.operation,
      outcome: value.outcome,
    };
  }
  return null;
}

export function isRendererSettingsDiagnostic(input: unknown): boolean {
  if (input === null || typeof input !== "object") return false;
  const event = (input as { event?: unknown }).event;
  return (
    event === "provider-validation-rejected" ||
    event === "provider-save-reconciled"
  );
}

export class SettingsDiagnosticLog {
  readonly #sink: BoundedLocalDiagnosticLog<DiagnosticRecord>;

  constructor(userDataDirectory: string, options: { maxBytes?: number } = {}) {
    this.#sink = new BoundedLocalDiagnosticLog({
      userDataDirectory,
      fileName: "settings.jsonl",
      normalize: normalizeSettingsDiagnostic,
      maxBytes: options.maxBytes,
    });
  }

  record(input: unknown): Promise<boolean> {
    return this.#sink.record(input);
  }
}

export async function runDiagnosedProviderMutation<T>(options: {
  log: Pick<SettingsDiagnosticLog, "record">;
  operation: ProviderOperation;
  attemptId?: string;
  preflight?(): void;
  knownRejection?(error: unknown): boolean;
  configurationStatus(): Promise<string | undefined>;
  mutate(context: { markCommitted(): void }): Promise<T>;
}): Promise<T> {
  const attemptId =
    options.attemptId && uuidPattern.test(options.attemptId)
      ? options.attemptId
      : randomUUID();
  let preflightPassed = false;
  let committed = false;
  try {
    options.preflight?.();
    preflightPassed = true;
    const result = await options.mutate({
      markCommitted: () => {
        committed = true;
      },
    });
    await recordSafely(options.log, {
      event: "provider-save-outcome",
      attemptId,
      operation: options.operation,
      outcome:
        (await readAsyncSafely(options.configurationStatus)) === "unconfirmed"
          ? "unconfirmed"
          : "success",
    });
    return result;
  } catch (error) {
    let knownRejected = false;
    if (preflightPassed && !committed) {
      try {
        knownRejected = options.knownRejection?.(error) === true;
      } catch {
        // A diagnostic classifier must not replace the mutation error.
      }
    }
    const status = committed
      ? await readAsyncSafely(options.configurationStatus)
      : undefined;
    const outcome: ProviderSaveOutcome =
      !preflightPassed || knownRejected
        ? "failed"
        : committed &&
            (status === "applied" ||
              status === "pending-restart" ||
              status === "unchanged")
          ? "committed-error"
          : "unconfirmed";
    await recordSafely(options.log, {
      event: "provider-save-outcome",
      attemptId,
      operation: options.operation,
      outcome,
    });
    throw error;
  }
}

async function readAsyncSafely<T>(
  read: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

async function recordSafely(
  log: Pick<SettingsDiagnosticLog, "record">,
  event: SettingsDiagnosticEvent,
): Promise<void> {
  try {
    await log.record(event);
  } catch {
    // Diagnostics are support data and must not change save semantics.
  }
}

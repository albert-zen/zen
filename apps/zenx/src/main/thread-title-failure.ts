export const MAX_TITLE_OWNERSHIP_FAILURE_EVIDENCE = 64;
export const MAX_TITLE_OWNERSHIP_ERROR_MESSAGE_LENGTH = 160;

const MAX_TITLE_OWNERSHIP_AGGREGATE_MESSAGE_LENGTH = 2_048;
const NORMALIZATION_FALLBACK =
  "Unprintable title ownership failure (normalization failed)";

/**
 * Copies an arbitrary thrown value without retaining or trusting its object
 * graph. Every reflective/coercion operation is guarded, so this function is
 * total even for hostile proxies, getters, symbols, cycles, and toString.
 */
export function normalizeTitleOwnershipFailure(value: unknown): Error {
  let description: string | undefined;
  try {
    description = primitiveDescription(value);
  } catch {
    description = undefined;
  }

  if (
    description === undefined &&
    (typeof value === "object" || typeof value === "function") &&
    value !== null
  ) {
    try {
      description = primitiveDescription(Reflect.get(value, "message"));
    } catch {
      description = undefined;
    }
    if (description === undefined) {
      try {
        description = String(value);
      } catch {
        description = undefined;
      }
    }
  }

  const message = boundedTitleOwnershipMessage(
    description === undefined || description.length === 0
      ? NORMALIZATION_FALLBACK
      : description,
  );
  return new Error(message);
}

export function aggregateTitleOwnershipFailures(
  failures: readonly unknown[],
  summary: string,
): AggregateError {
  const diagnostics = failures.map(normalizeTitleOwnershipFailure);
  const details = diagnostics.map((failure) => failure.message).join("; ");
  return new AggregateError(
    diagnostics,
    boundedAggregateMessage(
      details.length === 0 ? summary : `${summary}: ${details}`,
    ),
  );
}

export class BoundedTitleOwnershipFailures {
  readonly #failures: Error[] = [];
  #saturated = false;

  record(value: unknown): void {
    if (this.#saturated) return;
    if (this.#failures.length < MAX_TITLE_OWNERSHIP_FAILURE_EVIDENCE - 1) {
      this.#failures.push(normalizeTitleOwnershipFailure(value));
      return;
    }
    this.#saturated = true;
    this.#failures.push(
      new Error(
        boundedTitleOwnershipMessage(
          `Title ownership failure evidence reached its bounded capacity of ${String(
            MAX_TITLE_OWNERSHIP_FAILURE_EVIDENCE,
          )}; additional failures were omitted`,
        ),
      ),
    );
  }

  get healthy(): boolean {
    return this.#failures.length === 0;
  }

  aggregate(summary: string): AggregateError | undefined {
    return this.#failures.length === 0
      ? undefined
      : aggregateTitleOwnershipFailures(this.#failures, summary);
  }
}

function primitiveDescription(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
    case "undefined":
    case "symbol":
      return String(value);
    default:
      return value === null ? "null" : undefined;
  }
}

function boundedTitleOwnershipMessage(message: string): string {
  return message.length <= MAX_TITLE_OWNERSHIP_ERROR_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_TITLE_OWNERSHIP_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function boundedAggregateMessage(message: string): string {
  return message.length <= MAX_TITLE_OWNERSHIP_AGGREGATE_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_TITLE_OWNERSHIP_AGGREGATE_MESSAGE_LENGTH - 1)}…`;
}

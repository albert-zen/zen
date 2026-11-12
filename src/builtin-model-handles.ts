import {
  CAPABILITY_REFERENCE_BUDGET,
  ModelReferenceBudgetError,
  validateModelReferenceBindings,
  type ModelReferenceBinding,
  type ModelReferenceBudget,
} from "./model-references.js";

const TASK = "builtin-task";
const unavailable = () =>
  new Error(
    "Builtin reference unavailable; inspect the current source again. No action dispatched.",
  );

/** Existing accepted provenance only. Repeated receipts do not impose an aggregate cap. */
function bindings(history: readonly ModelReferenceBinding[]) {
  const result = new Map<string, ModelReferenceBinding>();
  for (const entry of history) {
    const binding = validateModelReferenceBindings([entry])[0]!;
    const key = JSON.stringify([binding.ownerThreadId, binding.ref]);
    const prior = result.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(binding))
      throw new Error("Conflicting immutable builtin reference provenance");
    result.set(key, binding);
  }
  return [...result.values()];
}

function freeze(binding: ModelReferenceBinding): ModelReferenceBinding {
  const checked = validateModelReferenceBindings([binding])[0]!;
  Object.freeze(checked.value);
  return Object.freeze(checked);
}

function budget(
  bindings: readonly ModelReferenceBinding[],
  limit: Readonly<ModelReferenceBudget>,
) {
  if (
    bindings.length > limit.maxBindings ||
    Buffer.byteLength(JSON.stringify(bindings)) > limit.maxBytes
  )
    throw new ModelReferenceBudgetError();
}

function highwater(
  history: readonly ModelReferenceBinding[],
  family: "t",
): number {
  let next = 1;
  for (const entry of history)
    if (entry.ref.startsWith(family))
      next = Math.max(next, Number(entry.ref.slice(1)) + 1);
  return next;
}

/** Synchronous allocation inside the existing TaskManager; occupied includes its live/retained tasks. */
export function allocateBuiltinTaskBinding(options: {
  ownerThreadId: string;
  sourceToolCallId: string;
  taskId: string;
  kind?: "task" | "shell-session";
  history: readonly ModelReferenceBinding[];
  occupied: readonly ModelReferenceBinding[];
  /** Existing manager's issued highwater, including receipts not yet committed by Runtime. */
  minimumNext?: number;
}): ModelReferenceBinding {
  if (!options.sourceToolCallId || !options.taskId) throw unavailable();
  if (
    options.minimumNext !== undefined &&
    (!Number.isSafeInteger(options.minimumNext) || options.minimumNext < 1)
  )
    throw unavailable();
  const existing = bindings([...options.history, ...options.occupied]);
  const kind = options.kind ?? "task";
  const value = {
    taskId: options.taskId,
    sourceToolCallId: options.sourceToolCallId,
  };
  const same = existing.find(
    (entry) =>
      entry.ownerThreadId === options.ownerThreadId &&
      entry.ref.startsWith("t") &&
      entry.namespace === TASK &&
      entry.kind === kind &&
      entry.epoch === undefined &&
      JSON.stringify(entry.value) === JSON.stringify(value),
  );
  if (same) {
    budget([same], CAPABILITY_REFERENCE_BUDGET);
    return freeze(same);
  }
  // Foreign/forked numbers remain reserved, never adopted as local authority.
  const next = Math.max(highwater(existing, "t"), options.minimumNext ?? 1);
  const binding = freeze({
    ref: `t${next}`,
    ownerThreadId: options.ownerThreadId,
    namespace: TASK,
    kind,
    value,
  });
  budget([binding], CAPABILITY_REFERENCE_BUDGET);
  return binding;
}

/** Resolves identity only; the existing TaskManager must still validate its live Thread owner. */
export function resolveBuiltinTaskReference(
  ownerThreadId: string,
  ref: string,
  history: readonly ModelReferenceBinding[],
): string {
  const binding = bindings(history).find(
    (entry) =>
      entry.ownerThreadId === ownerThreadId &&
      entry.ref === ref &&
      /^t[1-9][0-9]*$/u.test(ref) &&
      entry.namespace === TASK &&
      (entry.kind === "task" || entry.kind === "shell-session") &&
      entry.epoch === undefined,
  );
  const value = binding?.value;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("taskId" in value) ||
    !("sourceToolCallId" in value) ||
    typeof value.taskId !== "string" ||
    !value.taskId ||
    typeof value.sourceToolCallId !== "string" ||
    !value.sourceToolCallId
  )
    throw unavailable();
  return value.taskId;
}

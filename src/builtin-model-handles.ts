import type { ContextItem } from "./item-list.js";
import {
  CAPABILITY_REFERENCE_BUDGET,
  ModelReferenceBudgetError,
  validateModelReferenceBindings,
  type ModelReferenceBinding,
  type ModelReferenceBudget,
} from "./model-references.js";

const COMPACTION = "builtin-compaction";
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

const retainable = new Set([
  "user_message",
  "host_message",
  "thread_message",
  "thread_instruction",
  "agent_message",
  "tool_call",
  "tool_result",
  "failure",
]);

function compactionSource(ownerThreadId: string, source: ContextItem): boolean {
  return (
    source.threadId === ownerThreadId &&
    retainable.has(source.source.kind) &&
    source.source.metadata?.imported === undefined &&
    source.source.metadata?.parentCallId === undefined
  );
}

function highwater(
  history: readonly ModelReferenceBinding[],
  family: "c" | "t",
): number {
  let next = 1;
  for (const entry of history)
    if (entry.ref.startsWith(family))
      next = Math.max(next, Number(entry.ref.slice(1)) + 1);
  return next;
}

function itemIdentity(binding: ModelReferenceBinding): string | undefined {
  const value = binding.value;
  if (
    binding.namespace !== COMPACTION ||
    binding.kind !== "item" ||
    binding.epoch !== undefined ||
    !/^c[1-9][0-9]*$/u.test(binding.ref) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("itemId" in value) ||
    typeof value.itemId !== "string" ||
    !value.itemId
  )
    return undefined;
  return value.itemId;
}

/** Caller supplies only exact compiled, currently retention-eligible sources at the sample boundary. */
export function builtinCompactionReferences(options: {
  ownerThreadId: string;
  sources: readonly ContextItem[];
  history: readonly ModelReferenceBinding[];
  budget?: Readonly<ModelReferenceBudget>;
}): { text: string; referenceBindings: ModelReferenceBinding[] } {
  const history = bindings(options.history);
  let next = highwater(history, "c");
  const owned = new Map(
    history
      .filter((entry) => entry.ownerThreadId === options.ownerThreadId)
      .map((entry) => [itemIdentity(entry), entry]),
  );
  const referenceBindings: ModelReferenceBinding[] = [];
  const labels: string[] = [];
  for (const source of options.sources) {
    if (!compactionSource(options.ownerThreadId, source)) continue;
    const binding =
      owned.get(source.id) ??
      freeze({
        ref: `c${next++}`,
        ownerThreadId: options.ownerThreadId,
        namespace: COMPACTION,
        kind: "item",
        value: { itemId: source.id },
      });
    owned.set(source.id, binding);
    if (referenceBindings.some((entry) => entry.ref === binding.ref)) continue;
    referenceBindings.push(freeze(binding));
    labels.push(`${binding.ref} ${source.source.kind.replaceAll("_", " ")}`);
  }
  budget(referenceBindings, options.budget ?? CAPABILITY_REFERENCE_BUDGET);
  return {
    text:
      labels.length === 0
        ? ""
        : `[compact_context optional retention references (not a compaction event; no context was changed by this list): ${labels.join("; ")}]`,
    referenceBindings,
  };
}

export function resolveBuiltinCompactionReference(options: {
  ownerThreadId: string;
  ref: string;
  history: readonly ModelReferenceBinding[];
  sources: readonly ContextItem[];
}): string {
  const binding = bindings(options.history).find(
    (entry) =>
      entry.ownerThreadId === options.ownerThreadId &&
      entry.ref === options.ref,
  );
  const id = binding === undefined ? undefined : itemIdentity(binding);
  const source = options.sources.find(
    (entry) =>
      id !== undefined &&
      entry.id === id &&
      compactionSource(options.ownerThreadId, entry),
  );
  if (!source) throw unavailable();
  return source.id;
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

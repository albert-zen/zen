import type { JsonValue } from "./item.js";

/** Host provenance for a compact model ref. A reference never grants permission. */
export interface ModelReferenceBinding {
  ref: string;
  ownerThreadId: string;
  namespace: string;
  kind: string;
  value: JsonValue;
  epoch?: string;
}
export interface ModelReferenceBudget {
  maxBindings: number;
  maxBytes: number;
}
export const CAPABILITY_REFERENCE_BUDGET: Readonly<ModelReferenceBudget> =
  Object.freeze({ maxBindings: 4096, maxBytes: 1024 * 1024 });
export class ModelReferenceBudgetError extends Error {
  constructor() {
    super("Compact reference projection exceeded its publication budget");
    this.name = "ModelReferenceBudgetError";
  }
}
const REF = /^[rs][1-9][0-9]*$/u;
const fields = new Set([
  "ref",
  "ownerThreadId",
  "namespace",
  "kind",
  "value",
  "epoch",
]);
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function json(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  ancestors.add(value);
  const valid = Object.values(value).every((entry) => json(entry, ancestors));
  ancestors.delete(value);
  return valid;
}
/** Shape validation is not provenance authentication. No late aggregate size cap. */
export function validateModelReferenceBindings(
  value: unknown,
): ModelReferenceBinding[] {
  if (!Array.isArray(value)) throw Error("Invalid model reference bindings");
  const seen = new Set<string>();
  for (const binding of value) {
    if (
      !binding ||
      typeof binding !== "object" ||
      Array.isArray(binding) ||
      Object.keys(binding).some((key) => !fields.has(key)) ||
      typeof binding.ref !== "string" ||
      !REF.test(binding.ref) ||
      !Number.isSafeInteger(Number(binding.ref.slice(1))) ||
      !nonempty(binding.ownerThreadId) ||
      !nonempty(binding.namespace) ||
      !nonempty(binding.kind) ||
      (binding.epoch !== undefined && !nonempty(binding.epoch)) ||
      !json(binding.value)
    )
      throw Error("Invalid model reference binding");
    const identity = JSON.stringify([binding.ownerThreadId, binding.ref]);
    if (seen.has(identity)) throw Error("Duplicate model reference binding");
    seen.add(identity);
  }
  return structuredClone(value) as ModelReferenceBinding[];
}
interface ScopeState {
  next: number;
  bindings: Map<string, ModelReferenceBinding>;
  identities: Map<string, string>;
}
function identity(
  binding: Pick<
    ModelReferenceBinding,
    "namespace" | "kind" | "value" | "epoch"
  >,
): string {
  return JSON.stringify([
    binding.namespace,
    binding.kind,
    binding.value,
    binding.epoch,
  ]);
}
/** Disposable cache reconstructed from existing canonical provenance, not a store. */
export class ModelReferenceRegistry {
  readonly #owners = new Map<string, ScopeState>();
  scope(
    ownerThreadId: string,
    history: readonly ModelReferenceBinding[] = [],
    budget?: Readonly<ModelReferenceBudget>,
  ): ModelReferenceScope {
    let state = this.#owners.get(ownerThreadId);
    if (!state) {
      state = { next: 1, bindings: new Map(), identities: new Map() };
      this.#owners.set(ownerThreadId, state);
    }
    for (const binding of history) {
      const index = REF.test(binding.ref) ? Number(binding.ref.slice(1)) : NaN;
      if (!Number.isSafeInteger(index))
        throw Error("Invalid reference provenance");
      // Forked refs reserve numbers, but never inherit the parent's authority.
      if (binding.ref.startsWith("r"))
        state.next = Math.max(state.next, index + 1);
      if (binding.ownerThreadId !== ownerThreadId) continue;
      const prior = state.bindings.get(binding.ref);
      if (prior && JSON.stringify(prior) !== JSON.stringify(binding))
        throw Error("Conflicting reference provenance; refresh the source");
      const cloned = structuredClone(binding);
      state.bindings.set(binding.ref, cloned);
      if (binding.ref.startsWith("r"))
        state.identities.set(identity(cloned), binding.ref);
    }
    return new ModelReferenceScope(ownerThreadId, state, budget);
  }
}
export class ModelReferenceScope {
  readonly #used = new Map<string, ModelReferenceBinding>();
  readonly #published = new Set<string>();
  #bytes = 2;
  constructor(
    readonly ownerThreadId: string,
    private readonly state: ScopeState,
    readonly budget?: Readonly<ModelReferenceBudget>,
  ) {}
  bind(
    namespace: string,
    kind: string,
    value: JsonValue,
    epoch?: string,
  ): string {
    const key = identity({ namespace, kind, value, epoch });
    const previous = this.state.identities.get(key);
    if (previous) {
      const binding = this.state.bindings.get(previous)!;
      this.#reserve(binding);
      this.#used.set(previous, binding);
      return previous;
    }
    if (!Number.isSafeInteger(this.state.next))
      throw Error("Model reference scope exhausted");
    const binding: ModelReferenceBinding = {
      ref: `r${this.state.next}`,
      ownerThreadId: this.ownerThreadId,
      namespace,
      kind,
      value: structuredClone(value),
      ...(epoch === undefined ? {} : { epoch }),
    };
    validateModelReferenceBindings([binding]);
    this.#reserve(binding);
    this.state.next++;
    this.state.bindings.set(binding.ref, binding);
    this.state.identities.set(key, binding.ref);
    this.#used.set(binding.ref, binding);
    return binding.ref;
  }
  #reserve(binding: ModelReferenceBinding): void {
    if (this.#published.has(binding.ref)) return;
    const bytes =
      new TextEncoder().encode(JSON.stringify(binding)).byteLength +
      (this.#published.size ? 1 : 0);
    if (
      this.budget &&
      (this.#published.size >= this.budget.maxBindings ||
        this.#bytes + bytes > this.budget.maxBytes)
    )
      throw new ModelReferenceBudgetError();
    this.#bytes += bytes;
    this.#published.add(binding.ref);
  }
  lookup(ref: unknown): ModelReferenceBinding | undefined {
    const binding =
      typeof ref === "string" ? this.state.bindings.get(ref) : undefined;
    return binding?.ownerThreadId === this.ownerThreadId
      ? structuredClone(binding)
      : undefined;
  }
  resolve(
    ref: unknown,
    namespace: string,
    kind: string,
    epoch?: string,
  ): JsonValue {
    const binding =
      typeof ref === "string" ? this.state.bindings.get(ref) : undefined;
    if (
      !binding ||
      binding.ownerThreadId !== this.ownerThreadId ||
      binding.namespace !== namespace ||
      binding.kind !== kind ||
      binding.epoch !== epoch
    )
      throw Error(
        "Reference unavailable or retired; read or inspect the source again. No action dispatched.",
      );
    // Existing input provenance may not be dropped by an output-publication budget.
    this.#used.set(binding.ref, binding);
    return structuredClone(binding.value);
  }
  /** Every used/emitted binding repeats so independent result commit order is safe. */
  get newBindings(): ModelReferenceBinding[] {
    return structuredClone([...this.#used.values()]);
  }
}
const trusted = new WeakMap<object, readonly ModelReferenceBinding[]>();
export function attachModelReferenceBindings<T extends object>(
  result: T,
  bindings: readonly ModelReferenceBinding[],
): T & { referenceBindings: ModelReferenceBinding[] } {
  const checked = validateModelReferenceBindings(bindings);
  const attached = Object.assign(result, {
    referenceBindings: structuredClone(checked),
  });
  trusted.set(attached, checked);
  return attached;
}
export function trustedModelReferenceBindings(
  result: unknown,
): readonly ModelReferenceBinding[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const bindings = trusted.get(result);
  if (
    bindings === undefined ||
    JSON.stringify(
      (result as { referenceBindings?: unknown }).referenceBindings,
    ) !== JSON.stringify(bindings)
  )
    return undefined;
  return structuredClone(bindings);
}

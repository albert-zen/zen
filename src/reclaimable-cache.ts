/** Bounded hot values, with weak identity reuse while a caller still owns a value. */
export class ReclaimableCache<K, V extends object> {
  readonly #hot = new Map<K, V>();
  readonly #entries = new Map<K, WeakRef<V>>();
  readonly #finalized = new FinalizationRegistry<{ key: K; ref: WeakRef<V> }>(
    ({ key, ref }) => {
      // An old value's finalizer must not remove its replacement.
      if (this.#entries.get(key) === ref) this.#entries.delete(key);
    },
  );

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0)
      throw new Error("Cache capacity must be a non-negative integer");
  }

  /** Presence checks do not promote a history merely for sidebar inspection. */
  has(key: K): boolean {
    return this.#entries.get(key)?.deref() !== undefined;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key)?.deref();
    if (value === undefined) this.#entries.delete(key);
    else this.#touch(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.delete(key);
    const ref = new WeakRef(value);
    this.#entries.set(key, ref);
    this.#finalized.register(value, { key, ref }, ref);
    this.#touch(key, value);
  }

  delete(key: K): void {
    const ref = this.#entries.get(key);
    if (ref !== undefined) this.#finalized.unregister(ref);
    this.#entries.delete(key);
    this.#hot.delete(key);
  }

  #touch(key: K, value: V): void {
    this.#hot.delete(key);
    this.#hot.set(key, value);
    while (this.#hot.size > this.capacity)
      this.#hot.delete(this.#hot.keys().next().value!);
  }
}

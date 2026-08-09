import { mkdir, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TriggerSnapshot } from "./trigger-types.js";

interface StoredState extends TriggerSnapshot {
  version: 1;
}

export class ZenXTriggerStore {
  readonly #filePath: string;
  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async read(): Promise<TriggerSnapshot> {
    let handle;
    try {
      handle = await open(this.#filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptySnapshot();
      throw error;
    }
    try {
      const value = JSON.parse(await handle.readFile("utf8")) as unknown;
      if (!isStoredState(value))
        throw new Error("ZenX trigger registry is invalid");
      return {
        triggers: value.triggers,
        history: value.history,
        rooms: value.rooms,
      };
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("ZenX trigger registry contains invalid JSON");
      throw error;
    } finally {
      await handle.close();
    }
  }

  async write(snapshot: TriggerSnapshot): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    const value: StoredState = { version: 1, ...snapshot };
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#filePath);
  }
}

function emptySnapshot(): TriggerSnapshot {
  return { triggers: [], history: [], rooms: [] };
}
function isStoredState(value: unknown): value is StoredState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<StoredState>;
  return (
    state.version === 1 &&
    Array.isArray(state.triggers) &&
    Array.isArray(state.history) &&
    Array.isArray(state.rooms)
  );
}

import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonlThreadJournal } from "../src/journal.js";
import { JsonlThreadMetadataStore } from "../src/thread-metadata.js";
import type { CanonicalItem } from "../src/item.js";

const item: CanonicalItem = {
  type: "thread_metadata",
  id: "metadata",
  threadId: "thread",
  createdAt: "2026-10-24T00:00:00.000Z",
  cwd: "/tmp/中文🙂",
  providerProfileId: "fake",
  modelId: "fake",
  reasoningEffort: "medium",
  sandbox: "danger-full-access",
  approvalPolicy: "never",
};

for (const operation of ["append", "create", "metadata"] as const) {
  for (const mode of ["short", "zero", "failure-after-prefix"] as const) {
    test(`${operation} handles ${mode} writes without false success`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "zen-write-all-"));
      const handle = await open(path.join(directory, "prototype"), "w");
      const prototype = Object.getPrototypeOf(handle) as {
        write: (...args: any[]) => Promise<any>;
      };
      const original = prototype.write;
      await handle.close();
      let writes = 0;
      prototype.write = async function (
        data: string | Buffer,
        offset?: number,
        length?: number,
      ) {
        writes += 1;
        const bytes =
          typeof data === "string"
            ? Buffer.from(data)
            : data.subarray(
                offset ?? 0,
                (offset ?? 0) + (length ?? data.length),
              );
        if (mode === "zero") return { bytesWritten: 0, buffer: data };
        if (mode === "failure-after-prefix" && writes > 1)
          throw new Error("injected write failure");
        const prefix = bytes.subarray(0, Math.min(7, bytes.length));
        return await original.call(this, prefix, 0, prefix.length, null);
      };
      try {
        const journal = new JsonlThreadJournal(directory);
        const metadata = new JsonlThreadMetadataStore(
          path.join(directory, "metadata.jsonl"),
        );
        const write = () =>
          operation === "append"
            ? journal.append(item)
            : operation === "create"
              ? journal.create([item])
              : metadata.setName("thread", "中文🙂 name");
        if (mode === "short") {
          await write();
          assert.ok(writes > 1, "the entire UTF-8 record must be written");
          if (operation === "metadata") {
            assert.deepEqual(
              await new JsonlThreadMetadataStore(
                path.join(directory, "metadata.jsonl"),
              ).read("thread"),
              { name: "中文🙂 name" },
            );
          } else {
            assert.deepEqual(await journal.read("thread"), [item]);
            assert.equal(
              await readFile(path.join(directory, "thread.jsonl"), "utf8"),
              `${JSON.stringify(item)}\n`,
            );
          }
        } else {
          await assert.rejects(
            write(),
            mode === "zero" ? /no progress/ : /injected write failure/,
          );
          if (operation === "create")
            await assert.rejects(stat(path.join(directory, "thread.jsonl")), {
              code: "ENOENT",
            });
          if (operation === "metadata")
            assert.deepEqual(await metadata.read("thread"), {});
          if (mode === "zero")
            assert.equal(writes, 1, "zero progress must not spin");
        }
      } finally {
        prototype.write = original;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

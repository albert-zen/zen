import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import type { CanonicalItem, ApprovalDecision } from "../src/item.js";
import { ToolEnvironment } from "../src/tool.js";
import { testToolRuntime } from "./tool-fixtures.js";

for (const uncertain of [false, true])
  test(`pending approval cannot dispatch after ${uncertain ? "uncertain permission log append" : "permission revocation"}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-log-fence-"));
    let asked!: () => void;
    const approvalRequested = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let grant!: (value: ApprovalDecision) => void;
    const decision = new Promise<ApprovalDecision>((resolve) => {
      grant = resolve;
    });
    let bodies = 0;
    class Journal extends InMemoryThreadJournal {
      override async append(item: CanonicalItem): Promise<void> {
        await super.append(item);
        if (
          uncertain &&
          item.type === "thread_configuration_changed" &&
          "permissions" in item
        )
          throw new Error(
            "synthetic fsync outcome unknown after frame publication",
          );
      }
    }
    const journal = new Journal();
    const environment = new ToolEnvironment({
      runtimes: [
        testToolRuntime({
          name: "write_once",
          execute: async () => {
            bodies++;
            await writeFile(path.join(root, "effect"), "performed");
            return { output: "done", exitCode: 0 };
          },
        }),
      ],
    });
    const server = createHostedAppServer({
      cwd: root,
      dataDirectory: root,
      model: "fake",
      provider: { type: "fake" },
      toolPresentation: "direct",
      approvalPolicy: "always",
      journal,
      toolEnvironment: environment,
    });
    try {
      const thread = await server.startThread();
      const turn = await server.startTurn(thread.id, "!tool write_once {}", {
        requestApproval: async () => {
          asked();
          return decision;
        },
      });
      await approvalRequested;
      if (uncertain)
        await assert.rejects(
          server.setThreadPermissions(thread.id, "read-only"),
          /unknown/,
        );
      else
        assert.equal(
          (await server.setThreadPermissions(thread.id, "read-only")).sandbox,
          "read-only",
        );
      // A read may reconstruct a NEW projection. It must not revive the old lease.
      assert.equal((await server.readThread(thread.id)).sandbox, "read-only");
      grant("accept");
      await Promise.allSettled([turn.done]);
      assert.equal(bodies, 0);
      await assert.rejects(readFile(path.join(root, "effect")), {
        code: "ENOENT",
      });
    } finally {
      grant?.("cancel");
      await server.closeHostResources();
      await rm(root, { recursive: true, force: true });
    }
  });

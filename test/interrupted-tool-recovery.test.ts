import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createHostedAppServer,
  type ZenHostOptions,
} from "../apps/cli/src/host.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileTraceStore } from "../src/trace.js";
import { createToolTraceCapture } from "../src/trace-tool.js";
import { ToolEnvironment } from "../src/tool.js";
import { testToolRuntime } from "./tool-fixtures.js";

for (const accepted of [false, true])
  test(`explicit continuation restores ${accepted ? "accepted" : "unknown"} outcome without replay; cold inspection does not mutate`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-recovery-"));
    const options: ZenHostOptions = {
      cwd: root,
      dataDirectory: root,
      provider: { type: "fake" },
      model: "fake",
      approvalPolicy: "never",
      toolPresentation: "direct",
    };
    let bodies = 0;
    const env = () =>
      new ToolEnvironment({
        runtimes: [
          testToolRuntime({
            name: "write_once",
            execute: async () => {
              bodies++;
              return { output: "unexpected repeat", exitCode: 0 };
            },
          }),
        ],
      });
    try {
      const initial = createHostedAppServer({
        ...options,
        toolEnvironment: env(),
      });
      const thread = await initial.startThread();
      await initial.closeHostResources();
      const trace = new FileTraceStore(path.join(root, "trace"));
      const journal = new DomainThreadJournal({
        directory: path.join(root, "threads"),
        metadata: new InMemoryThreadMetadataStore(),
        trace,
      });
      const base = {
        threadId: thread.id,
        createdAt: "2026-10-27T00:00:00Z",
        turnId: "interrupted",
      };
      await journal.append({
        ...base,
        id: "start",
        type: "turn_started",
        selection: {
          providerProfileId: "fake",
          modelId: "fake",
          reasoningEffort: null,
        },
      });
      await journal.append({
        ...base,
        id: "input",
        type: "user_message",
        text: "perform once",
      });
      await journal.append({
        ...base,
        id: "call-item",
        type: "tool_call",
        callId: "call",
        name: "write_once",
        arguments: {},
      });
      if (accepted) {
        const sink = createToolTraceCapture(trace, {
          threadId: thread.id,
          turnId: "interrupted",
          callId: "call",
          toolCallItemId: "call-item",
        });
        await sink.recordResult(
          { output: "already performed", exitCode: 0 },
          "synthetic-boundary",
        );
        await sink.recordAcceptedResult({
          output: "already performed",
          exitCode: 0,
        });
      }
      await journal.close();
      const before = await readFile(
        path.join(root, "threads", "items", `${thread.id}.jsonl`),
        "utf8",
      );
      const cold = createHostedAppServer({
        ...options,
        toolEnvironment: env(),
      });
      try {
        assert.equal(
          (await cold.readThread(thread.id)).items.some(
            (item) => item.type === "tool_result",
          ),
          false,
        );
        assert.equal(bodies, 0);
        assert.equal(
          await readFile(
            path.join(root, "threads", "items", `${thread.id}.jsonl`),
            "utf8",
          ),
          before,
        );
        await (
          await cold.startTurn(
            thread.id,
            "Inspect the previous result; do not repeat the action.",
          )
        ).done;
        const result = (await cold.readThread(thread.id)).items.find(
          (item) => item.type === "tool_result",
        );
        assert.equal(result?.type, "tool_result");
        if (result?.type !== "tool_result") throw Error("missing result");
        assert.equal(
          result.executionStatus,
          accepted ? "completed" : "unknown",
        );
        assert.equal(result.exitCode, accepted ? 0 : null);
        assert.match(
          result.output,
          accepted ? /already performed/ : /external outcome is unknown/,
        );
        assert.equal(bodies, 0);
      } finally {
        await cold.closeHostResources();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

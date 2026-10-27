import assert from "node:assert/strict";
import test from "node:test";
import { compileSelectedReferenceInput } from "../../../src/selected-reference-input.js";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import { referenceMessage } from "../src/renderer/src/reference-draft.js";
import { invokeModelToolFacade } from "../src/main/capabilities/model-tool-facade.js";

test("real generated selected message refs reach native dispatch without bypassing its current permission check", async () => {
  const item = {
    type: "user_message" as const,
    id: "input",
    threadId: "owner",
    turnId: "turn",
    createdAt: "2026-10-27T02:00:00Z",
    clientId: "submission",
    text: referenceMessage(
      "\uFFFC",
      [
        {
          kind: "message",
          name: "Source",
          cwd: "/tmp/source",
          threadId: "source-thread",
          id: "source-item",
          excerpt: "exact",
          position: 0,
        },
      ],
      "submission",
    ),
  };
  const provenance = compileSelectedReferenceInput(item, [])!.referenceBindings;
  let checked = false;
  await assert.rejects(
    invokeModelToolFacade({
      references: new ModelReferenceRegistry(),
      epoch: "current",
      invocation: {
        name: "zenx_threads_read",
        callId: "call",
        arguments: { ref: "s1" },
        threadId: "owner",
        cwd: "/tmp",
        signal: new AbortController().signal,
        modelReferences: provenance,
      },
      dispatch: async (invocation) => {
        checked = true;
        assert.equal(invocation.arguments.threadId, "source-thread");
        assert.equal(invocation.arguments.itemId, "source-item");
        throw new Error("native current permission denied");
      },
    }),
    /native current permission denied/,
  );
  assert.equal(checked, true);
});

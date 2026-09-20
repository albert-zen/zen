import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCandidates,
  expandWorkflowCommand,
  type WorkflowCommand,
} from "../src/renderer/src/workflow-commands.js";

const review: WorkflowCommand = {
  name: "review",
  description: "Review a change",
  prompt: "Review carefully:\n{{args}}",
  enabled: true,
};

test("Slash candidates include built-ins and enabled custom workflows", () => {
  assert.deepEqual(
    commandCandidates("/", [
      review,
      { ...review, name: "off", enabled: false },
    ]).map((command) => command.name),
    ["compact", "review"],
  );
  assert.deepEqual(
    commandCandidates("/rev", [review]).map((command) => command.name),
    ["review"],
  );
  assert.deepEqual(
    commandCandidates("/review src/app.ts", [review]).map(
      (command) => command.name,
    ),
    ["review"],
  );
  assert.deepEqual(commandCandidates("hello", [review]), []);
});

test("choosing a workflow only expands reviewable message text", () => {
  const candidate = commandCandidates("/rev", [review])[0]!;
  assert.equal(
    expandWorkflowCommand("/review src/app.ts", candidate),
    "Review carefully:\nsrc/app.ts",
  );
  assert.equal(
    expandWorkflowCommand("/review $& $` $' $$", candidate),
    "Review carefully:\n$& $` $' $$",
  );
  assert.equal(
    expandWorkflowCommand("/comp", commandCandidates("/comp", [review])[0]!),
    "/compact",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TITLE_PROMPT,
  normalizeTitlePrompt,
  normalizeWorkflowCommands,
  renderTitlePrompt,
} from "../src/main/workflow-configuration.js";

test("workflow configuration rejects duplicate and built-in command names", () => {
  const command = {
    name: "review",
    description: "Review this change",
    prompt: "Review this change: {{args}}",
    enabled: true,
  };
  assert.throws(
    () => normalizeWorkflowCommands([command, command]),
    /names must be unique/u,
  );
  assert.throws(
    () => normalizeWorkflowCommands([{ ...command, name: "compact" }]),
    /built in and cannot be replaced/u,
  );
});

test("title prompt has one explicit placeholder and restores the default", () => {
  assert.equal(normalizeTitlePrompt("  "), undefined);
  assert.equal(normalizeTitlePrompt(undefined), undefined);
  assert.throws(() => normalizeTitlePrompt("Make a title"), /\{\{request\}\}/u);
  assert.throws(
    () => normalizeTitlePrompt("{{request}} {{thread}}"),
    /Unknown title prompt placeholder/u,
  );
  assert.equal(
    renderTitlePrompt(undefined, "hello"),
    DEFAULT_TITLE_PROMPT.replace("{{request}}", "hello"),
  );
  assert.equal(
    renderTitlePrompt("Title: {{request}}", "hello"),
    "Title: hello",
  );
  assert.equal(
    renderTitlePrompt("Title: {{request}}", "$& $` $' $$"),
    "Title: $& $` $' $$",
  );
});

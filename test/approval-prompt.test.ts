import assert from "node:assert/strict";
import test from "node:test";
import { formatApprovalPrompt } from "../apps/cli/src/approval-prompt.js";

test("CLI describes exact target memory and limits its session shortcut", () => {
  const prompt = formatApprovalPrompt({
    command: "navigate",
    toolName: "browser_connected_navigate",
    approvalTarget: { key: "browser-instance:a", label: "Edge a" },
  });
  assert.match(prompt, /Edge a/u);
  assert.match(prompt, /tool and target only/u);
  assert.match(prompt, /\[a\]pprove once/u);
  assert.doesNotMatch(prompt, /all session|by tool name/u);
});

test("CLI preserves legacy tool approval prompt", () => {
  const prompt = formatApprovalPrompt({
    command: "text(1)",
    toolName: "run_code",
  });
  assert.match(prompt, /shell-equivalent run_code/u);
  assert.match(prompt, /remembered by tool name/u);
  assert.match(prompt, /\[a\]ll session/u);
});

test("CLI scoped one-time approval does not promise remembered access", () => {
  const prompt = formatApprovalPrompt({
    command: "navigate",
    toolName: "browser_connected_navigate",
    approvalScope: "once",
    approvalTarget: { key: "a", label: "Chrome a" },
  });
  assert.match(prompt, /only to this call/u);
  assert.doesNotMatch(prompt, /remembered|all session/u);
});

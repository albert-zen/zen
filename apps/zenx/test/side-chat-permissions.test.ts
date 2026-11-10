import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SideChatDrafts } from "../src/renderer/src/side-chat-drafts.js";
import { permissionPresentation } from "../src/renderer/src/model-settings.js";

test("side draft keeps permissions from its fixed boundary, not the later parent or selected model", async () => {
  const drafts = new SideChatDrafts(
    () => {},
    () => "draft",
  );
  const parent = {
    permissionMode: "read-only" as const,
    approvalPolicy: "on-request" as const,
  };
  const draft = drafts.open(
    "parent",
    { itemId: "checkpoint-30" },
    {
      inheritedPermissions: parent,
      inheritedModel: "custom-profile/model",
    },
  );
  Object.assign(parent, {
    permissionMode: "danger-full-access",
    approvalPolicy: "never",
  });
  drafts.configure(draft.id, { model: "default-profile/other-model" });
  assert.deepEqual(draft.inheritedPermissions, {
    permissionMode: "read-only",
    approvalPolicy: "on-request",
  });
  assert.equal(
    permissionPresentation(draft.inheritedPermissions).permissionMode,
    "read-only",
  );
  assert.deepEqual(draft.boundary, { itemId: "checkpoint-30" });
});

test("missing/loading snapshot hides permissions rather than guessing Full access", () => {
  const drafts = new SideChatDrafts(
    () => {},
    () => "draft",
  );
  const draft = drafts.open("parent", { itemId: "checkpoint" });
  for (const settings of [draft.inheritedPermissions, null, undefined]) {
    assert.deepEqual(permissionPresentation(settings), {
      permissionLabel: null,
    });
  }
});

test("App captures permissions in the boundary read and passes display-only props", () => {
  const app = readFileSync(
    new URL("../src/renderer/src/App.tsx", import.meta.url),
    "utf8",
  );
  const open = app.slice(
    app.indexOf("  const createSideChatDraft ="),
    app.indexOf("  const revealSideChat ="),
  );
  assert.match(open, /itemId: lastItem.id/u);
  assert.match(
    open,
    /inheritedPermissions: \{\s*permissionMode: thread.sandbox,\s*approvalPolicy: nativeSettingsSnapshot\(thread\).approvalPolicy,/u,
  );
  const render = app.slice(
    app.indexOf("  const renderSideChatDraft ="),
    app.indexOf("  const renderSideChatDraft =") + 9000,
  );
  assert.match(
    render,
    /\{\.\.\.permissionPresentation\(draft.inheritedPermissions\)\}/u,
  );
  assert.match(render, /permissionDisplayOnly/u);
  assert.doesNotMatch(render.split("onSubmit=")[0], /onPermissionChange=/u);
});

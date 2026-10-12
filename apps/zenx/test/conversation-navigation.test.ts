import assert from "node:assert/strict";
import test from "node:test";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import {
  projectConversationLocators,
  readProjectConversationNavigation,
  agentSessionNavigationId,
} from "../src/main/conversation-navigation.js";
import {
  deriveConversationInboxSections,
  deriveProjectGroups,
} from "../src/renderer/src/thread-list.js";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { AgentSessionBinding } from "../src/main/agent-providers/types.js";

const binding: AgentSessionBinding = {
  id: "same-id",
  hostId: "host-one",
  providerInstanceId: "codex-one",
  nativeSessionId: "native-original",
  cwd: "C:\\Work\\Alias",
};
const zen: NativeThreadSummary = {
  threadId: "same-id",
  name: "Zen conversation",
  preview: "",
  status: "idle",
  createdAt: "2026-10-04T10:00:00Z",
  updatedAt: "2026-10-04T10:00:00Z",
  archived: false,
  currentMetadata: {
    sandbox: "workspace-write",
    approvalPolicy: "always",
    cwd: "C:\\Work\\Project",
    model: "fake",
    provider: "fake",
  },
};

test("mixed engines use the Host canonical Project projection without changing native locators", async () => {
  const projection = new ZenXProjectProjection(
    "win32",
    async () => "C:\\Work\\Project",
  );
  await projection.updateConfiguration(
    ["C:\\Work\\Project"],
    "C:\\Work\\Project",
  );
  const snapshot = await projection.project(
    projectConversationLocators([zen], [binding]),
  );
  assert.equal(snapshot.projects.length, 1);
  assert.deepEqual(snapshot.projects[0]?.threadIds, [
    "same-id",
    agentSessionNavigationId(binding.id),
  ]);
  assert.equal(binding.cwd, "C:\\Work\\Alias");
  assert.equal(binding.nativeSessionId, "native-original");

  const groups = deriveProjectGroups([zen], snapshot, undefined, [
    { binding, title: "Native conversation", providerLabel: "Codex work" },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0]?.rows.map((row) => row.kind),
    ["zen", "agent"],
  );
  assert.equal(groups[0]?.rows[1]?.id, "agent:same-id");
  assert.equal(
    groups[0]?.threads.length,
    1,
    "native sessions are never forged into Zen summaries",
  );
});

test("renderer follows exact projected ownership, including aliases and unknown native titles", () => {
  const snapshot = {
    projects: [
      {
        key: "canonical-owner",
        workspace: "/owner",
        configured: true,
        isDefault: false,
        threadIds: ["agent:same-id"],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };
  const groups = deriveProjectGroups([], snapshot, undefined, [
    { binding, providerLabel: "Codex work" },
  ]);
  assert.equal(groups[0]?.key, "canonical-owner");
  assert.equal(groups[0]?.rows.length, 1);
  assert.equal(groups[0]?.rows[0]?.kind, "agent");
  assert.equal(groups[0]?.workspace, "/owner");
  assert.equal(groups[0]?.threads.length, 0);
});

test("one unavailable engine cannot hide the other engine’s Project navigation", async () => {
  const projection = new ZenXProjectProjection("win32");
  await projection.updateConfiguration(["C:\\Work\\Project"], null);
  const nativeUnavailable = await readProjectConversationNavigation(
    projection,
    async () => [zen],
    async () => {
      throw new Error("Native catalog unavailable");
    },
  );
  assert.deepEqual(nativeUnavailable.projects[0]?.threadIds, [zen.threadId]);
  assert.equal(
    nativeUnavailable.sourceErrors?.agent,
    "Native catalog unavailable",
  );
  const zenUnavailable = await readProjectConversationNavigation(
    projection,
    async () => {
      throw new Error("Zen disconnected");
    },
    async () => [binding],
  );
  assert.ok(
    zenUnavailable.projects.some((project) =>
      project.threadIds.includes("agent:same-id"),
    ),
  );
  assert.equal(zenUnavailable.sourceErrors?.zen, "Zen disconnected");
});

test("mixed Inbox uses native observed status and never calls unread sessions completed", () => {
  const sections = deriveConversationInboxSections(
    [zen],
    [
      { binding, providerLabel: "Codex work" },
      {
        binding: { ...binding, id: "running" },
        providerLabel: "OpenCode",
        status: "active",
      },
    ],
    new Set(),
    new Set(),
  );
  assert.deepEqual(
    sections
      .find((section) => section.key === "active")
      ?.rows.map((row) => row.id),
    ["agent:running"],
  );
  assert.deepEqual(
    sections
      .find((section) => section.key === "settled")
      ?.rows.map((row) => row.id),
    ["same-id"],
  );
  assert.deepEqual(
    sections
      .find((section) => section.key === "unobserved")
      ?.rows.map((row) => row.id),
    ["agent:same-id"],
  );
});

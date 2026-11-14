import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { EditableInformationPanel } from "../src/renderer/src/EditableInformationPanel.js";
import { PluginInformationHost } from "../src/renderer/src/plugin-information-host.js";
import { createPluginUiRegistry } from "../src/renderer/src/plugin-ui-host.js";
import { registerSubagentsUi } from "../src/renderer/src/subagents-ui.js";
import { registerBoardUi } from "../src/renderer/src/board-ui.js";
import {
  applyInformationOperations,
  bindInformationEdits,
  defaultInformationLayout,
} from "../src/information-layout.js";
import type { NativeInformationApi } from "../src/native-information.js";
import type { SidebarOwner } from "../src/thread-sidebar-state.js";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { BoardSnapshot } from "../../../packages/zenx-board-plugin/src/board.js";
import { workspaceLauncherSnapshot } from "../test/workspace-launcher-snapshot.js";
import { i18n } from "../src/renderer/src/i18n.js";
import "../src/renderer/src/shell-thread-panel.css";
import "../src/renderer/src/subagents.css";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = query.get("theme") ?? "light";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "linux";
void i18n.changeLanguage(query.get("lang") === "zh" ? "zh-CN" : "en");
const registry = createPluginUiRegistry();
registerBoardUi(registry);
registerSubagentsUi(registry);
let scene = query.get("scene") ?? "populated";
const lineageThreads: NativeThreadSummary[] = [
  {
    threadId: "synthetic-long-active",
    name: "Review the main conversation, pending messages and source navigation without losing the current draft",
    status: "active",
    archived: false,
  },
  {
    threadId: "synthetic-long-archived",
    name: "已完成的资料卡检查：核对长中文会话名称、来源入口与键盘导航，保留原始验收记录",
    status: "idle",
    archived: true,
  },
].map((entry) => ({
  ...entry,
  status: entry.status as "active" | "idle",
  parentThreadId: "synthetic-thread",
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  preview: "",
  currentMetadata: {
    cwd: "/synthetic/workspace",
    provider: "synthetic",
    model: "synthetic",
    sandbox: "workspace-write",
    approvalPolicy: "always",
  },
}));
const navigation: string[] = [];
const triggerFacts = [
  {
    id: "synthetic-timer",
    threadId: "synthetic-thread",
    kind: "timer",
    active: true,
    label: "Daily project review",
    definitionRevision: 1,
  },
  {
    id: "synthetic-paused",
    threadId: "synthetic-thread",
    kind: "signal",
    active: false,
    label: "Release signal",
    definitionRevision: 1,
  },
];
const triggerUpdates: {
  command: string;
  triggerId: string;
  active: boolean;
}[] = [];
const snapshot = {
  ...workspaceLauncherSnapshot,
  plugins: [
    ...workspaceLauncherSnapshot.plugins.map((entry) => ({
      ...entry,
      admissionId: "synthetic-preview",
    })),
    {
      id: "zenx-board",
      displayName: "Board",
      version: "1.0.0",
      source: "bundled" as const,
      lifecycle: "enabled" as const,
      enabled: true,
      available: true,
      admissionId: "synthetic-preview",
      contributionCount: 1,
    },
  ],
  bundles: [
    ...workspaceLauncherSnapshot.bundles,
    {
      key: "zenx-board:main",
      pluginId: "zenx-board",
      id: "main",
      apiVersion: 1 as const,
      kind: "trusted" as const,
      entry: "zenx/bundled/board-ui",
    },
  ],
  surfaces: [
    ...workspaceLauncherSnapshot.surfaces,
    {
      key: "zenx-board:board",
      pluginId: "zenx-board",
      id: "board",
      bundleId: "main",
      exportName: "board",
    },
  ],
  information: [
    {
      key: "zenx-board:information",
      pluginId: "zenx-board",
      id: "information",
      title: "Board",
      surfaceId: "board",
      order: 0,
    },
  ],
  commands: [
    {
      key: "zenx-triggers:sidebar-facts",
      pluginId: "zenx-triggers",
      id: "sidebar-facts",
      title: "Facts",
      tool: "zenx_triggers_sidebar_facts",
    },
    {
      key: "zenx-board:ui",
      pluginId: "zenx-board",
      id: "ui",
      title: "Board UI",
      tool: "zenx_board_ui",
    },
  ],
};
const owner: SidebarOwner =
  query.get("owner") === "empty-room"
    ? { kind: "room", id: "synthetic-room" }
    : { kind: "thread", id: "synthetic-thread" };
let layout = defaultInformationLayout(owner);
if (owner.kind === "thread")
  layout = applyInformationOperations(layout, {
    operations: bindInformationEdits(
      {
        operations: [
          {
            op: "add",
            type: "board",
            config: { instanceKey: "board:secondary" },
          },
        ],
      },
      {
        owner,
        callerThreadId: owner.id,
        current: layout,
        defaults: layout,
        newId: () => "synthetic-second-board",
      },
    ),
  });
let revision = 0,
  updates = 0,
  conflictNext = false;
const bodies = new Map<string, BoardSnapshot>();
for (const [address, title, value] of [
  ["default", "Implementation plan", "Interface review"],
  ["board:secondary", "Acceptance notes", "Independent draft"],
])
  bodies.set(address!, {
    ...(address === "default" ? {} : { instanceKey: address }),
    revision: 1,
    draftRevision: 0,
    pinned: false,
    values: { topic: value! },
    document: {
      id: "same-authored-id",
      title: title!,
      summary:
        "Synthetic Board body. Same authored ID and revision, separate address.",
      owner: { kind: "thread", threadId: "synthetic-thread" },
      blocks: [
        {
          id: "note",
          kind: "note",
          text:
            address === "default"
              ? "Keep provider facts and editable documents in one place."
              : "This document has its own fields and interaction scope.",
        },
        { id: "topic", kind: "field", field: "topic", label: "Next step" },
      ],
      events: [],
    },
  });
const read = () => ({
  owner,
  revision,
  basis: "synthetic",
  layout: structuredClone(layout),
  members: [],
  ...(owner.kind === "thread" ? { resourceThreadId: owner.id } : {}),
});
const information: NativeInformationApi = {
  read: async () => read(),
  update: async (input) => {
    updates++;
    if (conflictNext) {
      conflictNext = false;
      revision++;
    }
    if (input.expectedRevision !== revision)
      return { applied: false, ...read() };
    layout = applyInformationOperations(layout, {
      operations: bindInformationEdits(
        { operations: input.operations },
        {
          owner,
          callerThreadId: owner.kind === "thread" ? owner.id : "",
          current: layout,
          defaults: defaultInformationLayout(owner),
          newId: () => `synthetic-${crypto.randomUUID()}`,
        },
      ),
    });
    revision++;
    return { applied: true, ...read() };
  },
};
(window as any).zenx = {
  information,
  threadSidebar: { onChanged: () => () => {} },
  plugins: {
    readHandle: async () => null,
    executeCommand: async (pluginId: string, command: string, input?: any) => {
      if (pluginId === "zenx-subagents" && command === "list")
        return { threads: scene === "lineage" ? lineageThreads : [] };
      if (pluginId === "zenx-triggers" && command === "sidebar-facts")
        return {
          triggers: ["empty", "lineage"].includes(scene)
            ? []
            : structuredClone(triggerFacts),
        };
      if (
        pluginId === "zenx-triggers" &&
        ["cancel", "resume"].includes(command)
      ) {
        const fact = triggerFacts.find(
          (entry) => entry.id === input?.triggerId,
        );
        if (!fact) throw Error("Unknown synthetic trigger");
        if (
          command === "resume" &&
          input.expectedRevision !== fact.definitionRevision
        )
          throw Error("Synthetic trigger revision conflict");
        fact.active = command === "resume";
        fact.definitionRevision++;
        triggerUpdates.push({
          command,
          triggerId: fact.id,
          active: fact.active,
        });
        return { ok: true };
      }
      if (pluginId !== "zenx-board" || command !== "ui")
        throw Error("No real Host access in synthetic preview");
      const key = input.instanceKey ?? "default";
      const current = bodies.get(key);
      if (input.operation === "read")
        return input.owner?.kind === "room" || scene !== "populated"
          ? null
          : current
            ? structuredClone(current)
            : null;
      if (input.operation === "draft" && current) {
        if (input.expectedDraftRevision !== current.draftRevision)
          throw Error("Synthetic draft conflict");
        current.values = { ...current.values, ...input.values };
        current.draftRevision++;
        return structuredClone(current);
      }
      throw Error("No external actions in synthetic preview");
    },
  },
  shellPanel: {
    request: async () => ({
      host: "local",
      sessions: [],
      cwd: "/synthetic",
      canCreate: false,
    }),
  },
};
(window as any).__informationFixture = {
  navigationToken: query.get("capture"),
  triggerUpdates: () => structuredClone(triggerUpdates),
  navigation: () => [...navigation],
  read,
  bodies: () => [...bodies],
  updates: () => updates,
  setScene: (next: string) => {
    scene = next;
    window.dispatchEvent(new Event("focus"));
  },
  conflict: () => {
    conflictNext = true;
  },
};
function Fixture() {
  const [question, setQuestion] = useState(query.get("question") !== "0");
  const conversation =
    owner.kind === "thread"
      ? { kind: "thread" as const, threadId: owner.id }
      : { kind: "room" as const, roomId: owner.id };
  return (
    <div
      className="app-shell"
      style={{
        display: "grid",
        gridTemplateColumns: `${query.get("narrow") === "1" ? "500px" : "220px"} minmax(0,1fr)`,
        height: "100vh",
      }}
    >
      <aside
        style={{
          padding: 22,
          borderRight: "1px solid var(--color-border-subtle)",
          fontSize: 12,
        }}
      >
        <strong>ZENX</strong>
        <p>Synthetic acceptance preview</p>
        <p>
          Actual production information panel, Board and popup components.
          In-memory synthetic ports, no real Host, account, model or external
          writes.
        </p>
        <p>
          Thread / Room ownership and native admission are tested separately.
        </p>
        <button
          onClick={() => {
            conflictNext = true;
          }}
        >
          Simulate concurrent edit
        </button>
        <button onClick={() => setQuestion((value) => !value)}>
          Toggle synthetic question
        </button>
      </aside>
      <main
        className="workspace"
        style={{ position: "relative", minWidth: 0, height: "100%" }}
      >
        <div
          className="agent-surface"
          style={{
            padding: "76px 36px",
            height: "100%",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ maxWidth: 620 }}>
            <h2>Editable conversation information</h2>
            <p
              style={{ lineHeight: 1.7, color: "var(--color-text-secondary)" }}
            >
              The conversation keeps its place. Customize the panel, show or
              hide provider cards, and keep multiple independently editable
              Boards.
            </p>
            <p style={{ lineHeight: 1.7, color: "var(--color-text-muted)" }}>
              Empty and unavailable cards stay hidden. New content appears
              automatically; Manage keeps saved placement controls available.
            </p>
          </div>
          <div style={{ marginTop: "auto" }}>
            <textarea
              id="composer-draft"
              defaultValue="My unsent conversation draft stays here."
              style={{
                width: "100%",
                minHeight: 90,
                padding: 15,
                border: "1px solid var(--color-border-subtle)",
                borderRadius: 14,
                color: "var(--color-text-primary)",
                background: "var(--color-surface)",
              }}
            />
          </div>
        </div>
        <PluginInformationHost
          managedBoard
          snapshot={snapshot}
          registry={registry}
          owner={conversation}
          theme={query.get("theme") === "dark" ? "dark" : "light"}
          navigate={(route) => navigation.push(route)}
          executeCommand={(window as any).zenx.plugins.executeCommand}
          readHandle={async () => null}
          contextContent={
            <EditableInformationPanel
              owner={conversation}
              threads={[]}
              snapshot={snapshot}
              registry={registry}
              theme={query.get("theme") === "dark" ? "dark" : "light"}
              navigate={(route) => navigation.push(route)}
              attention={
                question ? (
                  <section
                    style={{
                      padding: 10,
                      border: "1px solid var(--color-border-subtle)",
                      borderRadius: 9,
                    }}
                  >
                    <strong style={{ fontSize: 12 }}>
                      Waiting for your answer
                    </strong>
                    <p>
                      This separate synthetic Asking card remains outside
                      customization.
                    </p>
                    <button type="button" onClick={() => setQuestion(false)}>
                      Answer later
                    </button>
                  </section>
                ) : undefined
              }
            />
          }
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

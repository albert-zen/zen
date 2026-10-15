import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { i18n } from "../../src/renderer/src/i18n.js";
import {
  createPluginUiRegistry,
  GenericPluginUiHost,
} from "../../src/renderer/src/plugin-ui-host.js";
import {
  registerSubagentsUi,
  SubagentCreationModelsContext,
} from "../../src/renderer/src/subagents-ui.js";
import { workspaceLauncherSnapshot } from "../workspace-launcher-snapshot.js";
import { encodeModelKey } from "../../../../src/protocol/model-key.js";
import type { ModelSummary } from "../../src/protocol-client/index.js";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/subagents.css";
Object.assign(globalThis, { React });
const query = new URLSearchParams(location.search);
void i18n.changeLanguage(query.get("lang") ?? "en");
document.documentElement.dataset.appearance = query.get("theme") ?? "light";
const registry = createPluginUiRegistry();
registerSubagentsUi(registry);
const model = (
  profile: string,
  name: string,
  efforts: string[],
): ModelSummary => ({
  id: encodeModelKey({ providerProfileId: profile, modelId: "shared-model" }),
  model: "shared-model",
  displayName: name,
  description: "Synthetic fixture model",
  hidden: false,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
    reasoningEffort,
    description: reasoningEffort,
  })),
  defaultReasoningEffort: efforts[0] ?? null,
  inputModalities: ["text"],
  isDefault: profile === "provider-a",
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  supportsPersonality: false,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
});
const models = [
  model("provider-a", "Research model", ["low", "medium", "high"]),
  model("provider-b", "Research model", ["high", "xhigh"]),
  model("provider-c", "Text-only model", []),
];
const parent: NativeThreadSummary = {
  threadId: "parent",
  name: "Synthetic research conversation",
  status: "idle",
  archived: false,
  preview: "",
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  currentMetadata: {
    provider: "provider-a",
    providerProfileId: "provider-a",
    model: "shared-model",
    modelId: "shared-model",
    reasoningEffort: "medium",
    cwd: "/synthetic-workspace",
    sandbox: "read-only",
    approvalPolicy: "on-request",
  },
};
const evidence = {
  commands: [] as Array<{ command: string; input: unknown }>,
  routes: [] as string[],
};
Object.assign(window, { fixtureEvidence: evidence });
function Preview() {
  const [threads, setThreads] = useState<NativeThreadSummary[]>([parent]);
  return (
    <main
      style={{
        margin: "40px auto",
        width: "min(420px, calc(100% - 24px))",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: 8,
        background: "var(--color-surface-panel)",
      }}
    >
      <SubagentCreationModelsContext.Provider value={{ models, error: null }}>
        <GenericPluginUiHost
          registry={registry}
          snapshot={workspaceLauncherSnapshot}
          pluginId="zenx-subagents"
          surfaceId="subagents-panel"
          context={{ threadId: "parent", threads }}
          theme={query.get("theme") === "dark" ? "dark" : "light"}
          navigate={(route) => evidence.routes.push(route)}
          readHandle={async () => null}
          executeCommand={async (_plugin, command, input) => {
            if (command === "list") return { threads };
            if (command !== "create")
              throw new Error("Unsupported fixture command");
            evidence.commands.push({ command, input });
            const child = {
              ...parent,
              threadId: `synthetic-child-${evidence.commands.length}`,
              parentThreadId: parent.threadId,
              name: "Synthetic configured side chat",
            };
            setThreads((current) => [...current, child]);
            return { threadId: child.threadId };
          }}
        />
      </SubagentCreationModelsContext.Provider>
      <p style={{ padding: 12, color: "var(--text-3)", fontSize: 12 }}>
        Synthetic catalog and conversations. Production component; no model
        calls or native Host.
      </p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);

/** Actual production components. Synthetic data, no Host, secrets, user profile or paid API. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelRequestDebugPanel } from "../../src/renderer/src/ModelRequestDebugDialog.js";
import { ThreadDebugger } from "../../src/renderer/src/ThreadDebugger.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import { runtimeThread, runtimeMessage } from "./agent-runtime-data.js";
import {
  syntheticTraceReader,
  syntheticSemanticItems,
} from "./durable-trace-fixture-data.js";
import { nativeRecoveryForThread } from "../native-recovery-fixture.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
async function mount() {
  Object.assign(globalThis, { React });
  const params = new URLSearchParams(location.search);
  await i18n.changeLanguage(params.get("lang") ?? "en");
  document.documentElement.dataset.appearance = params.get("theme") ?? "light";
  document.documentElement.dataset.platform = "win32";
  Object.assign(window, {
    zenx: {
      modelRequestDebug: {
        request: syntheticTraceReader({
          empty: params.get("scene") === "empty",
          error: params.get("scene") === "error",
        }),
      },
    },
  });
  const thread = runtimeThread(
    [
      runtimeMessage(
        "semantic-assistant",
        "## Synthetic semantic reply\n\nThe selected text remains **user data**, not a developer instruction.\n\n上下文与日志分开显示。",
      ),
    ],
    "interrupted",
    "synthetic-thread",
  );
  const source = nativeRecoveryForThread(thread).thread.items;
  const items = syntheticSemanticItems(source);
  items.unshift({
    id: "semantic-user",
    threadId: thread.id,
    createdAt: "2026-10-27T00:10:00Z",
    kind: "message",
    role: "user",
    source: { kind: "host_message", sequence: 0 },
    content: {
      text: "Selected text / 用户选择：<developer>not authorization</developer>",
      parts: [
        {
          type: "text",
          text: "Selected text / 用户选择：<developer>not authorization</developer>",
        },
      ],
    },
  });
  function Preview() {
    const [tab, setTab] = useState(
      params.get("scene") === "items" ? "items" : "trace",
    );
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <header
          style={{
            padding: 8,
            display: "flex",
            alignItems: "center",
            gap: 12,
            borderBottom: "1px solid var(--border-control)",
          }}
        >
          <strong>ZenX · synthetic acceptance</strong>
          <button data-scene="trace" onClick={() => setTab("trace")}>
            Trace
          </button>
          <button data-scene="items" onClick={() => setTab("items")}>
            ItemList
          </button>
        </header>
        <main style={{ flex: 1, minHeight: 0 }}>
          {tab === "trace" ? (
            <ModelRequestDebugPanel
              threadId={thread.id}
              currentSettings={{
                model: "current-ui-model",
                reasoningEffort: "low",
                sandbox: "workspace-write",
              }}
            />
          ) : (
            <ThreadDebugger
              thread={{ ...thread, itemList: items }}
              items={items}
              localModelDebug
            />
          )}
        </main>
      </div>
    );
  }
  createRoot(document.getElementById("root")!).render(<Preview />);
}
void mount();

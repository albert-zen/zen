/** Synthetic local observations; production status, sidebar and Terminal components. */
import React, { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { BackgroundShellStatus } from "../../src/renderer/src/BackgroundShellStatus.js";
import { AuxiliaryPanel } from "../../src/renderer/src/auxiliary-panel.js";
import {
  ShellTargetNavigationContext,
  openShellTarget,
  type ShellTargetRequest,
} from "../../src/renderer/src/shell-target-navigation.js";
import { ThreadSidebarController } from "../../src/renderer/src/thread-sidebar-controller.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { ShellSessionSummary } from "../../../../src/shell-session.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/shell-thread-panel.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh-CN");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const owner = { kind: "thread" as const, id: "synthetic-source" };
const command = (taskId: string, command: string): ShellSessionSummary => ({
  taskId,
  threadId: owner.id,
  command,
  origin: "agent",
  kind: "command",
  cwd: "/synthetic/workspace",
  createdAt: "2026-10-29T00:00:00Z",
  status: "running",
  exitCode: null,
  inputAvailable: false,
  retained: false,
  lifecycle: { foreground: "running", stdio: "open" },
});
let sessions = [
  command("synthetic-test", "npm run test:prepared --workspace @zen/zenx"),
  command("synthetic-build", "npm run build:prepared --workspace @zen/zenx"),
];
let readError = false;
const requests: unknown[] = [];
const api = {
  async request(input: any): Promise<any> {
    requests.push(input);
    if (!["list", "read"].includes(input.operation))
      throw new Error("Synthetic preview allows observation only");
    if (readError)
      throw new Error(
        "Synthetic Host observation transport unavailable. No command was retried.",
      );
    if (input.operation === "list")
      return {
        sessions: input.threadId === owner.id ? sessions : [],
        cwd: "/synthetic/workspace",
        host: "local",
        canCreate: false,
      };
    const session = sessions.find(
      (entry) =>
        entry.taskId === input.taskId && entry.threadId === input.threadId,
    );
    if (!session) throw new Error("Synthetic exact session is unavailable");
    const output = `${session.command}\r\nSynthetic local output: exact session ${session.taskId}\r\n`;
    return {
      session,
      output: input.cursor ? "" : output,
      cursor: output.length,
      truncated: false,
    };
  },
};
(window as any).zenx = { shellPanel: api };
const sidebar = new ThreadSidebarController();
let selectThread!: (threadId: string) => void;
(window as any).__backgroundShellPreview = {
  requests,
  finish() {
    sessions = sessions.map((session) => ({
      ...session,
      status: "completed",
      exitCode: 0,
    }));
  },
  failRead() {
    readError = true;
  },
  restoreRead() {
    readError = false;
  },
  selectFork() {
    selectThread("synthetic-fork");
  },
  selectSource() {
    selectThread(owner.id);
  },
  setTheme(theme: string) {
    document.documentElement.dataset.appearance = theme;
  },
};
function Preview() {
  const states = useSyncExternalStore(sidebar.subscribe, sidebar.snapshot);
  const state = states["thread:synthetic-source"];
  const [target, setTarget] = useState<ShellTargetRequest | null>(null);
  const [threadId, setThreadId] = useState(owner.id);
  selectThread = setThreadId;
  return (
    <ShellTargetNavigationContext.Provider
      value={{
        request: target,
        consumed: (id) =>
          setTarget((current) => (current?.requestId === id ? null : current)),
        open: async (target, source) => {
          if (
            await openShellTarget({
              target,
              owner,
              api,
              sidebar,
              isCurrent: source.isCurrent,
            })
          )
            setTarget({
              ...target,
              ownerKey: "thread:synthetic-source",
              requestId: Date.now(),
            });
        },
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          minHeight: 0,
        }}
      >
        <aside
          aria-label="Synthetic fixture controls"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            padding: 10,
            borderBottom: "1px solid var(--border)",
            background: "var(--color-surface-control)",
            fontSize: 12,
          }}
        >
          <strong>Synthetic controls</strong>
          <button
            onClick={() => (window as any).__backgroundShellPreview.finish()}
          >
            Finish commands
          </button>
          <button
            onClick={() => (window as any).__backgroundShellPreview.failRead()}
          >
            Fail status read
          </button>
          <button
            onClick={() =>
              (window as any).__backgroundShellPreview.restoreRead()
            }
          >
            Restore status read
          </button>
          <button
            onClick={() =>
              (window as any).__backgroundShellPreview.selectFork()
            }
          >
            Show fork
          </button>
          <button
            onClick={() =>
              (window as any).__backgroundShellPreview.selectSource()
            }
          >
            Show source
          </button>
          <button
            onClick={() =>
              (window as any).__backgroundShellPreview.setTheme("light")
            }
          >
            Light
          </button>
          <button
            onClick={() =>
              (window as any).__backgroundShellPreview.setTheme("dark")
            }
          >
            Dark
          </button>
          <button onClick={() => void i18n.changeLanguage("en")}>
            English
          </button>
          <button onClick={() => void i18n.changeLanguage("zh-CN")}>
            中文
          </button>
          <button onClick={() => location.reload()}>Reset fixture</button>
        </aside>
        <div
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            background: "var(--color-bg)",
          }}
        >
          <main
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minWidth: 0,
              padding: "28px 24px 20px",
              gap: 20,
            }}
          >
            <header
              style={{
                borderBottom: "1px solid var(--border)",
                paddingBottom: 12,
              }}
            >
              <strong>后台命令 · Background commands</strong>
              <p style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                Synthetic data · production components · no model / Host
                execution
              </p>
            </header>
            <div style={{ flex: 1 }}>
              <p>对话已结束。命令的实际运行状态独立更新。</p>
              <p style={{ color: "var(--color-text-muted)" }}>
                The conversation has ended. The two observed commands continue
                independently.
              </p>
            </div>
            <div>
              <BackgroundShellStatus key={threadId} threadId={threadId} />
              <div
                className="composer"
                style={{
                  minHeight: 110,
                  border: "1px solid var(--border)",
                  borderRadius: 20,
                  padding: 18,
                  color: "var(--color-text-muted)",
                }}
              >
                Message…
              </div>
            </div>
          </main>
          {threadId === owner.id ? (
            <AuxiliaryPanel
              threadId={owner.id}
              title="Synthetic source"
              open={state?.open ?? false}
              onOpenChange={(open) =>
                void sidebar.edit(owner, () => ({ open }))
              }
              snapshot={null}
              presentationState={state}
              selectedTab={state?.selectedTab ?? undefined}
              onSelectTab={(id) => void sidebar.select(owner, id)}
              openedTabs={state?.tabs.map((tab) => tab.kind)}
              onTabsChange={() => {}}
            />
          ) : null}
        </div>
      </div>
    </ShellTargetNavigationContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);

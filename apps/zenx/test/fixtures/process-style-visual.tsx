/** Synthetic, read-only scene. All process rows are production components. */
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { Thread, ThreadItem } from "../../src/protocol-client/index.js";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import {
  runtimeApproval,
  runtimeCommand,
  runtimeMessage,
  runtimeTask,
  runtimeThread,
  runtimeWait,
  confirmedStopped,
} from "./agent-runtime-data.js";
import { recoveryScenario } from "./loop-recovery-scenario.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh-CN");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const startedAt = Math.floor(Date.now() / 1000) - 164;
export const scenes = [
  "thinking",
  "thinking-short",
  "thinking-empty",
  "command-long",
  "command-short",
  "waiting",
  "running",
  "parallel",
  "approval",
  "stopping",
  "stopped",
  "failed",
  "recovery",
  "completed",
] as const;
type Scene = (typeof scenes)[number];
// Deliberately synthetic public item.content, never hidden model reasoning.
const publicReasoning = {
  long: "Synthetic public reasoning: first inspect the existing trace component and preserve its disclosure identity. Then compare the shared icon-and-text sweep in light and dark appearances. Check that a narrow window keeps the command on one line, fades only overflowing text, and leaves the full command available in its details. Finally verify that each new public streaming update reaches the visible excerpt without resetting keyboard focus or the expanded row.",
  short: "Check spacing.",
};
const commands = {
  long: "cd /synthetic/workspace-demo && npm run check --workspace @zen/zenx && node scripts/verify-process-preview.mjs --component ActivityText --reasoning public-item-content --command full-original-command --themes light,dark --widths 420,1280 --motion default,reduced --verify-icon-and-text-pixels --preserve-expanded-disclosure",
  short: "pwd",
};
const streamChunks = [
  " The latest public update checks icon contrast beside the Thinking label.",
  " The next public update verifies the full command and the 48px trailing fade.",
  " Final public update: narrow-layout checks preserve this same expanded disclosure.",
];
const intro: ThreadItem[] = [
  {
    type: "userMessage",
    id: "user",
    clientId: null,
    content: [
      {
        type: "text",
        text: "检查过程 UI 的样式与交互，保留现有执行逻辑。",
        text_elements: [],
      },
    ],
  },
  {
    ...runtimeMessage("commentary", "我会先查看现有实现，再核对样式和交互。"),
  },
];
function scenario(scene: Scene): Thread {
  const prior = runtimeCommand(
    "prior",
    "cd /synthetic/workspace-demo && sed -n '1,180p' apps/zenx/src/renderer/src/ThreadView.tsx",
  );
  const base = [...intro, prior];
  let thread: Thread;
  if (scene === "recovery") return recoveryScenario("recovering");
  if (scene.startsWith("thinking"))
    thread = runtimeThread([
      ...base,
      {
        type: "reasoning",
        id: "thinking",
        status: "inProgress",
        summary:
          scene === "thinking-empty"
            ? []
            : ["Synthetic summary, not the live excerpt"],
        content:
          scene === "thinking-empty"
            ? []
            : [
                scene === "thinking-short"
                  ? publicReasoning.short
                  : publicReasoning.long,
              ],
      },
    ]);
  else if (scene === "command-long" || scene === "command-short")
    thread = runtimeThread([
      ...base,
      {
        ...runtimeTask("operation", "task-one", "running"),
        command: scene === "command-long" ? commands.long : commands.short,
        toolName: "run_code",
        toolArguments: {
          code: scene === "command-long" ? commands.long : commands.short,
          description:
            "Synthetic friendly title must not replace the actual command",
        },
      },
    ]);
  else if (scene === "waiting")
    thread = runtimeThread([...base, runtimeWait("wait", "task-one")]);
  else if (scene === "running")
    thread = runtimeThread([
      ...base,
      runtimeTask("operation", "task-one", "running"),
    ]);
  else if (scene === "parallel")
    thread = runtimeThread([
      ...base,
      runtimeTask("operation", "task-one", "running"),
      {
        ...runtimeCommand("browser", "browser_inspect", "inProgress"),
        toolName: "browser_inspect",
        toolArguments: { tabId: "synthetic-preview" },
      },
    ]);
  else if (scene === "approval")
    thread = runtimeThread([
      ...intro,
      {
        ...runtimeCommand("approval-call", "run_code", "inProgress"),
        toolName: "run_code",
        toolArguments: runtimeApproval.params.toolArguments,
      },
    ]);
  else if (scene === "stopping")
    thread = runtimeThread([
      ...base,
      runtimeTask("operation", "task-one", "cancel_requested", "declined"),
    ]);
  else if (scene === "stopped")
    thread = confirmedStopped([
      ...base,
      runtimeTask("operation", "task-one", "cancelled", "declined"),
    ]);
  else if (scene === "failed")
    thread = runtimeThread(
      [
        ...base,
        runtimeCommand(
          "operation",
          "npm run check --workspace @zen/zenx",
          "failed",
        ),
      ],
      "failed",
    );
  else
    thread = runtimeThread(
      [
        ...base,
        runtimeMessage("answer", "检查完成。这里是合成回放，不连接真实 Host。"),
      ],
      "completed",
    );
  return {
    ...thread,
    name: "过程样式检查",
    cwd: "/synthetic/workspace-demo",
    turns: thread.turns.map((turn) => ({
      ...turn,
      startedAt,
      durationMs: turn.status === "inProgress" ? null : 164000,
      completedAt: turn.status === "inProgress" ? null : startedAt + 164,
    })),
  };
}
function complete(thread: Thread): Thread {
  return {
    ...thread,
    status: { type: "idle" },
    turns: thread.turns.map((turn) => ({
      ...turn,
      status: "completed",
      completedAt: startedAt + 164,
      durationMs: 164000,
      items: [
        ...turn.items.map((item) => {
          if (item.type === "reasoning") return { ...item, status: undefined };
          if (item.type !== "commandExecution") return item;
          const structuredContent =
            item.structuredContent && typeof item.structuredContent === "object"
              ? { ...item.structuredContent, status: "completed", exit_code: 0 }
              : item.structuredContent;
          return {
            ...item,
            status: "completed" as const,
            structuredContent,
            exitCode: 0,
          };
        }),
        runtimeMessage("answer", "检查完成。这是合成回放，没有连接真实 Host。"),
      ],
    })),
  };
}
const reject = async () => {
  throw new Error("Read-only synthetic preview: no Host action is allowed.");
};
Object.assign(window, {
  zenx: {
    triggers: { list: async () => [] },
    plugins: { executeCommand: reject },
  },
});
function Fixture() {
  const [scene, setScene] = useState<Scene>(
    scenes.includes(params.get("scene") as Scene)
      ? (params.get("scene") as Scene)
      : "thinking",
  );
  const [thread, setThread] = useState(() => scenario(scene));
  const [narrow, setNarrow] = useState(innerWidth < 700);
  const threadRef = useRef(thread);
  const streamIndex = useRef(0);
  threadRef.current = thread;
  const updateReasoning = (text: string, append: boolean) => {
    setThread((current) => ({
      ...current,
      turns: current.turns.map((turn) => ({
        ...turn,
        items: turn.items.map((item) =>
          item.type === "reasoning" && item.id === "thinking"
            ? {
                ...item,
                content: [append ? item.content.join("\n") + text : text],
              }
            : item,
        ),
      })),
    }));
  };
  useEffect(() => {
    const resize = () => setNarrow(innerWidth < 700);
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    Object.assign(window, {
      __processStylePreview: {
        scenes,
        samples: { publicReasoning, commands, streamChunks },
        snapshot() {
          const current = threadRef.current;
          return { scene, thread: current };
        },
        appendReasoning(text: string) {
          updateReasoning(text, true);
        },
        setReasoning(text: string) {
          updateReasoning(text, false);
        },
        streamStep() {
          const chunk =
            streamChunks[streamIndex.current++ % streamChunks.length]!;
          updateReasoning(chunk, true);
        },
        setCommand(command: string) {
          setThread((current) => ({
            ...current,
            turns: current.turns.map((turn) => ({
              ...turn,
              items: turn.items.map((item) =>
                item.type === "commandExecution" && item.id === "operation"
                  ? { ...item, command, toolArguments: { code: command } }
                  : item,
              ),
            })),
          }));
        },
        selectScene(value: Scene) {
          if (scenes.includes(value)) {
            streamIndex.current = 0;
            setScene(value);
            setThread(scenario(value));
          }
        },
        finish() {
          setThread((value) => complete(value));
        },
        reset() {
          streamIndex.current = 0;
          setThread(scenario(scene));
        },
        setTheme(value: string) {
          document.documentElement.dataset.appearance =
            value === "dark" ? "dark" : "light";
        },
      },
    });
  }, [scene]);
  const summaries: NativeThreadSummary[] = [
    "过程样式检查",
    "组件与样式",
    "发布检查",
  ].map((title, index) => ({
    threadId: index === 0 ? thread.id : `synthetic-${index}`,
    name: title,
    archived: false,
    preview: title,
    createdAt: "2026-10-20T08:00:00Z",
    updatedAt: "2026-10-20T08:00:00Z",
    status: index === 0 && thread.status.type === "active" ? "active" : "idle",
    currentMetadata: {
      cwd: "/synthetic/workspace-demo",
      provider: "openai",
      model: "synthetic",
      sandbox: "workspace-write",
      approvalPolicy: "always",
    },
  }));
  return (
    <div className={`app-shell${narrow ? " sidebar-collapsed" : ""}`}>
      <header className="window-titlebar">
        <div className="window-titlebar-product">
          <span style={{ paddingLeft: 18, fontWeight: 650 }}>ZenX</span>
        </div>
        <div
          style={{
            paddingInline: 16,
            fontSize: 12,
            color: "var(--color-text-secondary)",
            alignSelf: "center",
          }}
        >
          过程样式检查 · 合成只读预览
        </div>
      </header>
      <Sidebar
        mode="projects"
        open={false}
        collapsed={narrow}
        onClose={() => {}}
        onChangeThreadLifecycle={reject}
        onChangeThreadPinned={reject}
        onNewThread={() => {}}
        onAddProject={() => {}}
        onRemoveProject={() => {}}
        onSetDefaultProject={() => {}}
        onOpenContribution={() => {}}
        onOpenSettings={() => {}}
        onRetryThreads={() => {}}
        onRenameThread={reject}
        onSelectThread={() => {}}
        pendingApprovalThreadIds={new Set()}
        pluginContributions={[]}
        selectedPage="agent"
        selectedThreadId={thread.id}
        serverStatus={{ type: "ready", reconnected: false }}
        liveThread={thread}
        threadError={null}
        threadLoading={false}
        projects={{
          projects: [
            {
              key: "/synthetic/workspace-demo",
              workspace: "/synthetic/workspace-demo",
              name: "workspace-demo",
              configured: true,
              isDefault: true,
              threadIds: summaries.map((value) => value.threadId),
            },
          ],
          unavailableThreadIds: [],
          lastUsedWorkspace: "/synthetic/workspace-demo",
        }}
        pinnedThreads={[]}
        threads={summaries}
      />
      <main className="workspace">
        <section className="agent-surface">
          <ThreadReadingStateProvider>
            <ThreadView
              thread={thread}
              composer={emptyComposerState()}
              approvals={
                scene === "approval" && thread.status.type === "active"
                  ? [runtimeApproval]
                  : []
              }
              composerDisabled
              onDraftChange={() => {}}
              onInterrupt={reject}
              onRetryTurn={reject}
              onRespondToApproval={reject}
              onSubmit={reject}
            />
          </ThreadReadingStateProvider>
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

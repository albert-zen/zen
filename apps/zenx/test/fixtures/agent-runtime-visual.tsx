import React, { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import {
  editComposer,
  emptyComposerState,
} from "../../src/renderer/src/composer-state.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import {
  runtimeApproval,
  runtimeCommand,
  runtimeIntro,
  runtimeMessage,
  runtimeTask,
  runtimeThread,
  runtimeWait,
  confirmedStopped,
} from "./agent-runtime-data.js";
import {
  applyQueueItem,
  cancelQueueFact,
  drainQueueHead,
  editQueueFact,
  queueItem,
  queueScenario,
  queueScenes,
} from "./agent-queue-data.js";
import {
  readQueueFixtureImage,
  queueImageAttachments,
} from "./agent-queue-images.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "zh-CN");
document.documentElement.dataset.appearance = params.get("theme") ?? "dark";
const mode = params.get("mode") ?? "runtime";
const simulatedEditError = params.has("longError")
  ? "模拟保存连接中断。\n" +
    "服务器尚未确认本次修改；编辑草稿与附件仍保留，请检查连接后重试。\n".repeat(
      8,
    )
  : "模拟保存连接中断；编辑草稿仍保留。";
const runtimeScenes = [
  "并行运行",
  "等待结果",
  "审批请求",
  "取消请求中",
  "取消未确认",
  "已停止（部分结果）",
  "已失败",
  "已完成",
  "恢复后的历史",
  "等待与并行运行",
  "动作集合与未知插件",
  "同类调用与嵌套代码",
];
const partial = runtimeMessage(
  "partial-result",
  "已确认两处问题：\n\n1. 长命令的工作目录必须保留。\n2. 队列错误需要与对应消息关联。\n\n键盘流程尚未检查完成，以上是中途保留的结果。",
);
function scenario(scene: number) {
  if (mode === "queue") return queueScenario(scene);
  const browser = {
    ...runtimeCommand("browser", "browser_inspect"),
    toolName: "browser_inspect",
    toolArguments: { tabId: "fixture-page" },
    aggregatedOutput: "Page headings: Agent, Conversation, Composer.",
  };
  const items = [
    ...runtimeIntro,
    runtimeCommand("read-source", "sed -n '1,80p' ThreadView.tsx"),
    browser,
  ];
  if (scene === 1)
    return runtimeThread([...items, runtimeWait("wait", "task-one")]);
  if (scene === 2)
    return runtimeThread([
      ...runtimeIntro,
      {
        ...runtimeCommand("approval-call", "run_code", "inProgress"),
        toolName: "run_code",
        toolArguments: runtimeApproval.params.toolArguments,
      },
    ]);
  if (scene === 3)
    return runtimeThread([
      ...items,
      runtimeTask("cancel", "task-one", "cancel_requested", "declined"),
    ]);
  if (scene === 4)
    return runtimeThread(
      [
        ...items,
        partial,
        runtimeTask(
          "unconfirmed",
          "task-one",
          "cancellation_unconfirmed",
          "declined",
        ),
      ],
      "interrupted",
    );
  if (scene === 5)
    return confirmedStopped([
      ...items,
      partial,
      runtimeTask("stopped", "task-one", "cancelled", "declined"),
    ]);
  if (scene === 6)
    return runtimeThread(
      [...items, partial, runtimeCommand("failed", "npm run check", "failed")],
      "failed",
    );
  if (scene === 7)
    return runtimeThread(
      [
        ...items,
        runtimeMessage(
          "final-answer",
          "检查完成。工具汇总、权限请求与消息队列的交互已整理，以下展示来自组件模拟事件回放。",
        ),
      ],
      "completed",
    );
  if (scene === 8) return runtimeThread([...items, partial], "interrupted");
  if (scene === 9)
    return runtimeThread([
      ...items,
      runtimeWait("wait", "task-one"),
      runtimeTask("parallel", "task-two", "running"),
    ]);
  if (scene === 10)
    return runtimeThread([
      ...runtimeIntro,
      ...["read-one", "read-two", "read-three"].map((id) =>
        runtimeCommand(id, "cat same-synthetic-file.txt"),
      ),
      browser,
      { ...runtimeCommand("image", "view_image"), toolName: "view_image" },
      {
        ...runtimeCommand("plugin", "acme_read_synthetic_record"),
        toolName: "acme_read_synthetic_record",
      },
      runtimeMessage(
        "between-groups",
        "这些是合成调用次数；同一个文件被读取三次，不代表三个文件。",
      ),
      {
        ...runtimeCommand("send", "zenx_threads_send"),
        toolName: "zenx_threads_send",
      },
      {
        ...runtimeCommand("rename", "zenx_threads_rename"),
        toolName: "zenx_threads_rename",
      },
    ]);
  if (scene === 11)
    return runtimeThread([
      ...runtimeIntro,
      {
        ...runtimeCommand("code", "run_code"),
        toolName: "run_code",
        callId: "fixture-parent",
        toolArguments: {
          description: "检查合成数据",
          code: "await tools.shell({ command: 'echo fixture' })",
        },
      },
      {
        ...runtimeCommand("child", "echo fixture", "failed"),
        callId: "fixture-child",
        parentCallId: "fixture-parent",
        exitCode: 1,
      },
      runtimeCommand("command-two", "cat same-synthetic-file.txt"),
      runtimeCommand("command-three", "cat same-synthetic-file.txt"),
    ]);
  return runtimeThread([
    ...items,
    runtimeTask("running", "task-one", "running"),
  ]);
}
type Props = React.ComponentProps<typeof ThreadView>;
function Fixture() {
  const [scene, setScene] = useState(Number(params.get("scene") ?? 0));
  const [thread, setThread] = useState(() => scenario(scene));
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const [approvals, setApprovals] = useState<Props["approvals"]>(
    (mode === "runtime" && scene === 2) || (mode === "queue" && scene === 6)
      ? [runtimeApproval]
      : [],
  );
  const [composer, setComposer] = useState(() =>
    editComposer(
      emptyComposerState(),
      "补充：保留已确认的结果，不要重复运行。",
    ),
  );
  const [permission, setPermission] =
    useState<Props["permissionMode"]>("workspace-write");
  const failureFor = (value: number): Props["queueFailure"] =>
    mode === "queue" && (value === 4 || value === 7)
      ? {
          queuedItemId: value === 7 ? "queue-4" : "queue-0",
          code: "provider_unavailable",
          message: "模拟服务端暂时不可用；消息仍在队列中。",
        }
      : null;
  const [failure, setFailure] = useState(failureFor(scene));
  const [pending, setPending] = useState(false);
  const [calls, setCalls] = useState(0);
  const response = useRef<{ confirm(): void; fail(): void } | null>(null);
  const next = useRef(10);
  const imageAttempts = useRef(new Set<string>());
  const readFixtureImage = useCallback<NonNullable<Props["onReadAttachment"]>>(
    async (attachment) => {
      if (
        params.get("imageRead") === "fail-once" &&
        !imageAttempts.current.has(attachment.sha256)
      ) {
        imageAttempts.current.add(attachment.sha256);
        throw new Error("Simulated image read failed once.");
      }
      return readQueueFixtureImage(attachment);
    },
    [],
  );
  const choose = (value: number) => {
    setScene(value);
    setThread(scenario(value));
    setApprovals(
      (mode === "runtime" && value === 2) || (mode === "queue" && value === 6)
        ? [runtimeApproval]
        : [],
    );
    setFailure(failureFor(value));
    setPending(false);
    response.current = null;
    setCalls(0);
  };
  function hold(
    confirm: () => void,
    resolve: () => void,
    reject: (error: Error) => void,
    message: string,
  ) {
    setPending(true);
    setCalls((n) => n + 1);
    const held = {
      confirm() {
        try {
          confirm();
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          setPending(false);
          response.current = null;
        }
      },
      fail() {
        reject(new Error(message));
        setPending(false);
        response.current = null;
      },
    };
    response.current = held;
    const automatic =
      params.get("response") === "fail-once"
        ? calls === 0
          ? "fail"
          : "confirm"
        : params.get("response");
    if (automatic === "confirm" || automatic === "fail") {
      setTimeout(() => {
        if (response.current === held) held[automatic]();
      }, 1500);
    }
  }
  return (
    <main
      style={{
        height: "100vh",
        maxWidth: params.has("narrow")
          ? Number(params.get("panelWidth") ?? 650)
          : undefined,
        margin: "auto",
        display: "grid",
        gridTemplateRows: "auto minmax(0,1fr)",
      }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          fontSize: 12,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <strong>组件演示 · 模拟事件回放</strong>
        {params.has("response") ? (
          <span>
            自动模拟回执：
            {params.get("response") === "confirm"
              ? "确认"
              : params.get("response") === "fail-once"
                ? "首次失败，重试确认"
                : "失败"}
          </span>
        ) : null}
        <select
          aria-label="验证场景"
          value={scene}
          disabled={pending}
          onChange={(e) => choose(Number(e.target.value))}
        >
          {(mode === "queue" ? queueScenes : runtimeScenes).map(
            (label, index) => (
              <option value={index} key={label}>
                {label}
              </option>
            ),
          )}
        </select>
        <button disabled={!pending} onClick={() => response.current?.confirm()}>
          模拟确认
        </button>
        <button disabled={!pending} onClick={() => response.current?.fail()}>
          模拟失败
        </button>
        {mode === "queue" ? (
          <>
            <button
              onClick={() =>
                setThread((t) =>
                  applyQueueItem(
                    t,
                    queueItem(next.current++, [
                      {
                        type: "text",
                        text: "新追加：保留消息顺序，并记录验证结论。",
                      },
                    ]),
                  ),
                )
              }
            >
              追加消息
            </button>
            <button
              disabled={!thread.queuedMessages?.length}
              onClick={() => setThread(drainQueueHead)}
            >
              接收首条
            </button>
            <button
              onClick={() =>
                setApprovals((a) => (a.length ? [] : [runtimeApproval]))
              }
            >
              切换审批
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() =>
                setThread((t) => ({
                  ...t,
                  turns: t.turns.map((turn) => ({
                    ...turn,
                    items: [
                      ...turn.items,
                      runtimeTask(
                        `live-${next.current++}`,
                        "task-new",
                        "running",
                      ),
                    ],
                  })),
                }))
              }
            >
              追加运行调用
            </button>
            <button
              onClick={() =>
                setThread((t) => ({
                  ...t,
                  turns: t.turns.map((turn) => ({
                    ...turn,
                    items: [
                      ...turn.items,
                      {
                        ...runtimeCommand(
                          `browser-${next.current++}`,
                          "browser_inspect",
                        ),
                        toolName: "browser_inspect",
                      },
                    ],
                  })),
                }))
              }
            >
              追加浏览器调用
            </button>
            <button
              onClick={() =>
                setThread((t) => confirmedStopped(t.turns[0]!.items))
              }
            >
              追加停止事实
            </button>
          </>
        )}
        <span>已提交 {calls} 次</span>
      </header>
      <ThreadView
        thread={thread}
        approvals={approvals}
        composer={composer}
        queueFailure={failure}
        permissionMode={permission}
        onPermissionChange={setPermission}
        onReadAttachment={readFixtureImage}
        onPickQueueImages={async () => [
          {
            id: `fixture-image-${next.current++}`,
            name: "本地生成测试图 6.png",
            attachment: queueImageAttachments[5]!,
          },
        ]}
        onEditQueued={(params) =>
          new Promise((resolve, reject) =>
            hold(
              () => setThread(editQueueFact(threadRef.current, params)),
              () =>
                resolve({
                  queuedItemId: params.queuedItemId,
                  clientId: params.clientId,
                  revision: params.expectedRevision + 1,
                  editItemId: `edit-${params.editId}`,
                  status: "edited",
                }),
              reject,
              simulatedEditError,
            ),
          )
        }
        onDraftChange={(text) => setComposer((c) => editComposer(c, text))}
        onSubmit={async () => {}}
        onInterrupt={() =>
          new Promise<void>((resolve, reject) =>
            hold(() => {}, resolve, reject, "模拟停止请求未送达。"),
          )
        }
        onRespondToApproval={(_id, _decision) =>
          new Promise<void>((resolve, reject) =>
            hold(
              () => setApprovals([]),
              resolve,
              reject,
              "模拟连接中断；请求仍需你的决定。",
            ),
          )
        }
        onCancelQueued={(targets) =>
          new Promise((resolve, reject) =>
            hold(
              () =>
                setThread((t) =>
                  targets.reduce(
                    (current, x) =>
                      cancelQueueFact(current, x.queuedItemId, x.clientId),
                    t,
                  ),
                ),
              () =>
                resolve({
                  results: targets.map((x) => ({
                    ...x,
                    status: "cancelled" as const,
                  })),
                }),
              reject,
              "取消未完成：模拟连接中断，消息已保留。",
            ),
          )
        }
        onResumeQueue={
          mode === "queue" && (scene === 4 || scene === 5 || scene === 7)
            ? () =>
                new Promise<void>((resolve, reject) =>
                  hold(
                    () => {
                      setFailure(null);
                      setThread(drainQueueHead);
                    },
                    resolve,
                    reject,
                    "模拟连接中断。",
                  ),
                )
            : undefined
        }
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

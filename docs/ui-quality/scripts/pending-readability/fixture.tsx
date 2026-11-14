/** Evidence-only host: unchanged production components, canonical synthetic facts. */
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "@repo/apps/zenx/src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "@repo/apps/zenx/src/renderer/src/thread-reading-state.js";
import {
  emptyComposerState,
  editComposer,
} from "@repo/apps/zenx/src/renderer/src/composer-state.js";
import { installScrollbarVisibility } from "@repo/apps/zenx/src/renderer/src/scrollbar-visibility.js";
import { restoreRecalledComposer } from "@repo/apps/zenx/src/renderer/src/steer-recall-state.js";
import { recoverSteerRecall } from "@repo/src/steer-recall.js";
import { i18n } from "@repo/apps/zenx/src/renderer/src/i18n.js";
import {
  runtimeThread,
  runtimeMessage,
} from "@repo/apps/zenx/test/fixtures/agent-runtime-data.js";
import {
  applyQueueItem,
  queueItem,
  cancelQueueFact,
  editQueueFact,
} from "@repo/apps/zenx/test/fixtures/agent-queue-data.js";
import { nativeRecoveryForThread } from "@repo/apps/zenx/test/native-recovery-fixture.js";
import "@repo/apps/zenx/src/renderer/src/theme.css";
import "@repo/apps/zenx/src/renderer/src/styles.css";

Object.assign(globalThis, { React });
const options = new URLSearchParams(
  (window as any).__qaSearch ?? location.search,
);
const scenario = options.get("scenario") ?? "pending";
const running = scenario !== "pending";
const zh = options.get("lang") === "zh-CN";
document.documentElement.lang = zh ? "zh-CN" : "en";
document.documentElement.dataset.appearance =
  options.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.platform = "win32";
void i18n.changeLanguage(zh ? "zh-CN" : "en");
Date.now = () => 1794211020000;

function initialThread() {
  let thread = runtimeThread(
    [
      {
        type: "userMessage",
        id: "qa-user",
        clientId: null,
        content: [
          {
            type: "text",
            text: "Review pending inputs and the running-send choices. Synthetic local input.",
            text_elements: [],
          },
        ],
      },
      runtimeMessage(
        "qa-response",
        running
          ? "## Readability review\n\nThis synthetic running response leaves the real send choices available. No model or Host is connected."
          : "The synthetic turn was interrupted. Two steering inputs and three queued inputs remain in one pending tray.",
      ),
    ],
    running ? "inProgress" : "interrupted",
  );
  thread.canonicalItems = nativeRecoveryForThread(thread).thread.items;
  for (let index = 1; index <= 2; index++) {
    thread = applyQueueItem(thread, {
      ...queueItem(index, [
        {
          type: "text",
          text: zh
            ? `引导 ${index}：继续之前检查 **可读性**。合成本地输入。`
            : `Steer ${index}: review **readability** before continuing. Synthetic local input.`,
        },
      ]),
      deliveryMode: "steer",
      expectedTurnId: "runtime-turn",
    });
  }
  for (let index = 1; index <= 3; index++) {
    thread = applyQueueItem(
      thread,
      queueItem(index + 2, [
        {
          type: "text",
          text: zh
            ? `排队 ${index}：下一轮单独检查布局。合成本地输入。`
            : `Queued ${index}: a separate next turn for layout review. Synthetic local input.`,
        },
      ]),
    );
  }
  return thread;
}

const rect = (element: Element | null) => {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    right: box.right,
    bottom: box.bottom,
  };
};
function measure() {
  const tray = document.querySelector<HTMLElement>(".pending-tray");
  const panel = document.querySelector<HTMLElement>(".composer-send-popover");
  const body = document.querySelector<HTMLElement>(".composer-send-body");
  const panelRect = rect(panel);
  return {
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    scenario,
    tray: tray && {
      ...rect(tray),
      scrollHeight: tray.scrollHeight,
      clientHeight: tray.clientHeight,
      scrollTop: tray.scrollTop,
      scrollbarColor: getComputedStyle(tray).scrollbarColor,
      overflowY: getComputedStyle(tray).overflowY,
      steers: tray.querySelectorAll(".steer-shelf-row").length,
      queued: tray.querySelectorAll(".queue-shelf:not(.steer-shelf) .queue-row")
        .length,
    },
    panel: panelRect && {
      ...panelRect,
      contained:
        panelRect.x >= 0 &&
        panelRect.y >= 0 &&
        panelRect.right <= innerWidth + 1 &&
        panelRect.bottom <= innerHeight + 1,
    },
    menuBody: body && {
      ...rect(body),
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      scrollTop: body.scrollTop,
    },
    focused:
      document.activeElement?.getAttribute("aria-label") ||
      document.activeElement?.className ||
      null,
    footer: rect(document.querySelector(".composer-send-default .ui-select")),
    pageHorizontalOverflow: document.documentElement.scrollWidth > innerWidth,
  };
}
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function openPanel() {
  const orb = document.querySelector<HTMLButtonElement>(
    ".composer-send-control .action-orb",
  );
  if (!orb) throw Error("Production send orb is unavailable");
  orb.focus();
  orb.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
  );
  await nextFrame();
  await nextFrame();
}
async function focusFooter() {
  if (!document.querySelector(".composer-send-popover")) await openPanel();
  const select = document.querySelector<HTMLButtonElement>(
    ".composer-send-default .ui-select",
  );
  if (!select) throw Error("Production preference Select is unavailable");
  select.focus();
}
Object.assign(window, {
  __pendingReadability: { ready: false, measure, openPanel, focusFooter },
});

function Preview() {
  const [thread, setThread] = useState(initialThread);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const [mode, setMode] = useState<"soft" | "batch" | "queue" | "hard">(
    "batch",
  );
  const [composer, setComposer] = useState(() =>
    editComposer(emptyComposerState(), running ? "Queue visual follow-up" : ""),
  );
  const [action, setAction] = useState("Synthetic callbacks only");
  const append = (item: any) => {
    const next = applyQueueItem(threadRef.current, item);
    threadRef.current = next;
    setThread(next);
  };
  (window as any).zenx = {
    triggers: { list: async () => [] },
    protocol: {
      request: async (method: string, target: any) => {
        if (method === "zen/thread/read")
          return {
            thread: { id: thread.id, items: threadRef.current.canonicalItems },
          };
        if (method === "zen/thread/steer/recall") {
          append({
            type: "user_message_steer_recalled",
            id: crypto.randomUUID(),
            threadId: thread.id,
            createdAt: new Date(Date.now()).toISOString(),
            recallId: target.recallId,
            targets: target.targets,
          });
          return {
            ...recoverSteerRecall(
              threadRef.current.canonicalItems!,
              thread.id,
              target.recallId,
            ),
            status: "recalled",
          };
        }
        if (method.includes("observation")) return {};
        throw new Error(`Synthetic fixture does not execute ${method}`);
      },
    },
  };
  useEffect(() => {
    const cleanup = installScrollbarVisibility(document);
    let retired = false;
    const initialize = async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await nextFrame();
      await nextFrame();
      if (scenario === "send" || scenario === "footer") await openPanel();
      if (scenario === "footer") await focusFooter();
      if (!retired) {
        (window as any).__pendingReadability.ready = true;
        document.documentElement.dataset.pendingReadabilityReady = scenario;
      }
    };
    void initialize().catch((error) => {
      (window as any).__pendingReadability.error = String(error);
      console.error(error);
    });
    const timer = setInterval(() => {
      const result = measure();
      const output = document.querySelector("[data-qa-metrics]");
      if (output)
        output.textContent = `${innerWidth} × ${innerHeight} CSS px · tray ${result.tray?.clientHeight}/${result.tray?.scrollHeight} · panel ${result.panel ? (result.panel.contained ? "contained" : "OUTSIDE VIEWPORT") : "closed"}`;
    }, 250);
    return () => {
      retired = true;
      clearInterval(timer);
      cleanup();
    };
  }, []);
  return (
    <ThreadReadingStateProvider>
      <main
        style={{
          height: "100dvh",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          data-qa-header
          style={{
            flex: "0 0 auto",
            padding: "8px 12px",
            fontSize: 12,
            lineHeight: 1.4,
            background: "var(--color-surface-sidebar)",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <strong>
            Production component fixture ·{" "}
            {running ? "Running send" : "Held pending"}
          </strong>
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}
          >
            <button data-qa="open" onClick={() => void openPanel()}>
              Focus send / open
            </button>
            <button data-qa="footer" onClick={() => void focusFooter()}>
              Focus footer Select
            </button>
            <button data-qa="reset" onClick={() => location.reload()}>
              Reset
            </button>
          </div>
          <output data-qa-metrics style={{ display: "block", marginTop: 4 }}>
            Measuring actual CSS viewport…
          </output>
          <output data-qa-action style={{ display: "block" }}>
            {action}
          </output>
        </header>
        <ThreadView
          thread={thread}
          approvals={[]}
          composer={composer}
          composerSendMode={mode}
          onComposerSendModeChange={async (value) => {
            setMode(value);
            setAction(`Preference: ${value}; no send`);
          }}
          onDraftChange={(text) =>
            setComposer((current) => editComposer(current, text))
          }
          onInterrupt={async () =>
            setAction("Stop callback; fixture stays running for inspection")
          }
          onRespondToApproval={async () => undefined}
          onSubmit={async (intent) =>
            setAction(`Send callback: ${intent}; no Host/model operation`)
          }
          onResumeQueue={async () =>
            setAction("Continue queue callback; no Host/model operation")
          }
          onRestoreRecalled={async (result) => {
            setComposer((current) =>
              restoreRecalledComposer(current, result, () =>
                crypto.randomUUID(),
              ),
            );
            setAction("Synthetic canonical recall restored draft");
            return true;
          }}
          onReorderQueued={async (target) => {
            const id = crypto.randomUUID();
            append({
              type: "user_message_queue_reordered",
              id,
              threadId: thread.id,
              createdAt: new Date(Date.now()).toISOString(),
              ...target,
            });
            setAction("Synthetic canonical reorder appended");
            return { status: "reordered", reorderItemId: id };
          }}
          onSteerQueued={async (target) => {
            const id = crypto.randomUUID();
            append({
              type: "user_message_queue_promoted",
              id,
              createdAt: new Date(Date.now()).toISOString(),
              ...target,
              expectedTurnId: "runtime-turn",
            });
            setAction("Synthetic canonical promotion appended");
            return {
              ...target,
              status: "staged",
              turnId: "runtime-turn",
              revision: target.expectedRevision + 1,
              promotionItemId: id,
            };
          }}
          onCancelQueued={async (targets) => {
            const next = targets.reduce(
              (value, target) =>
                cancelQueueFact(value, target.queuedItemId, target.clientId),
              threadRef.current,
            );
            threadRef.current = next;
            setThread(next);
            setAction("Synthetic canonical cancellation appended");
            return {
              results: targets.map((target) => ({
                ...target,
                status: "cancelled",
              })),
            };
          }}
          onEditQueued={async (target) => {
            const next = editQueueFact(threadRef.current, target);
            threadRef.current = next;
            setThread(next);
            setAction("Synthetic canonical edit appended");
            return {
              ...target,
              status: "edited",
              revision: target.expectedRevision + 1,
              editItemId: `edit-${target.editId}`,
            };
          }}
        />
      </main>
    </ThreadReadingStateProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);

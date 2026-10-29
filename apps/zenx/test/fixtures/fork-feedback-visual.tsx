/** Production ThreadView, synthetic delayed fork only; no Host, Provider or file access. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ThreadView,
  MessageForkContext,
} from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import {
  emptyComposerState,
  editComposer,
} from "../../src/renderer/src/composer-state.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import {
  runtimeThread,
  runtimeMessage,
  runtimeCommand,
} from "./agent-runtime-data.js";
import { nativeRecoveryForThread } from "../native-recovery-fixture.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const zh = new URLSearchParams(location.search).get("lang") === "zh-CN";
void i18n.changeLanguage(zh ? "zh-CN" : "en");
const answer = zh
  ? "## 已完成\n\n最终回复保持可见，运行过程可以单独收起。\n\n这是合成验收内容，不含任何私人会话。"
  : "## Completed\n\nThe exact final answer stays visible while the process is collapsed.\n\nSynthetic acceptance content; no private conversation data.";
function makeThread(id: string) {
  const thread = runtimeThread(
    [runtimeCommand("check"), runtimeMessage("final", answer)],
    "completed",
    id,
  );
  thread.canonicalItems = nativeRecoveryForThread(thread).thread.items;
  return thread;
}
function Preview() {
  const [thread, setThread] = useState(() => makeThread("source"));
  const [requests, setRequests] = useState(0);
  const [composer, setComposer] = useState(emptyComposerState);
  const [pendingCopy, setPendingCopy] = useState<{
    complete: () => void;
    fail: () => void;
  } | null>(null);
  const fork = async () => {
    setRequests((count) => count + 1);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const controls = {
        complete: () => {
          if (settled) return;
          settled = true;
          setPendingCopy(null);
          setThread(makeThread("copy"));
          resolve();
        },
        fail: () => {
          if (settled) return;
          settled = true;
          setPendingCopy(null);
          reject(
            new Error(
              zh
                ? "合成复制失败；原会话保留。"
                : "Synthetic copy failure; source preserved.",
            ),
          );
        },
      };
      setPendingCopy(controls);
      Object.assign(window, { __forkPreview: controls });
    });
  };
  return (
    <ThreadReadingStateProvider>
      <MessageForkContext.Provider value={fork}>
        <main
          style={{ height: "100vh", display: "flex", flexDirection: "column" }}
        >
          <header
            style={{
              padding: "16px 24px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <strong>
              {thread.id === "copy" ? "Copied thread" : "Source thread"}
            </strong>
            <span style={{ marginLeft: 16 }}>
              Synthetic only · {requests} fork request(s)
            </span>
            <span style={{ display: "inline-flex", gap: 8, marginLeft: 16 }}>
              <button
                type="button"
                data-fork-preview="complete"
                disabled={!pendingCopy}
                onClick={() => pendingCopy?.complete()}
              >
                Complete copy
              </button>
              <button
                type="button"
                data-fork-preview="fail"
                disabled={!pendingCopy}
                onClick={() => pendingCopy?.fail()}
              >
                Fail copy
              </button>
            </span>
          </header>
          <ThreadView
            thread={thread}
            approvals={[]}
            composer={composer}
            onDraftChange={(draft) =>
              setComposer((current) => editComposer(current, draft))
            }
            onInterrupt={async () => undefined}
            onRespondToApproval={async () => undefined}
            onSubmit={async () => undefined}
          />
        </main>
      </MessageForkContext.Provider>
    </ThreadReadingStateProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);

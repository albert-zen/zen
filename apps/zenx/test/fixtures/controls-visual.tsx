import { installScrollbarVisibility } from "../../src/renderer/src/scrollbar-visibility.js";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Select,
  Combobox,
  Dialog,
} from "../../src/renderer/src/ui/controls.js";
import { PermissionSelect } from "../../src/renderer/src/PermissionSelect.js";
import { ContextCompactionEvent } from "../../src/renderer/src/ThreadView.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
installScrollbarVisibility(document);
document.documentElement.dataset.appearance =
  new URLSearchParams(location.search).get("theme") ?? "light";
function Preview() {
  const [value, setValue] = useState("queue");
  const [model, setModel] = useState("m0");
  const [open, setOpen] = useState(false);
  return (
    <main
      style={{
        padding: 24,
        maxWidth: 800,
        margin: "auto",
        overflow: "auto",
        height: "100vh",
      }}
    >
      <h1>Conversation controls</h1>
      <p>Shared states for ZenX’s working surfaces.</p>
      <label className="field">
        <span>Send preference</span>
        <Select value={value} onValueChange={setValue}>
          <option value="queue">Queue</option>
          <option value="soft">Soft steer</option>
          <option disabled value="unavailable">
            Unavailable
          </option>
        </Select>
      </label>
      <label className="field">
        <span>Disabled</span>
        <Select disabled value="queue" onValueChange={() => {}}>
          <option value="queue">Queue</option>
        </Select>
      </label>
      <label className="field">
        <span>Model</span>
        <Combobox label="Model" value={model} onValueChange={setModel}>
          {Array.from({ length: 30 }, (_, i) => (
            <option key={i} value={`m${i}`}>
              研究模型 {i} · Long model name for multilingual projects
            </option>
          ))}
        </Combobox>
      </label>
      <div style={{ marginBlock: 20 }}>
        <PermissionSelect
          disabled={false}
          value="danger-full-access"
          onChange={() => {}}
        />
      </div>
      <button
        className="quiet-button"
        type="button"
        onClick={() => setOpen(true)}
      >
        Open dialog
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Edit project">
        <h2>Edit project</h2>
        <label className="field">
          <span>Project name</span>
          <input defaultValue="ZenX" />
        </label>
        <button className="primary-button" onClick={() => setOpen(false)}>
          Save
        </button>
      </Dialog>
      <ContextCompactionEvent
        projection={{
          canonicalIndex: 6,
          effectiveMessages: [{ role: "user", text: "Retained request" }],
          item: {
            id: "compact-1",
            type: "context_compaction",
            threadId: "thread-1",
            createdAt: "2026-09-20T09:00:00Z",
            provenance: "agentic",
            initiator: "agent",
            turnId: "turn-1",
            callId: "call-1",
            sourceModelResponseId: "response-1",
            coveredThroughItemId: "item-5",
            summary:
              "## 当前目标\n完成桌面界面精修，保留已验证的交互约定。\n\n- 导航与选择器使用统一的键盘行为。\n- 压缩摘要可以阅读和复制，历史消息仍可追溯。\n\n### 下一步\n验证长中文摘要、窄窗口和连续切换。\n\n" +
              "这是一段较长的上下文摘要，用来检验真实的中文阅读宽度与滚动。".repeat(
                24,
              ),
            retainedItemIds: ["user-1"],
            algorithmVersion: "zen.agentic-compaction.v1",
          },
        }}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);

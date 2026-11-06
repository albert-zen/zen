/** Synthetic only: actual ThreadView renders canonical and pending messages. */
import React from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { runtimeThread } from "./agent-runtime-data.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
const lang = params.get("lang") === "en" ? "en" : "zh-CN";
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const count = params.get("images") === "2" ? 2 : 1;
const payloads = new Map<string, Uint8Array>();
const images = Array.from({ length: count }, (_, index) => {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 300;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = index ? "#e8bd77" : "#8ebec8";
  ctx.fillRect(0, 0, 480, 300);
  ctx.fillStyle = index ? "#a35f30" : "#25626f";
  ctx.beginPath();
  ctx.arc(240, 135, 75, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "24px sans-serif";
  ctx.fillText(`Synthetic image ${index + 1}`, 135, 260);
  const bytes = Uint8Array.from(
    atob(canvas.toDataURL("image/png").split(",")[1]!),
    (c) => c.charCodeAt(0),
  );
  const sha256 = String(index + 1).repeat(64);
  payloads.set(sha256, bytes);
  return {
    id: `synthetic-${index}`,
    name: `synthetic-${index + 1}.png`,
    attachment: {
      type: "attachment" as const,
      sha256,
      mediaType: "image/png" as const,
      byteLength: bytes.length,
      width: 480,
      height: 300,
    },
  };
});
const readAttachment = async (attachment: { sha256: string }) => {
  const bytes = payloads.get(attachment.sha256);
  if (!bytes) throw Error("Unexpected synthetic attachment");
  return bytes;
};

const text =
  params.get("text") === "long"
    ? "请比较这两张合成图片，解释大小和对齐是否一致？\n".repeat(12)
    : "这张图片为什么没有对齐？";
const content = [
  { type: "text" as const, text },
  ...images.map((image) => ({
    type: "image" as const,
    attachment: image.attachment,
  })),
];
const held = params.get("state") === "held";
const thread = runtimeThread(
  [
    {
      type: "userMessage",
      id: "synthetic-normal",
      clientId: "synthetic-normal-client",
      content: [{ type: "text", text, text_elements: [] }],
    },
  ],
  held ? "completed" : "inProgress",
  "synthetic-steer-thread",
);
thread.canonicalItems = [
  {
    type: "user_message",
    id: "synthetic-normal",
    clientId: "synthetic-normal-client",
    threadId: thread.id,
    turnId: "runtime-turn",
    createdAt: "2026-11-06T12:00:00Z",
    content,
  },
  {
    type: "user_message_queued",
    id: "synthetic-pending",
    clientId: "synthetic-pending-client",
    threadId: thread.id,
    createdAt: "2026-11-06T12:00:01Z",
    deliveryMode: "steer",
    expectedTurnId: "runtime-turn",
    input: content,
  },
];
Object.defineProperty(window, "zenx", {
  configurable: true,
  value: {
    protocol: {
      request: async () => {
        throw Object.assign(new Error("Synthetic recall conflict"), {
          data: { zenCode: "steer_recall_conflict" },
        });
      },
    },
  },
});
function Preview() {
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <header style={{ padding: "8px 12px", fontSize: 11 }}>
        Synthetic images only · production ThreadView · canonical versus pending
        steer · no Host/provider
      </header>
      <ThreadView
        thread={thread}
        approvals={[]}
        composer={emptyComposerState()}
        onReadAttachment={readAttachment}
        onDraftChange={() => {}}
        onInterrupt={async () => {}}
        onRespondToApproval={async () => {}}
        onSubmit={async () => {}}
        onRestoreRecalled={() => true}
      />
    </main>
  );
}
i18n
  .changeLanguage(lang)
  .then(() => createRoot(document.getElementById("root")!).render(<Preview />));

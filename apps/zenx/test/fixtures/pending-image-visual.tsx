/** Synthetic interaction fixture: actual ThreadView, reducers and CSS; no Host/provider. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import {
  addComposerImages,
  editComposer,
  emptyComposerState,
  beginImmediateComposerSubmission,
  acceptComposerSubmission,
  failImmediateComposerSubmission,
  reconcileCanonicalAdmission,
  recoverPendingSend,
  dismissPendingSend,
} from "../../src/renderer/src/composer-state.js";
import type { CanonicalItem } from "../../../../src/item.js";
import { runtimeThread } from "./agent-runtime-data.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
const lang = params.get("lang") === "zh-CN" ? "zh-CN" : "en";
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
const initial = () =>
  addComposerImages(
    editComposer(
      emptyComposerState(),
      count === 2 ? "Compare these synthetic images." : "",
    ),
    images,
  );
const clientId = "synthetic-pending-image-client";
function Preview() {
  const [composer, setComposer] = useState(initial);
  const [stage, setStage] = useState("draft");
  const [canonical, setCanonical] = useState(false);
  const thread = runtimeThread(
    canonical
      ? [
          {
            type: "userMessage",
            id: "synthetic-user",
            clientId,
            content:
              count === 2
                ? [
                    {
                      type: "text",
                      text: "Compare these synthetic images.",
                      text_elements: [],
                    },
                  ]
                : [],
          },
        ]
      : [],
    "completed",
    "synthetic-image-thread",
  );
  thread.name = "Synthetic pending images";
  const change = (next: string) => {
    if (next === "reset") {
      setComposer(initial());
      setCanonical(false);
      setStage("draft");
      return;
    }
    if (next === "admitted")
      setComposer((s) => acceptComposerSubmission(s, clientId));
    if (next === "unconfirmed" || next === "notSent")
      setComposer((s) =>
        failImmediateComposerSubmission(
          s,
          clientId,
          "Synthetic transport failure",
          next === "unconfirmed",
        ),
      );
    if (next === "canonical") {
      const item = {
        id: "synthetic-user",
        type: "user_message",
        turnId: "runtime-turn",
        clientId,
        text: count === 2 ? "Compare these synthetic images." : "",
        threadId: "synthetic-image-thread",
        createdAt: "2026-11-06T12:00:00Z",
      } as CanonicalItem;
      setComposer((s) => reconcileCanonicalAdmission(s, [item]));
      setCanonical(true);
    }
    setStage(next);
  };
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <header
        style={{
          padding: "8px 12px",
          fontSize: 11,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <strong>Synthetic fixture · production ThreadView</strong>
        <div>No App, Host or model call. Generated images only.</div>
        <nav style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {["reset", "admitted", "canonical", "unconfirmed", "notSent"].map(
            (next) => (
              <button
                key={next}
                data-fixture={next}
                onClick={() => change(next)}
              >
                {next}
              </button>
            ),
          )}
        </nav>
        <div role="status" data-stage={stage}>
          Synthetic stage: {stage}
        </div>
      </header>
      <ThreadView
        thread={thread}
        approvals={[]}
        composer={composer}
        threadAttachments={
          canonical
            ? { "synthetic-user": images.map((image) => image.attachment) }
            : {}
        }
        onReadAttachment={readAttachment}
        onDraftChange={(text) => setComposer((s) => editComposer(s, text))}
        onInterrupt={async () => {}}
        onRespondToApproval={async () => {}}
        onRecoverPendingSend={(id) =>
          setComposer((s) => recoverPendingSend(s, id))
        }
        onDismissPendingSend={(id) =>
          setComposer((s) => dismissPendingSend(s, id))
        }
        onSubmit={async (intent, expectedTurnId) => {
          setComposer((s) =>
            beginImmediateComposerSubmission(
              s,
              intent,
              expectedTurnId,
              () => clientId,
            ),
          );
          setStage("sending");
        }}
      />
    </main>
  );
}
i18n
  .changeLanguage(lang)
  .then(() => createRoot(document.getElementById("root")!).render(<Preview />));

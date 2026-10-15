import React from "react";
import { createRoot } from "react-dom/client";
import { RoomConversationNavigation } from "../../src/renderer/src/room-conversations.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/room-conversations.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
const language = params.get("lang") === "zh" ? "zh" : "en";
void i18n.changeLanguage(language);
document.documentElement.lang = language;
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const before = params.has("before");
if (before) {
  const style = document.createElement("style");
  style.textContent =
    ".room-unread-count {line-height:18px}.room-unread-value {text-box-trim:none}";
  document.head.append(style);
}
if (params.get("zoom"))
  document.documentElement.style.zoom = params.get("zoom")!;
const rooms = [3, 12, 105].flatMap((unreadCount) =>
  [true, false].map((assistant) => ({
    id: `${assistant ? "paw" : "room"}-${unreadCount}`,
    name:
      language === "zh"
        ? `${assistant ? "研究助手" : "设计讨论"} ${unreadCount}`
        : `${assistant ? "Research" : "Design"} ${unreadCount}`,
    ...(assistant
      ? {
          assistant: {
            threadId: `thread-${unreadCount}`,
            triggerId: `trigger-${unreadCount}`,
          },
        }
      : {}),
    members: [],
    memberCount: assistant ? 1 : 2,
    messagePreview:
      language === "zh" ? "合成未读消息" : "Synthetic unread messages",
    unreadCount,
  })),
);
(window as any).zenx = {
  sidebar: { getExpansion: async () => ({}), setExpansion: async () => {} },
};
createRoot(document.getElementById("root")!).render(
  <main
    style={{
      width: "min(280px, calc(100% - 24px))",
      margin: 32,
      padding: 12,
      background: "var(--color-surface-sidebar)",
      borderRadius: 8,
    }}
  >
    <RoomConversationNavigation
      rooms={rooms}
      loading={false}
      error={null}
      selectedPage="agent"
      onOpen={() => {}}
    />
    <p style={{ padding: 8, fontSize: 12, color: "var(--text-3)" }}>
      {before ? "Before" : "Cap-box candidate"} · Synthetic conversations;
      production navigation and font stack. CSS zoom is not native display
      scaling.
    </p>
    <p
      id="font-evidence"
      style={{ padding: 8, fontSize: 11, overflowWrap: "anywhere" }}
    >
      Actual rendered fonts have not yet been inspected.
    </p>
  </main>,
);

// Computed font-family is only the requested stack. The capture worker must
// use only available, permitted inspection tools before recording actual font
// names here. Keep NOT INSPECTED when unavailable; do not bypass disabled tools.
// CSS zoom does not stand in for native DPR.
const evidence = {
  language,
  appearance: document.documentElement.dataset.appearance,
  before,
  cssZoom: params.get("zoom") ?? "1",
  devicePixelRatio: window.devicePixelRatio,
  textBoxTrimSupported:
    CSS.supports("text-box-trim", "trim-both") &&
    CSS.supports("text-box-edge", "cap alphabetic"),
  requestedFontStack: "Pending render",
  actualNumeralFonts: null as string[] | null,
  actualLabelFonts: null as string[] | null,
};
function showEvidence() {
  const caption = document.getElementById("font-evidence");
  if (caption)
    caption.textContent =
      `Language: ${language}; CSS zoom: ${evidence.cssZoom}; DPR: ${evidence.devicePixelRatio}; cap trim supported: ${evidence.textBoxTrimSupported}. ` +
      `Requested stack: ${evidence.requestedFontStack}. ` +
      `Actual numeral fonts: ${evidence.actualNumeralFonts?.join(", ") ?? "NOT INSPECTED"}; ` +
      `actual label fonts: ${evidence.actualLabelFonts?.join(", ") ?? "NOT INSPECTED"}.`;
}
Object.assign(window, {
  fixtureEvidence: evidence,
  recordRenderedFonts(numerals: string[], labels: string[]) {
    evidence.actualNumeralFonts = numerals;
    evidence.actualLabelFonts = labels;
    showEvidence();
  },
});
void document.fonts.ready.then(() =>
  requestAnimationFrame(() => {
    const numeral = document.querySelector(".room-unread-value");
    if (numeral)
      evidence.requestedFontStack = getComputedStyle(numeral).fontFamily;
    showEvidence();
  }),
);

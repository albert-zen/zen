import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShotButton } from "../../src/renderer/src/AppShotButton.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { AppShotApi } from "../../src/app-shot.js";
import type { ZenXImageDraft } from "../../src/main/image-attachments.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

// Entire fixture is synthetic. It reads no real windows or user content.
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
void i18n.changeLanguage("zh-CN");
const canvas = document.createElement("canvas");
canvas.width = 1000;
canvas.height = 500;
const draw = canvas.getContext("2d")!;
draw.fillStyle = "#f8fafc";
draw.fillRect(0, 0, 1000, 500);
draw.fillStyle = "#e2e8f0";
draw.fillRect(0, 0, 1000, 50);
draw.fillStyle = "#0f172a";
draw.font = "22px sans-serif";
draw.fillText("Example Notes · synthetic capture", 24, 33);
draw.font = "32px sans-serif";
draw.fillText("Product review", 52, 120);
draw.font = "21px sans-serif";
draw.fillText("A clear preview before anything is sent.", 52, 180);
draw.fillStyle = "#cbd5e1";
for (let n = 0; n < 4; n++) draw.fillRect(52, 230 + 42 * n, 820 - n * 90, 15);
const png = Uint8Array.from(
  atob(canvas.toDataURL("image/png").split(",")[1]!),
  (char) => char.charCodeAt(0),
);
const shot: ZenXImageDraft = {
  id: "synthetic",
  name: "Example Notes.png",
  attachment: {
    type: "attachment",
    sha256: "c".repeat(64),
    mediaType: "image/png",
    byteLength: png.length,
    width: 1000,
    height: 500,
  },
  appShotContext:
    "App Shot\nApplication: Example Notes\nWindow: Product review\nCaptured: 2026-11-05T11:00:00.000Z\nAccessibility: screenshot only (not requested)",
};
const niri = params.get("platform") === "niri";
const gnome = params.get("platform") === "gnome";
const portal = params.get("platform") === "portal" || gnome;
const api: AppShotApi = {
  configuration: async () =>
    niri
      ? {
          nativeForeground: true,
          niriBinding:
            'Ctrl+Shift+2 repeat=false { spawn "gdbus" "call" "--session" "--dest" "io.github.albert_zen.ZenX.AppShot" "--object-path" "/io/github/albert_zen/ZenX/AppShot" "--method" "io.github.albert_zen.ZenX.AppShot.Capture"; }',
        }
      : portal
        ? {
            nativeForeground: false,
            portalShortcut: true,
            ...(gnome
              ? { gnomeSupport: "extension-unavailable" as const }
              : {}),
          }
        : { nativeForeground: true },
  list: async () => [
    { id: "notes", title: "Product review", applicationName: "Example Notes" },
    {
      id: "browser",
      title: "Local preview · http://localhost:5173",
      applicationName: "Example Browser",
    },
  ],
  capture: async () => shot,
  read: async () => png,
  attach: async () => shot,
  discard: async () => {},
  arm: async () => (portal ? { registered: false, canConfigure: true } : "⌘⇧2"),
  configureShortcut: async () => ({
    registered: true,
    shortcutDescription: "Super+F8",
    canConfigure: true,
  }),
  disarm: async () => {},
  onCapture: () => () => {},
};
Object.assign(window, {
  zenx: {
    platform: niri || portal ? "linux" : "darwin",
    appShot: api,
    imageAttachments: { read: async () => png },
  },
});
function Preview() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setTimeout(() => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="应用快照"]')
        ?.click();
      if (params.get("mode") === "preview")
        setTimeout(
          () =>
            document
              .querySelector<HTMLButtonElement>(".app-shot-sources button")
              ?.click(),
          100,
        );
    }, 100);
  }, []);
  return (
    <main className="thread-view" style={{ padding: 24 }}>
      <h1>应用快照 · 合成数据验收</h1>
      <p>真实组件，无 Host 连接，不读取应用窗口。</p>
      <div className="composer-rail">
        <div className="composer-tools">
          <AppShotButton
            disabled={false}
            api={api}
            onAttach={() => setCount(count + 1)}
          />
        </div>
      </div>
      <p>已添加 {count} 张，未发送。</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);

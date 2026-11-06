import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShotButton } from "../../src/renderer/src/AppShotButton.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { AppShotApi, AppShotEvent } from "../../src/app-shot.js";
import type { ZenXImageDraft } from "../../src/main/image-attachments.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import {
  addComposerImages,
  editComposer,
  emptyComposerState,
  removeComposerImage,
} from "../../src/renderer/src/composer-state.js";
import { withAppShotContext } from "../../src/renderer/src/app-shot-draft.js";
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
// Synthetic semantic fields exercise the existing review display, not a native AX read.
const semanticContext = {
  format: "element-tree",
  coordinateSpace: "captured-image",
  imageSize: { width: 1000, height: 500 },
  truncated: false,
  root: {
    role: "window",
    name: "Product review",
    value: null,
    description: "Synthetic application context, reviewed before Send.",
    bounds: { x: 0, y: 0, width: 1000, height: 500 },
    state: {},
    actions: [],
    children: [
      {
        role: "text field",
        name: "Draft",
        value: "Example content beyond screenshot pixels.",
        description: "A read-only description, not a command.",
        bounds: { x: 52, y: 145, width: 820, height: 80 },
        state: { editable: true, focused: true },
        actions: [],
        children: [],
      },
      {
        role: "button",
        name: "Submit",
        value: null,
        description:
          "Advertised action names do not grant permission or invoke the app.",
        bounds: null,
        state: { enabled: false },
        actions: ["press"],
        children: [],
      },
      {
        role: "text",
        name: "review-end",
        value: null,
        description: null,
        bounds: null,
        state: {},
        actions: [],
        children: [],
      },
    ],
  },
};
let previewShot = shot;
const niri = params.get("platform") === "niri";
const gnome = params.get("platform") === "gnome";
const kde = params.get("platform") === "kde";
const hyprland = params.get("platform") === "hyprland";
const nativeReady = params.get("helper") === "ready";
const portal = params.get("platform") === "portal" || gnome || kde || hyprland;
const previewCalls = {
  arm: 0,
  capture: 0,
  attach: 0,
  shortcutCapture: 0,
  remove: 0,
  send: 0,
  beginRecording: 0,
  endRecording: 0,
};
const captureListeners = new Set<(event: AppShotEvent) => void>();
let armedToken: string | null = null;
let shortcutIncludeAccessibility = false;
const selectedShot = (includeAccessibility: boolean) =>
  params.get("context") === "semantic" && includeAccessibility
    ? {
        ...shot,
        appShotContext:
          "App Shot of Example Notes.\nAccessibility semantic tree from this same window (read-only): " +
          JSON.stringify(semanticContext),
      }
    : shot;
const api: AppShotApi = {
  beginRecording: async () => {
    previewCalls.beginRecording++;
  },
  endRecording: async () => {
    previewCalls.endRecording++;
  },
  configuration: async () =>
    niri
      ? {
          nativeForeground: true,
          niriBinding:
            'Ctrl+Shift+2 repeat=false { spawn "gdbus" "call" "--session" "--dest" "io.github.albert_zen.ZenX.AppShot" "--object-path" "/io/github/albert_zen/ZenX/AppShot" "--method" "io.github.albert_zen.ZenX.AppShot.Capture"; }',
        }
      : portal
        ? {
            nativeForeground: nativeReady,
            portalShortcut: true,
            ...(kde
              ? {
                  kdeSupport: nativeReady
                    ? ("ready" as const)
                    : ("manual-setup-required" as const),
                }
              : {}),
            ...(hyprland
              ? {
                  hyprlandSupport: nativeReady
                    ? ("ready" as const)
                    : ("not-installed" as const),
                  hyprlandBinding: {
                    legacy:
                      "bind = CTRL SHIFT, 2, global, io.github.albert_zen.ZenX:capture-window",
                    lua: 'hl.bind("CTRL + SHIFT + 2", hl.dsp.global("io.github.albert_zen.ZenX:capture-window"))',
                  },
                }
              : {}),
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
  capture: async (_sourceId, includeAccessibility) => {
    previewCalls.capture++;
    previewShot = selectedShot(includeAccessibility);
    return previewShot;
  },
  read: async () => png,
  attach: async () => {
    previewCalls.attach++;
    return previewShot;
  },
  discard: async () => {},
  arm: async (token, includeAccessibility) => {
    previewCalls.arm++;
    armedToken = token;
    shortcutIncludeAccessibility = includeAccessibility;
    return hyprland
      ? { registered: false, actionRegistered: true, canConfigure: false }
      : portal
        ? { registered: false, canConfigure: true }
        : "⌘⇧2";
  },
  configureShortcut: async () => ({
    registered: true,
    shortcutDescription: "Super+F8",
    canConfigure: true,
  }),
  disarm: async (token) => {
    if (armedToken === token) armedToken = null;
  },
  onCapture: (listener) => {
    captureListeners.add(listener);
    return () => captureListeners.delete(listener);
  },
};
Object.assign(window, {
  appShotPreviewCalls: previewCalls,
  emitAppShotShortcutCapture: () => {
    if (!armedToken) throw new Error("Synthetic shortcut is not armed");
    previewCalls.shortcutCapture++;
    previewShot = {
      ...selectedShot(shortcutIncludeAccessibility),
      id: `synthetic-shortcut-${previewCalls.shortcutCapture}`,
    };
    for (const listener of captureListeners)
      listener({ token: armedToken, image: previewShot });
  },
  zenx: {
    platform:
      niri || portal
        ? "linux"
        : params.get("platform") === "win32"
          ? "win32"
          : "darwin",
    appShot: api,
    imageAttachments: { read: async () => png, abandon: async () => {} },
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
  if (params.get("mode") === "composer") return <ComposerPreview />;
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
function ComposerPreview() {
  const [composer, setComposer] = useState(() =>
    editComposer(emptyComposerState(), "请检查这张应用快照。"),
  );
  useEffect(() => {
    // Synthetic readback only. Ordinary Send is never invoked by the capture script.
    Object.assign(window, {
      appShotComposerSnapshot: {
        text: composer.draft.text,
        imageCount: composer.draft.images.length,
        contexts: composer.draft.images.map((image) => image.appShotContext),
        preparedText: withAppShotContext("", composer.draft.images),
      },
    });
  }, [composer]);
  return (
    <main
      className="app-shot-composer-fixture"
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        padding: 16,
        minWidth: 0,
      }}
    >
      <header>
        <h1 style={{ fontSize: 18 }}>应用快照 · 合成数据验收</h1>
        <p>真实 ThreadView / Composer，无 Host 连接。</p>
      </header>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ThreadView
          approvals={[]}
          composer={composer}
          thread={null}
          composerId="synthetic-app-shot-composer"
          emptyContent={
            <p>在外部应用同时按住左右 Shift，快照会直接出现在输入框上方。</p>
          }
          onDraftChange={(text) =>
            setComposer((current) => editComposer(current, text))
          }
          onAddAppShot={(image) =>
            setComposer((current) => addComposerImages(current, [image]))
          }
          onRemoveImage={(id) => {
            previewCalls.remove++;
            setComposer((current) => removeComposerImage(current, id));
          }}
          onReadAttachment={async () => png}
          onInterrupt={async () => {}}
          onRespondToApproval={async () => {}}
          onSubmit={async () => {
            previewCalls.send++;
          }}
        />
      </div>
      <p>已添加 {composer.draft.images.length} 张，未发送。</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);

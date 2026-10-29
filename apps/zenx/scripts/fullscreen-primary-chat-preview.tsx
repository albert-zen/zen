/** Production conversation/workspace components; synthetic, memory-only ports. */
import "../src/renderer/src/shell-thread-panel.css";
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { RoomDraftContext } from "../src/renderer/src/room-drafts.js";
import { RoomHeaderContext } from "../src/renderer/src/room-header.js";
import {
  emptyComposerState,
  editComposer,
  type ComposerState,
} from "../src/renderer/src/composer-state.js";
import { ZenXBrand } from "../src/renderer/src/ZenXBrand.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { Thread } from "../src/protocol-client/index.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import type { WorkspaceBrowserTab } from "../src/main/workspace-browser.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
import "../src/renderer/src/agent-readiness-notice.css";
import "../src/renderer/src/trigger-ui.css";
import "../src/renderer/src/skills.css";
import "../src/renderer/src/rooms-layout.css";
import "../src/renderer/src/room-message-actions.css";
import "../src/renderer/src/room-conversations.css";
import "../src/renderer/src/companion-workspace.css";
import "./fullscreen-primary-chat-preview.css";

Object.assign(globalThis, { React });
const query = new URLSearchParams(location.search);
const zh = query.get("lang") === "zh-CN";
document.documentElement.dataset.appearance = query.get("theme") ?? "light";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = query.get("platform") ?? "linux";
const text = (en: string, cn: string) => (zh ? cn : en);
const now = Date.UTC(2026, 9, 29, 12) / 1000;
const names = {
  "thread-a": text("Research assistant", "研究助手"),
  "thread-b": text("Writing assistant", "写作助手"),
  "room-a": text("Design room", "设计讨论室"),
};
type Owner = keyof typeof names;
function makeThread(id: string, title: string): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "synthetic",
    createdAt: now,
    updatedAt: now,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/synthetic/fullscreen-preview",
    cliVersion: "preview",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: title,
    turns: Array.from({ length: 8 }, (_, index) => ({
      id: `${id}-turn-${index}`,
      items: [
        {
          type: "agentMessage" as const,
          id: `${id}-message-${index}`,
          text:
            index === 7
              ? text(
                  "The reference page is ready. Expand the workspace to keep reading that page, or select the first tab to return to this conversation.\n\nYour unsent draft stays in the same composer.",
                  "参考网页已准备好。展开工作区后会继续显示该网页，也可以点击第一个标签回到主聊天。\n\n未发送草稿始终保留在同一个输入框中。",
                )
              : `### ${text("Research note", "研究记录")} ${index + 1}\n\n${text("This is synthetic conversation content for checking reading position, text selection, and composer preservation across workspace layout changes. No Agent has been called.", "这是用于检查阅读位置、文本选择和输入框保留的合成对话内容。没有调用任何 Agent。")}`,
          phase: "final_answer" as const,
          memoryCitation: null,
        },
      ],
      itemsView: "full" as const,
      status: "completed" as const,
      error: null,
      startedAt: now + index,
      completedAt: now + index + 1,
      durationMs: 1000,
    })),
  };
}
const threads = Object.fromEntries(
  Object.entries(names).map(([id, title]) => [id, makeThread(id, title)]),
);
const sideThread = makeThread(
  "side-research",
  text("Alternative approach", "另一种思路"),
);
const receipts: Array<{
  operation: string;
  threadId?: string;
  tabId?: string;
  visible?: boolean;
}> = [];
const nativePage = document.createElement("div");
nativePage.className = "synthetic-native-page";
nativePage.hidden = true;
nativePage.innerHTML = `<small>${text("SYNTHETIC PAGE · NO NETWORK", "合成网页 · 无网络访问")}</small><h1>${text("Reference notes", "参考笔记")}</h1><p>${text("Expanding this workspace keeps this exact page selected.", "展开工作区时仍保留当前选中的这一个网页。")}</p><h2>${text("A place for focused research", "专注研究的工作区")}</h2><p>${text("The primary conversation becomes the first tab only in expanded mode. Select it when you want to return to the main chat.", "只有展开之后，主聊天才会出现在最左侧的标签中。需要返回主聊天时，可以主动点击它。")}</p>`;
document.body.append(nativePage);
let currentLease: string | undefined;
let currentTarget: string | undefined;
let lastLease: string | undefined;
let showCount = 0;
let hideCount = 0;
let receiptRevision = 0;
const receiptListeners = new Set<() => void>();
const subscribeReceipts = (listener: () => void) => {
  receiptListeners.add(listener);
  return () => {
    receiptListeners.delete(listener);
  };
};
const receiptSnapshot = () => receiptRevision;
function publishReceipt() {
  receiptRevision++;
  for (const listener of receiptListeners) listener();
}
const pageFor = (threadId: string): WorkspaceBrowserTab => ({
  id: `page-${threadId}`,
  threadId,
  title: text("Reference notes", "参考笔记"),
  url: "https://example.test/reference",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  sharedWithAgent: true,
  control: "human",
  agentActionsInFlight: 0,
  agentInspectionsInFlight: 0,
  agentActionOutcomeUnknown: false,
  requiresFreshObservation: false,
});
Object.assign(window, {
  __fullscreenPrimaryPreview: { receipts },
  zenx: {
    platform: document.documentElement.dataset.platform,
    threads: { list: async () => [] },
    plugins: { executeCommand: async () => null, readHandle: async () => null },
    workspaceBrowser: {
      command: async (threadId: string, operation: string) => {
        receipts.push({ operation, threadId });
        if (operation !== "list")
          throw Error(
            "Synthetic preview never navigates, creates, or executes browser commands.",
          );
        return [pageFor(threadId)];
      },
      onChanged: () => () => {},
      onFocusAddress: () => () => {},
      mount: async (request: {
        threadId: string;
        tabId?: string;
        lease: string;
        bounds?: { x: number; y: number; width: number; height: number };
      }) => {
        receipts.push({
          operation: "mount",
          threadId: request.threadId,
          tabId: request.tabId,
          visible: Boolean(request.bounds),
        });
        lastLease = request.lease;
        if (request.bounds) {
          if (currentLease !== request.lease) showCount++;
          currentLease = request.lease;
          currentTarget = `${request.threadId} / ${request.tabId}`;
          Object.assign(nativePage.style, {
            left: `${request.bounds.x}px`,
            top: `${request.bounds.y}px`,
            width: `${request.bounds.width}px`,
            height: `${request.bounds.height}px`,
          });
          nativePage.hidden = false;
        } else if (currentLease === request.lease) {
          nativePage.hidden = true;
          currentLease = undefined;
          currentTarget = undefined;
          hideCount++;
        }
        publishReceipt();
      },
    },
  },
});
const rooms = [
  {
    id: "room-a",
    name: names["room-a"],
    members: [{ name: names["thread-a"], threadId: "thread-a" }],
    createdAt: now,
    messages: [
      {
        id: "room-agent-message",
        kind: "agent",
        author: names["thread-a"],
        roomId: "room-a",
        originThreadId: "thread-a",
        originTurnId: null,
        text: text(
          "This is the Room conversation, not its member’s execution Thread. The first fullscreen tab returns to this exact Room view.",
          "这里是 Room 对话，不是成员的执行线程。全屏中的第一个标签返回同一个 Room 对话视图。",
        ),
        createdAt: now,
        mentions: [],
      },
    ],
  },
];
const roomSdk = {
  version: 1,
  pluginId: "zenx-rooms",
  theme: "light",
  context: {
    route: "/plugins/zenx-rooms/rooms?roomId=room-a",
    primaryNavigation: true,
  },
  commands: {
    execute: async (command: string) => {
      if (command === "list") return { rooms: structuredClone(rooms) };
      throw Error(`Synthetic Room mutation disabled: ${command}`);
    },
  },
  navigation: { navigate: () => {} },
  handles: { read: async () => null },
} as unknown as PluginUiSdkV1;
const noAction = async () => {
  throw Error("Synthetic preview: sending and execution are disabled.");
};

function Preview() {
  useSyncExternalStore(subscribeReceipts, receiptSnapshot);
  const [owner, setOwner] = useState<Owner>(
    (query.get("owner") as Owner) in names
      ? (query.get("owner") as Owner)
      : "thread-a",
  );
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(0);
  const [composers, setComposers] = useState<Record<string, ComposerState>>({});
  const [roomDrafts, setRoomDrafts] = useState<Record<string, string>>({
    "room-a": text("Room draft — keep this text", "Room 草稿——请保留这段文字"),
  });
  const roomRevisions = useRef<Record<string, number>>({});
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  const intent = useRef(0);
  const threadId = owner === "room-a" ? "thread-a" : owner;
  const selected = selections[owner] ?? `browser:page-${threadId}`;
  const order = orders[owner] ?? [
    `browser:page-${threadId}`,
    "thread:side-research",
    "custom:overview",
  ];
  const primary = useMemo(
    () => ({
      title: i18n.t("panels:mainConversation", { title: names[owner] }),
      contentId: "primary-conversation-content",
      onSelect: () => {
        const token = ++intent.current;
        return () => token === intent.current;
      },
    }),
    [owner],
  );
  const renderThread = (id: string, thread: Thread) => (
    <ThreadView
      thread={thread}
      composer={
        composers[id] ??
        editComposer(
          emptyComposerState(),
          text(`Unsent draft for ${thread.name}`, `${thread.name}的未发送草稿`),
        )
      }
      composerId={`composer-${id}`}
      approvals={[]}
      onDraftChange={(draft) =>
        setComposers((current) => ({
          ...current,
          [id]: editComposer(current[id] ?? emptyComposerState(), draft),
        }))
      }
      onSubmit={noAction}
      onInterrupt={noAction}
      onRespondToApproval={noAction}
    />
  );
  useEffect(() => {
    document.body.dataset.previewReady = "true";
  }, []);
  return (
    <RoomDraftContext.Provider
      value={{
        drafts: roomDrafts,
        setDrafts: setRoomDrafts,
        revisions: roomRevisions,
      }}
    >
      <div
        className="app-shell fullscreen-primary-preview"
        style={
          { "--workspace-panel-width": `${width}px` } as React.CSSProperties
        }
      >
        <header className="window-titlebar">
          <div className="window-titlebar-product">
            <ZenXBrand />
          </div>
          {/* Preserve production title-row geometry without inventing a bare
              title outside ConversationTitleBar / PageTitleBar overflow rules. */}
          <div className="window-titlebar-session" />
        </header>
        <aside className="sidebar fixture-navigation">
          <p className="fixture-boundary">
            {text(
              "Synthetic preview · production components",
              "合成预览 · 生产组件",
            )}
          </p>
          <nav aria-label="Fixture conversation owners">
            {(Object.keys(names) as Owner[]).map((id) => (
              <button
                key={id}
                aria-pressed={owner === id}
                onClick={() => {
                  intent.current++;
                  setOwner(id);
                  setOpen(true);
                }}
              >
                {names[id]}
              </button>
            ))}
          </nav>
          <button
            id="thread-browser-toggle"
            onClick={() => setOpen((value) => !value)}
          >
            {text("Toggle workspace", "打开 / 关闭工作区")}
          </button>
          <button
            onClick={() => {
              document.documentElement.dataset.appearance =
                document.documentElement.dataset.appearance === "dark"
                  ? "light"
                  : "dark";
            }}
          >
            {text("Toggle light / dark", "切换浅色 / 深色")}
          </button>
          <button
            onClick={() => {
              intent.current++;
              setSelections((current) => ({
                ...current,
                [owner]: `browser:page-${threadId}`,
              }));
            }}
          >
            {text("Explicitly select same page", "显式选择同一网页")}
          </button>
          <output
            className="fixture-receipts"
            aria-label="Synthetic native-page receipts"
            aria-live="polite"
          >
            <strong>
              {text("Synthetic page receipt", "合成网页挂载记录")}
            </strong>
            <span>
              {text("Visible", "显示中")}: {currentTarget ?? text("none", "无")}
            </span>
            <span>
              {text("Shown", "显示次数")}: {showCount} ·{" "}
              {text("Hidden", "隐藏次数")}: {hideCount}
            </span>
            <span>
              {text("Latest lease", "最近租约")}: {lastLease?.slice(-8) ?? "—"}
            </span>
          </output>
          <p>
            {text(
              "Start on the webpage, expand, then select Main chat. Drafts remain editable, but sending is disabled. Browser pixels and mount receipts are synthetic, not Electron acceptance.",
              "先查看网页，再展开，最后点击主聊天。草稿可编辑但不能发送。网页画面和挂载记录均为合成数据，不代表 Electron 原生验收。",
            )}
          </p>
        </aside>
        <main className="workspace">
          {owner === "room-a" ? (
            <section
              id="primary-conversation-content"
              className="product-page plugin-product-page"
            >
              <div className="page-scroll plugin-page-scroll">
                <div className="plugin-primary-surface">
                  {/* App's header is outside this content-only fixture. Its
                      matching null slot suppresses the standalone fallback. */}
                  <RoomHeaderContext.Provider
                    value={{ roomId: "room-a", element: null }}
                  >
                    <RoomsPage sdk={roomSdk} />
                  </RoomHeaderContext.Provider>
                </div>
              </div>
            </section>
          ) : (
            <section
              id="primary-conversation-content"
              className="agent-surface"
            >
              {renderThread(owner, threads[owner]!)}
            </section>
          )}
          <AuxiliaryPanel
            key={owner}
            {...(owner === "room-a"
              ? {
                  conversationContext: {
                    kind: "room" as const,
                    roomId: owner,
                    resourceThread: { threadId, title: names["thread-a"] },
                  },
                }
              : { threadId })}
            primaryConversation={primary}
            title={names[owner]}
            open={open}
            onOpenChange={setOpen}
            onWidthChange={setWidth}
            snapshot={null}
            selectedTab={selected}
            onSelectTab={(tab) => {
              intent.current++;
              setSelections((current) => ({ ...current, [owner]: tab }));
            }}
            openedTabs={order}
            onTabsChange={(tabs) =>
              setOrders((current) => ({ ...current, [owner]: tabs }))
            }
            conversations={[
              {
                threadId: "side-research",
                title: sideThread.name!,
                render: () => renderThread("side-research", sideThread),
              },
            ]}
            customTabs={[
              {
                id: "overview",
                title: text("Overview", "概览"),
                icon: "layers",
                render: () => (
                  <div className="fixture-overview">
                    <h2>{text("Workspace overview", "工作区概览")}</h2>
                    <p>
                      {text(
                        "A synthetic custom tab, retained in the resource order.",
                        "一个保留在资源顺序中的合成自定义标签。",
                      )}
                    </p>
                  </div>
                ),
              },
            ]}
          />
        </main>
      </div>
    </RoomDraftContext.Provider>
  );
}
void i18n
  .changeLanguage(zh ? "zh-CN" : "en")
  .then(() => createRoot(document.getElementById("root")!).render(<Preview />));

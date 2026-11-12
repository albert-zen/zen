/** Bundled product copy, newest first. Only describe changes already in this build.
 * IDs are permanent editorial identities, not the currently static package version.
 * Dates are calendar labels, never parsed as local-time instants.
 */
export const RELEASE_NOTES = [
  {
    id: "zenx-2026-10-20",
    date: "2026-10-20",
    items: [
      {
        id: "thread-title-authority",
        en: "Thread names stay consistent across the sidebar, conversation and reference picker. Renaming starts from the exact current name.",
        zh: "侧边栏、会话和引用选择器统一显示 Thread 自身名称；重命名从准确的当前名称开始。",
      },
    ],
  },
  {
    id: "zenx-2026-10-17",
    date: "2026-10-17",
    items: [
      {
        id: "compact-working-retry-status",
        en: "Working and retry indicators share a compact, aligned layout, including at narrow widths.",
        zh: "运行与重试状态使用统一紧凑布局，在窄窗口中也保持对齐。",
      },
    ],
  },
] as const;

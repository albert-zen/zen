import type { InformationLayout } from "../../src/information-layout.js";

/** Synthetic fixture data only. No real tasks, timers, people, or Host writes. */
export function supportingRailsData(mode: string | null) {
  if (mode !== "long" && mode !== "collapsed") return null;
  const layout: InformationLayout = {
    version: 1,
    widgets: ["lineage", "triggers"].map((type) => ({
      id: `synthetic-rails-${type}`,
      type: type as "lineage" | "triggers",
      binding: { kind: "owner" },
      visible: true,
      collapsed: mode === "collapsed",
      config: {},
    })),
  };
  return {
    project:
      "Community reading room — multilingual research and accessibility planning",
    thread:
      "Review the complete desktop conversation, sidebar and information cards without losing the current draft",
    children: [
      "Review long conversation names, source navigation and sidebar focus while preserving the current draft",
      "资料卡视觉检查：长中文子会话名称、来源入口与键盘导航的完整验收记录",
    ],
    layout,
    triggers: [
      {
        id: "synthetic-rails-timer",
        threadId: "thread-1",
        kind: "timer",
        active: true,
        label:
          "Daily reading-room planning review with a deliberately long title",
        definitionRevision: 1,
      },
      {
        id: "synthetic-rails-signal",
        threadId: "thread-1",
        kind: "signal",
        active: false,
        label: "资料整理完成后再复核（合成演示，不执行）",
        definitionRevision: 1,
      },
    ],
  };
}

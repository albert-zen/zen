export const en = {
  previewTruncated:
    "Preview truncated at 2,000 characters. Full source remains in the journal.",
  title: "Context inspector",
  stale:
    "Context snapshot is out of date. Previous content is hidden until a fresh read succeeds.",
  refreshLabel: "Refresh context snapshot",
  refresh: "Refresh context",
  eyebrow: "READ ONLY · EXPERIMENT",
  heading: "What is in context?",
  scope:
    "Local message projection from the saved conversation. This is not a capture of an in-flight request or provider-private context.",
  occupancy: "Occupancy",
  estimate: "Projected messages · estimate",
  window: "Model window",
  unknown: "Unknown",
  providerInput: "Last reported provider input",
  indicatorEstimate: "Indicator estimate",
  estimateScope:
    "Message estimate excludes tool schemas and provider-added instructions. Provider input describes the last compatible response, before subsequent local changes. Neither number is cumulative billing usage.",
  summaryHeading: "Summary & retained originals",
  summaryScope:
    "Earlier context is represented by this summary and explicitly retained items. Newer messages continue below.",
  savedSummary: "Saved summary",
  source: "Source:",
  coveredThrough: "Covered through:",
  none: "None",
  noCompaction:
    "No saved compaction. Eligible conversation messages are projected directly.",
  rules: "Repository rules",
  rulesScope: "Saved rule snapshots, not a fresh read of files on disk.",
  noRules: "No repository rule snapshot recorded.",
  capabilities: "Capabilities & attachments",
  capabilitiesScope:
    "Loaded Skills and the complete current tool directory: unknown in this slice. Installed or enabled does not prove loaded into context.",
  toolNamesLabel: "Tool calls present in this projection (up to 80 names):",
  mediaScope:
    "Attachment markers appear in message previews; binary content is omitted. Opaque reasoning is never displayed.",
  empty: "empty conversation",
  tokens: "{{count}} tokens",
  retainedCount: "{{count}} retained source items",
  omittedIds: "{{count}} more IDs omitted.",
  omittedRules: "{{count}} additional rule files omitted.",
  messages: "Projected messages · {{count}}",
  messageScope:
    "Ordered as compiled for the current model selection; previews include rules, summary, permissions and eligible conversation content. Latest {{count}} shown.",
  snapshotPrefix: "Snapshot through",
  snapshotScope:
    ". Refreshes with usage updates; streaming deltas and queued input are excluded.",
  inspect: "Inspect context",
  tab: "Context",
  chooser: "Context · experiment",
};
export const zhCN: Record<keyof typeof en, string> = {
  previewTruncated: "预览已截断为 2,000 个字符，完整来源保留在日志中。",
  title: "上下文检查器",
  stale: "上下文快照已过期。重新读取成功前将隐藏旧内容。",
  refreshLabel: "刷新上下文快照",
  refresh: "刷新上下文",
  eyebrow: "只读 · 实验功能",
  heading: "上下文中有什么？",
  scope:
    "根据已保存对话生成的本地消息投影，不包含正在发送的请求或服务商私有上下文。",
  occupancy: "占用情况",
  estimate: "投影消息 · 估算",
  window: "模型窗口",
  unknown: "未知",
  providerInput: "上次报告的服务商输入",
  indicatorEstimate: "指示器估算",
  estimateScope:
    "消息估算不包含工具定义和服务商添加的指令。服务商输入来自上次兼容响应，尚未包含后续本地更改。两者均非累计计费用量。",
  summaryHeading: "摘要与保留原文",
  summaryScope:
    "早期上下文由此摘要和明确保留的条目表示，较新的消息显示在下方。",
  savedSummary: "已保存摘要",
  source: "来源：",
  coveredThrough: "覆盖至：",
  none: "无",
  noCompaction: "暂无已保存的压缩结果，将直接投影符合条件的对话消息。",
  rules: "仓库规则",
  rulesScope: "已保存的规则快照，非磁盘文件的最新读取结果。",
  noRules: "未记录仓库规则快照。",
  capabilities: "能力与附件",
  capabilitiesScope:
    "此视图无法确定已加载的技能和当前完整工具目录。已安装或已启用并不代表已加载至上下文。",
  toolNamesLabel: "此投影中的工具调用（最多 80 个名称）：",
  mediaScope:
    "消息预览显示附件标记，但省略二进制内容。不会显示不透明推理内容。",
  empty: "空对话",
  tokens: "{{count}} token",
  retainedCount: "{{count}} 个保留来源条目",
  omittedIds: "另省略 {{count}} 个 ID。",
  omittedRules: "另省略 {{count}} 个规则文件。",
  messages: "投影消息 · {{count}}",
  messageScope:
    "按当前模型选择的编译结果排序，预览包含规则、摘要、权限及符合条件的对话内容。显示最近 {{count}} 条。",
  snapshotPrefix: "快照截止至",
  snapshotScope: "。随用量更新刷新，不包含流式增量和排队输入。",
  inspect: "检查上下文",
  tab: "上下文",
  chooser: "上下文 · 实验",
};

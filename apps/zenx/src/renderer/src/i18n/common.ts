export const en = {
  language: "Language",
  languageDescription:
    "Choose the language for the ZenX interface. Changes apply immediately.",
  system: "Follow system",
  languageSaveFailed:
    "Language changed for this window, but could not be saved. It may reset when you reopen ZenX.",
  compactArguments:
    "Use /compact or /compact --no-reference, without other arguments.",
  compactAttachments: "Remove attachments before compacting context.",
  compactNoConversation: "There is no conversation to compact yet.",
  compactWait:
    "Wait for the current reply to finish before compacting context.",
  compacting: "Compacting context…",
  compacted: "Context compacted.",
  compactUnknown:
    "The desktop request returned an error; whether compaction took effect is unknown. Check the conversation before trying again. Original exception text is withheld to protect private data.",
  compactNoNew: "There is no new completed conversation to compact.",
  compactUnconfirmed:
    "Could not confirm this compaction request. Check the conversation before trying again.",
  compactRejected:
    "Request rejected by the service (code: {{code}}). Original exception text is withheld to protect private data.",
};
export const zhCN: Record<keyof typeof en, string> = {
  language: "语言",
  languageDescription: "选择 ZenX 界面语言，更改立即生效。",
  system: "跟随系统",
  languageSaveFailed:
    "当前窗口的语言已更改，但无法保存。重新打开 ZenX 后可能会重置。",
  compactArguments:
    "请使用 /compact 或 /compact --no-reference，不要添加其他参数。",
  compactAttachments: "请先移除附件，再压缩上下文。",
  compactNoConversation: "尚无可压缩的对话。",
  compactWait: "请等待当前回复结束后再压缩上下文。",
  compacting: "正在压缩上下文…",
  compacted: "上下文已压缩。",
  compactUnknown:
    "桌面请求返回错误，无法确定压缩是否已生效。请检查对话后再重试。为保护隐私，未显示原始异常文本。",
  compactNoNew: "没有新的已完成对话可供压缩。",
  compactUnconfirmed: "无法确认本次压缩请求的结果。请检查对话后再重试。",
  compactRejected:
    "服务拒绝了请求（代码：{{code}}）。为保护隐私，未显示原始异常文本。",
};

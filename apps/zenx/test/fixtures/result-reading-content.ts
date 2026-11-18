/** Invented display-only review. No commands are executed or real files referenced. */
export const resultReadingPrompts = [
  "检查这个合成的导出摘要示例，先展示代码。",
  "逐项列出检查结果，保留完整标识和中文原因。",
  "哪些问题应优先处理？请不要实际运行任何代码。",
];
export const resultReadingAnswers = [
  '# Export review\n\nSynthetic demonstration only; this is not an executed task.\n\n```typescript\nconst summary = rows.map(({ key, result }) => ({ key, result }));\nconst warnings = summary.filter((row) => row.result !== "ok");\n```',
  `## Result matrix

以下结果全部为合成数据。这是导出摘要检查的示例记录，不代表实际执行结果。

| 状态 | 检查项 / Identifier | 说明 / Evidence | 下一步 |
| --- | --- | --- | --- |
| 通过 | Summary | 数量与合成输入一致。 | 保留 |
| 待查 | 中文字段关联 | 检查导出摘要是否保留原始列的含义。 字段名称与原始含义不一致时需要逐项复核，不应直接缩写。 这里没有真实文件、任务或个人信息。 | 复核 |
| 警告 | ExportSummaryValidationSyntheticIdentifierWithoutBreaks0123456789 | The result is synthetic. The identifier is retained verbatim for reproducible comparison. The export includes records with optional labels and missing descriptions. No repair has been applied to these records. | Review |
| 通过 | Empty values | 空白值按示例规则处理；无需执行修复。 | 保留 |
| 待查 | Mixed-language labels | 检查名称中包含英文缩写，导出说明保留中文原文，等待人工确认。 The label should preserve its original meaning in the exported record. | 检查 |
| 跳过 | Network access | 此示例不访问网络，不读取本地文件，也不提交任何更改。 | 无 |
| 通过 | Stable ordering | 每条记录按固定顺序显示。 | 保留 |
| 待查 | Final comparison | 最终对照尚未完成，需要核对原始输入与导出摘要的记录数量和字段。 Do not mistake this synthetic observation for a real test result. | 对照 |

结果表结束。`,
  "## Priority summary\n\n优先复核中文字段含义和缺失的说明，再核对导出记录数量。以上仅是示例内容，没有运行、复制或写入任何命令。",
];

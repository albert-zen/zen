/** Display-only invented strings; never evaluated as code or sent to a Host. */
export const codeWrapText = [
  'const note = "Compare this deliberately long English line in the code viewer without losing its ending: keep the original spacing, punctuation and complete source available for copying, even when the displayed line wraps to fit the conversation.";',
  'const 中文说明 = "这是用于视觉验证的合成代码文本，不会运行任何命令，也不包含真实用户信息；检查一整行中文是否能在开启换行后完整阅读，并且复制时保留原始文字与标点。";',
  `\tconst unbrokenToken = "${"SyntheticToken_".repeat(14)}";`,
].join("\n");

export const codeWrapMarkdown = `# Inspect long code without changing it

This is synthetic, display-only source. Nothing runs it. Wrapping changes presentation, not the copied source.

\`\`\`typescript
${codeWrapText}
\`\`\`

The explanation after the code stays in the conversation. The Composer and navigation should remain available.`;

# 主对话长代码：可选换行，不压缩正文

本轮保留可选 Wrap lines / 代码换行。默认仍为原始不换行代码；只在源码确认闭合的顶层 fence 提供该按钮，未闭合、嵌套和缩进代码保持横滚与复制。正文行距仍为27px，没有全局压密、窄屏或资料卡改动。

基线 `b475522049340ff45e021b4a7dc43ef673f5ea6e`，候选 `9d33c04b5d856c159726648f0ab61bf80a8c305e`。独立评审匿名M=基线、N=候选，不知道目标分。建议保留，不能把局部提升称为整套UI完成。

## 验证与取舍

- 快速真实生产组件/合成会话截图：基线[43206341189](https://github.com/albert-zen/zen/actions/runs/43206341189)，候选[43207670455](https://github.com/albert-zen/zen/actions/runs/43207670455)，捕获分别51.6/62.9秒，均通过；不是等待全量CI后才反馈。
- 两主题原生Tab进入按钮、Enter换行、Tab复制、Space恢复均通过；receipt确认focus-visible。但盲评认为焦点外观不够醒目，不能用程序焦点存在掩盖这一视觉缺点。
- 开启后代码scrollWidth1945→798px，恰好等于798px视口；代码高160.6→307.6px，解释下移147px，底部554.2px仍早于Composer顶部774px。默认尺寸不变，无全页面横溢出。
- 英文、中文、tab缩进和长token原文在复制适配器中逐字一致。**剪贴板为合成stub，不代表OS剪贴板验收**。生产Copy行为未替换。
- [6项定向DOM/CSS/memo测试日志](tests.log)通过。初版流式更新会重置Wrap/焦点，已在发布前拒绝并修复；闭合块追加正文或后续fence保持相同按钮身份/状态/焦点，多块独立，引用替换复制最新值。
- [完整来源、图像SHA256、几何和交互记录](receipt.json)。实际Chromium渲染生产App/Markdown等组件，合成只读数据；并非原生打包应用或真实账号会话。

## 独立逐项评分

以下每项10分，全部16状态和4参考原图实际查看。截图评分不是功能验收，也不是跨产品公平排名；参考任务不同。Linear缺原图本轮N/O，不伪造评分。


| 对象 | 主题 | 截图状态 | 长行可读性 | 控制发现与反馈 | 主对话层级 | 空间一致性 | 整体完成度 |
|---|---|---|---:|---:|---:|---:|---:|
| M | 深色 | long-unwrapped | 5.0 | 5.5 | 8.0 | 8.0 | 7.0 |
| M | 深色 | horizontal-scroll | 5.5 | 6.0 | 8.0 | 8.0 | 7.0 |
| M | 浅色 | long-unwrapped | 5.0 | 5.5 | 8.0 | 8.0 | 7.0 |
| M | 浅色 | horizontal-scroll | 5.5 | 6.0 | 8.0 | 8.0 | 7.0 |
| N | 深色 | long-unwrapped | 5.0 | 6.5 | 8.0 | 8.0 | 7.5 |
| N | 深色 | horizontal-scroll | 5.5 | 7.0 | 8.0 | 8.0 | 7.5 |
| N | 深色 | wrap-keyboard-focus | 5.5 | 7.0 | 8.0 | 8.0 | 7.5 |
| N | 深色 | wrapped | 8.0 | 7.5 | 8.0 | 8.0 | 8.0 |
| N | 深色 | copied | 8.0 | 8.0 | 8.0 | 7.5 | 8.0 |
| N | 深色 | unwrapped-restored | 5.0 | 7.5 | 8.0 | 7.5 | 7.5 |
| N | 浅色 | long-unwrapped | 5.0 | 6.5 | 8.0 | 8.0 | 7.5 |
| N | 浅色 | horizontal-scroll | 5.5 | 7.0 | 8.0 | 8.0 | 7.5 |
| N | 浅色 | wrap-keyboard-focus | 5.5 | 7.0 | 8.0 | 8.0 | 7.5 |
| N | 浅色 | wrapped | 8.0 | 7.5 | 8.0 | 8.0 | 8.0 |
| N | 浅色 | copied | 8.0 | 8.0 | 8.0 | 7.5 | 8.0 |
| N | 浅色 | unwrapped-restored | 5.0 | 7.5 | 8.0 | 7.5 | 7.5 |


### 参考对象

| 参考对象 | 可见内容 / 主题 | 长行或结果可读性 | 控制发现与反馈 | 主对话层级 | 空间一致性 | 整体完成度 |
|---|---|---:|---:|---:|---:|---:|
| T3 | 深色，短代码及结果表格 | 8.0 | 7.0 | 8.5 | 8.5 | 8.5 |
| Codex | 浅色，结果摘要及文件链接 | 8.5 | 8.0 | 8.5 | 8.5 | 9.0 |
| Claude | 浅色，代码差异及执行摘要 | 7.5 | 7.0 | 8.0 | 8.0 | 8.0 |
| DSH | 深色，完成摘要及任务状态 | 8.0 | 8.0 | 8.0 | 8.0 | 8.0 |
| Linear | 无截图 | N/O | N/O | N/O | N/O | N/O |


完整论据、代价及建议见[原始盲评](BLIND-REVIEW.md)。新控制不提高默认截断文本可读性；开启后5→8，控制发现性有所改善。主要代价：块高增加、逻辑行/视觉续行边界不清、开启与焦点状态外观区分不足。保留默认横滚，不默认开启。

## 产品原图

### light：前后默认和开启

![基线默认](before/reading-desktop-light-code-long-unwrapped.png)

![候选默认](after/reading-desktop-light-code-long-unwrapped.png)

![候选换行](after/reading-desktop-light-code-wrapped.png)

![before light horizontal-scroll](before/reading-desktop-light-code-horizontal-scroll.png)

![after light horizontal-scroll](after/reading-desktop-light-code-horizontal-scroll.png)

![after light wrap-keyboard-focus](after/reading-desktop-light-code-wrap-keyboard-focus.png)

![after light copied](after/reading-desktop-light-code-copied.png)

![after light unwrapped-restored](after/reading-desktop-light-code-unwrapped-restored.png)

### dark：前后默认和开启

![基线默认](before/reading-desktop-dark-code-long-unwrapped.png)

![候选默认](after/reading-desktop-dark-code-long-unwrapped.png)

![候选换行](after/reading-desktop-dark-code-wrapped.png)

![before dark horizontal-scroll](before/reading-desktop-dark-code-horizontal-scroll.png)

![after dark horizontal-scroll](after/reading-desktop-dark-code-horizontal-scroll.png)

![after dark wrap-keyboard-focus](after/reading-desktop-dark-code-wrap-keyboard-focus.png)

![after dark copied](after/reading-desktop-dark-code-copied.png)

![after dark unwrapped-restored](after/reading-desktop-dark-code-unwrapped-restored.png)

## 本轮实际参考原图
![Codex actual reference](https://github.com/albert-zen/zen/blob/745389d3938e969b3d54592fc098a956a9bbd529/docs/ui-quality/references/official-desktop-demos-20261111/proactive-20s.png?raw=true)

![Claude Code actual reference](https://github.com/albert-zen/zen/blob/745389d3938e969b3d54592fc098a956a9bbd529/docs/ui-quality/references/claude-official-demo-20261111/product-demo-conversation.jpg?raw=true)

![T3 Code actual reference](https://github.com/albert-zen/zen/blob/745389d3938e969b3d54592fc098a956a9bbd529/docs/ui-quality/references/t3-runtime-6f13f36f/main-conversation-dark%281%29.jpg?raw=true)

![DeepSeek Harness actual reference](https://github.com/albert-zen/zen/blob/745389d3938e969b3d54592fc098a956a9bbd529/docs/ui-quality/references/deepseek-harness-production-fcc0ad4/subagents-dark.jpg?raw=true)


T3固定版本[代码块源码](https://github.com/pingdotgg/t3code/blob/6f13f36fab31131917f178a904985f638913b26c/apps/web/src/components/chat/MarkdownCodeBlock.tsx)提供Wrap/Copy实现线索；原图只显示短代码，不声称已测其长行交互。后续值得评估的是清晰的开启/焦点状态与续行结构，而非继续压正文。更长真实代码、屏幕阅读器、缩放和原生应用仍未验收。

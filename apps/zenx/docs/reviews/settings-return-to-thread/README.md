# 从设置直接回到原会话

基线：[已合并 #761](https://github.com/albert-zen/zen/pull/761)，主分支 `9e65c3493b668e25d34c3942974716b7360b2e7e`。对照：未合并候选。Zen 实际 renderer 在离线云 Chromium 131.0.6778.0（Linux），合成会话、输入草稿、设置内容。不是 macOS／Windows 的原生标题栏验收。

| 场景 | 已合并版设置 | 候选设置 | 候选：返回原会话 |
| --- | --- | --- | --- |
| 1280×800 深色，键盘 Enter | [原图](dark-merged-settings.png) | [原图](dark-candidate-settings.png) | [原图](dark-candidate-return.png) |
| 1280×900 浅色中文，侧栏已折叠，鼠标返回 | [原图](light-merged-settings.png) | [原图](light-candidate-settings.png) | [原图](light-candidate-return.png) |

打开现有会话、上翻、写一段未发送草稿，再进入设置并改写会话标题提示词（不点「应用」）。现行版靠左侧栏重新选择会话。候选仍是原来的设置页，不改成弹窗；只在确实从现有会话进设置时，标题栏显示「返回会话」，侧栏折叠也可操作。打开一个没有会话的首页再进设置不会出现该动作。

两版均保持会话草稿与同一标题（Release checkpoint 20）的视口位置。候选返回后焦点落到输入框而不卷走正文，受控记录中没有再次发送 Thread resume 请求。再次打开设置时，试写的标题提示词仍在且「应用」仍可用；按钮不会自动应用该设置，也不会发送会话草稿。[重开设置的原图](dark-candidate-reopen.png)。

**参考。** T3 Code [#42085 的作者实跑与原图](https://github.com/pingdotgg/t3code/pull/42085#evidence)：对照也是编辑会话标题提示词后离开并重开设置，1280×800 深色 Linux Chromium 156。原图右上有清晰的关闭操作；作者演示还验证从 Back 离开不丢文字。T3 用弹窗与失焦保存，Zen 沿用整页与显式应用，所以借鉴可见的直接返回入口与草稿不丢，不照搬关闭或保存语义。不自行实跑 T3，不把不同保存方式当作同一端到端评分。

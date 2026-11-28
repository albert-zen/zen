# 对话图片：适应窗口与原尺寸

这是 [#761 已合并版本](https://github.com/albert-zen/zen/pull/761) 与未合并本地候选的对照，不是又一次产品合并。基线为主分支 `9e65c3493b668e25d34c3942974716b7360b2e7e`，候选在该树上只改普通图片预览中的交互、样式和中英文标签。实际运行 Zen 对话渲染界面，Linux Chromium 131.0.6778.0，合成 QA 长图及未发草稿，无外部请求。不是 Windows 或 macOS 原生验收。

| 界面 | 已合并版 | 候选：默认打开 | 候选：查看原尺寸后滚到图底 |
| --- | --- | --- | --- |
| 浅色，1440×1000 | [原图](1440-merged-fit.png) | [原图](1440-candidate-fit.png) | [原图](1440-candidate-detail.png) |
| 深色，1100×850 | [原图](1100-merged-fit.png) | [原图](1100-candidate-fit.png) | [原图](1100-candidate-detail.png) |

任务是从会话打开 1200×2200 的截图并读清最下方的 QA 编号，而不离开当前会话。合并版只能适应窗口，图片高度分别为 904／754 CSS px，滚轮不会把缩小的字放大；预览里的唯一按钮为关闭。候选默认尺寸与基线相同。在原图装不下时才出现“查看原尺寸”，切后是 1200×2200 CSS px，可在图片区域内滚动，详情图中可读 `ZEN-END-10`。“适应窗口”恢复全图。两种窗宽均验证键盘打开、Enter 切换、End 到图底、Escape 回到缩略图，草稿不变。未增加发送、下载、联网或 AppShot 专用上下文的新行为，也未验证系统缩放／原生读屏。

**同类参考。** [DeepSeek Harness 第三方图片灯箱插件原始录屏](https://github.com/loyalchiiina/dsh-chat-image-lightbox/blob/788b7221ae229d20c02ba0b07ed2e2389f0ed0ab/docs/images/lightbox-demo.mp4) · [作者原图](https://github.com/loyalchiiina/dsh-chat-image-lightbox/blob/788b7221ae229d20c02ba0b07ed2e2389f0ed0ab/docs/images/lightbox.png)。实看作者录屏：约 0:50 默认适应，0:55 放大到局部，0:58 回到全图，1:00 再放大并移动视口；右边工具独立于图片。录屏是该插件而非 DSH 默认功能，非我方自跑，不重传其中实拍素材。对照的是同类的打开、看细节与恢复动作，不是同一张图或相同的放大倍率；录屏的 100% 是插件显示值，不能当作原始像素证明。Zen 候选只提供两个必要状态，不复制多图翻页、下载、方向盘与缩放面板。另见 [Zulip 桌面/网页官方操作说明](https://chat.zulip.org/help/view-images-and-videos) 的缩放与复位，它是文档参考。未取得同素材、同任务的外参，不给可读性或整套 UI 报比较分。

补充键鼠复核（1100 px、中文）：180×120 小图以原大小打开，不出现多余按钮；大图原尺寸下可用左右方向键到达横向右边缘，Tab 留在预览，直接 Escape 返回缩略图；重新打开为适应窗口，点击留白关闭也返回缩略图。

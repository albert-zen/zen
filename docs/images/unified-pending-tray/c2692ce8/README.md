# PR743 当前验收截图

来源：PR head `0c58f840e5da22671cd821cba84642bf1ca06689`，实际托管 checkout `c2692ce879eca6250c583b26f6755598f33411e0`，tree `22c3edf0f268921aaac012c9edcdf372d94897a9`。四图直接取自 CI artifact，未经编辑。

- pending-wide-light.png、pending-narrow.png、queue-editor.png：真实 macOS Electron 中的生产 ThreadView / PendingSteerPanel / PendingSendRows 与 CSS，数据全部合成，无生产 Host 或用户配置。来源 https://github.com/albert-zen/zen/actions/runs/42564563613/artifacts/13650908155 。artifact ZIP SHA256：9b5018fe82621d1c0d907782150289e492b18efb2c9298250cf92b874106415e。
- app-shot-direct-draft.png：Chromium 中生产 AppShotButton / ThreadView / Composer / Dialog / AttachmentImage 与 CSS，窗口身份、截图内容与 API 返回全部合成。不代表 Electron desktopCapturer、原生快捷键、Screen Recording、AX 或模型实际投递。来源 https://github.com/albert-zen/zen/actions/runs/42564563784/artifacts/13650519530 。artifact ZIP SHA256：68b266a0f6c212feb6aaaf67a93b4dee1b5ccc6c93604b306e462384f3420f51。

pending-shelf 验收记录 ok=true。1440px 浅色与深色、390px 中英文均无横向溢出，待发送区不在正式 transcript。Queue editor 的打开/关闭和精确身份经过检查，native save 为 stub，不声称生产 Host 保存端到端通过。

App Shot 20 个合成 UI 场景通过。三种 Composer direct-draft 的 alert=null，shortcutCapture=1、attach=1、capture=0、send=0；移除附件保留草稿文字。此图为390×600的direct-draft。

main 后续70108411仅增加 app-shot-portal.test.ts 测试变更。其与PR的组合tree913a6002相对本截图验收tree仅该测试文件不同，生产UI文件相同；截图仍按其真实checkout标记。

两个自然 CI 周期不能相互拼成全绿：42564563627剩Windows nested-OOPIF截图超时及coverage失败；同树42566074156中Windows attached成功，但RTK darwin-arm64及Electron darwin-arm64/win32-x64下载HTTP504导致三个作业与coverage失败。没有重放输入、增加超时或跳过守卫。

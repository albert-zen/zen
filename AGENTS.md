# AGENTS.md

Zen：本地个人 agent 框架。核心 = Agent Runtime（append-only ItemList）+ App Server。
权威文档：VISION.md（目标）、ARCHITECTURE.md（不变量、概念与边界）、
LESSONS.md（非目标与教训）、PRODUCTS.md（接入端与里程碑）。

## 不变量

1. Thread 的所有会话语义与执行结果必须可从 append-only ItemList 推导。
   凭证、Provider、workspace 配置在 Zen Core 外部，不得保存或覆盖会话状态。
   引入不可推导的会话状态前，必须先修改 ARCHITECTURE.md 并说明理由。
2. 每个新抽象必须先在 ARCHITECTURE.md 获得一句话解释，否则不合入。
3. ZAS 拥有自己的原生协议与语义；Codex App Server（CAS）adapter 只映射其中
   可表达的部分，固定在 codex-cli 0.146.0，CAS 专属类型与映射只允许存在于
   `src/protocol/codex/`。当前共用 endpoint/shape 不构成绑定；ZAS 可以独立演进，
   外部客户端兼容不能反向定义或裁剪 ZAS、Core 与产品语义。
4. Project 不是运行时对象；接入端（CLI/桌面/Web/IM）不得拥有自己的
   Agent/Thread/Turn/调度语义。
5. 流式 delta 不写 journal；journal 每行一个完整的 canonical Item。
6. LESSONS.md 的非目标清单在 review 时对照执行；需要其中某项时先改 LESSONS.md。
7. 失败明确告知用户，不建自我修复的 durable 状态机。
8. 模型消息的全部语义内容须由唯一上下文编译入口先物化为对应角色的 canonical
   `content`（文本均为 text part），经现有 AppServer journal 提交确认后才可分派。
   用户原文、来源与信任边界不变；不能把 system/assistant/tool 全塞成 user。
9. Runtime/Host/provider adapter 在提交边界之后仅执行选择与协议/附件编码，不得
   私加时间、指令、来源包装、恢复说明或媒体替代文案。工具领域输出不属于上下文包装。
10. 旧 history 不回写；必要兼容内容按源事实一次追加并复用，不按 sample 复制历史、
    不另建模型请求权威。Debug 直接展示同一 canonical history；请求捕获仅作观察校验。
    工具 schema、协议 ID、采样参数属于结构化输入；凭证与连接配置绝不借此写入消息。
11. 修改模型输入必须用生产 compiler/adapter + 假 transport 验证已提交内容闭包，
    包括角色/工具配对、追加失败零分派、重试/取消、fork、导入与压缩旁路。

## 验证

```sh
npm test        # Node Core / protocol / CLI + IMZen 单测
npm run check   # format + lint + typecheck + unit
```

## ZenX UI 改动

修改 ZenX 页面、组件、样式或交互前，读取 `apps/zenx/docs/ui-ux.md`。它是持久产品设计规则的唯一权威；验收遵循其中的页面清单、共享组件、平台标题栏与真实操作要求，不从历史截图反推当前合同。

凡涉及 UI 的 PR，必须在 PR 正文或评论中嵌入与验收版本对应的真实界面截图，标明合成数据边界，并在合并前复核。

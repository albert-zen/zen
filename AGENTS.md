# AGENTS.md

Zen：本地个人 agent 框架。核心 = Agent Runtime（append-only ItemList）+ App Server。
权威文档：VISION.md（不变量与 non-goals）、ARCHITECTURE.md（概念与边界）、PRODUCTS.md（接入端）。

## 不变量

1. Thread 的所有会话语义与执行结果必须可从 append-only ItemList 推导。
   凭证、Provider、workspace 配置在 Zen Core 外部，不得保存或覆盖会话状态。
   引入不可推导的会话状态前，必须先修改 ARCHITECTURE.md 并说明理由。
2. 每个新抽象必须先在 ARCHITECTURE.md 获得一句话解释，否则不合入。
3. 对外只有一个 wire protocol：固定版本的 Codex App Server 兼容子集。
   协议类型与映射只允许存在于 `src/protocol/codex/` 目录。
4. Project 不是运行时对象；接入端（CLI/桌面/Web/IM）不得拥有自己的
   Agent/Thread/Turn/调度语义。
5. 流式 delta 不写 journal；journal 每行一个完整的 canonical Item。
6. VISION.md 的 Non-goals 清单在 review 时对照执行；需要其中某项时先改 VISION.md。
7. 失败明确告知用户，不建自我修复的 durable 状态机。

## 验证

```sh
npm test        # 单测（占位：Phase 3 落地后生效）
npm run check   # format + lint + typecheck + unit
```

## 工作方式

人在环：不使用自主 issue 流水线，不写过程档案（DAG/evidence/transcript）。
每个阶段一次整体 review，验收标准见 PRODUCTS.md 里程碑表。

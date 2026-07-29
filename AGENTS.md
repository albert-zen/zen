# AGENTS.md

Zen：本地个人 agent 框架。核心 = Agent Runtime（append-only ItemList）+ App Server。
权威文档：VISION.md（不变量与 non-goals）、ARCHITECTURE.md（概念与边界）、PRODUCTS.md（接入端）。

## 不变量

1. Thread 的权威状态是 append-only ItemList；所有持久化状态必须可从它推导。
   引入不可推导的持久状态前，必须先修改 ARCHITECTURE.md 并说明理由。
2. 每个新抽象必须先在 ARCHITECTURE.md 获得一句话解释，否则不合入。
3. 只有一个 Server、一个协议；协议兼容的变化只允许发生在 codex-compat 包内。
4. 接入端（CLI/桌面/Web/IM）不得拥有自己的 Agent/Thread/Turn/调度语义。
5. VISION.md 的 Non-goals 清单在 review 时对照执行；需要其中某项时先改 VISION.md。
6. 失败明确告知用户，不建自我修复的 durable 状态机。

## 验证

```sh
npm test        # 单测（占位：Phase 2 落地后生效）
npm run check   # format + lint + typecheck + unit
```

## 工作方式

人在环：不使用自主 issue 流水线，不写过程档案（DAG/evidence/transcript）。
每个阶段一次整体 review，验收标准见 PRODUCTS.md 里程碑表。

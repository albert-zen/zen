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

## 验证

```sh
npm test        # Node Core / protocol / CLI + IMZen 单测
npm run check   # format + lint + typecheck + unit
```

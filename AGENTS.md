# AGENTS.md

Zen：本地个人 agent 框架。核心 = Agent Runtime（append-only ItemList）+ App Server。
权威文档：VISION.md（目标）、ARCHITECTURE.md（不变量、概念与边界）、
LESSONS.md（非目标与教训）、PRODUCTS.md（接入端与里程碑）。

## 不变量

1. 只有三个持久逻辑域：模型语义 ItemList、真实观察 Trace、现有产品当前状态。
   ItemList 只写模型语义，不混入 runtime/usage/control 日志；唯一 compiler 在派发前
   提交所有模型可见内容。Trace 缺失不证明工具未派发，不自动重放未知副作用。
   持久日志是事实与恢复真相源；当前权限、队列等只是日志投影/缓存。
   关键控制日志写入不成功不能 ACK 可靠变更，不能以缓存替代日志或恢复已撤权限。
   不引入 Execution/RunState 或另一套可编辑历史；凭证不进入模型上下文。
2. 每个新抽象必须先在 ARCHITECTURE.md 获得一句话解释，否则不合入。
3. ZAS 拥有自己的原生协议与语义；Codex App Server（CAS）adapter 只映射其中
   可表达的部分，固定在 codex-cli 0.146.0，CAS 专属类型与映射只允许存在于
   `src/protocol/codex/`。当前共用 endpoint/shape 不构成绑定；ZAS 可以独立演进，
   外部客户端兼容不能反向定义或裁剪 ZAS、Core 与产品语义。
4. Project 不是运行时对象；接入端（CLI/桌面/Web/IM）不得拥有自己的
   Agent/Thread/Turn/调度语义。
5. 语义 ItemList append-only；压缩只改变选择，不改写旧语义。真实流式 bytes/events
   写入 Trace；旧混合 CanonicalItem 仅用于 legacy 解码与兼容读投影。
6. LESSONS.md 的非目标清单在 review 时对照执行；需要其中某项时先改 LESSONS.md。
7. 失败明确告知用户，不建自我修复的 durable 状态机。

## 验证

```sh
npm test        # Node Core / protocol / CLI + IMZen 单测
npm run check   # format + lint + typecheck + unit
```

## ZenX UI 改动

修改 ZenX 页面、组件、样式或交互前，读取 `apps/zenx/docs/ui-ux.md`。它是持久产品设计规则的唯一权威；验收遵循其中的页面清单、共享组件、平台标题栏与真实操作要求，不从历史截图反推当前合同。

凡涉及 UI 的 PR，必须在 PR 正文或评论中嵌入与验收版本对应的真实界面截图，标明合成数据边界，并在合并前复核。

## 远端检查点

云端工作区可能被清理；本地 commit 不是备份。每个可检查的小阶段及时提交，
交负责发布的 root 审核已授权源码/规范/合成测试后推送远端，并回读核对精确 SHA。
不得等全量验收才备份；未验收阶段仅 draft，不合并。真实 Trace、日志、个人配置、
凭据与临时依赖不得混入公开检查点；每次交接列出文件 manifest 和本阶段新验证结果。

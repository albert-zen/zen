# VISION

Zen 是本地优先的个人 agent 运行框架。它只有两个核心：

1. **Agent Runtime** — 一个 Thread 对应一个 agent 上下文，权威状态是一条
   append-only 的 ItemList。所有构成会话语义的事实皆 Item，agent 的运行就是
   不断追加 Item。
2. **App Server** — 按 thread 路由请求、驱动 Runtime、向订阅者广播事件的统一入口。

CLI、桌面、Web、IM 都是平级的接入端，全部只通过 App Server 协议工作。

## 目标

- 核心概念（Item / Thread / Turn / AgentRuntime / AppServer）在代码中清晰可见：
  一个开发者能顺着单条代码路径读懂一个 Turn 的完整生命周期。
- 对外直接使用生态通用协议（固定版本的 Codex App Server 兼容子集），
  现有客户端和编排工具可以直接驱动 Zen。
- 简单、可读、可解释，优先于完整恢复、向后兼容和防御性工程。
- 如果实现让核心概念难以看见，错的是实现：重写实现，而不是给概念打补丁。

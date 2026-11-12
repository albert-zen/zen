# SALVAGE

从 [zen-legacy](https://github.com/albert-zen/zen-legacy)（tag `legacy-2026-07`，
本地 `~/Code/zen-legacy`）有目的地移植，而不是怀旧式翻仓库。
原则：等新骨架跑通后作为 adapter 一块块搬，不一开始就 copy。

## 值得移植的代码

| 来源（zen-legacy）                                                        | 内容                                       | 去处                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `packages/framework/src/adapters/node/openai-subscription-*.ts`           | 订阅认证 / OAuth 流程，编码了真实协议的坑  | 只作事实参考；Zen 已按自身边界原生实现 adapter/profile，不依赖 PI 或 legacy |
| `packages/framework/src/adapters/node/openai-compatible-model-gateway.ts` | OpenAI 兼容网关                            | 只作事实参考；Zen 使用自己的最小 ModelAdapter                               |
| `apps/imzen/src/zen-bridge.ts` 中的 IM 通道传输部分                       | QQ 消息进出（**不含** durable 路由状态机） | 仅作边界情况参考；imzen 已改为复用 imcodex 的 channels 层（见 PRODUCTS.md） |

## 值得移植的概念（代码重审后再搬）

- kernel：`Item`、`InMemoryItemList`、`AgentLoop`、`ContextCompiler` 仅作为候选
  实现参考；不是预先批准的独立抽象。需要时先在 ARCHITECTURE.md 解释，再用
  更小的实现落地（legacy kernel 已膨胀至 ~1900 行，hook/observer 需重审）。
- `docs/design-intent.md` 中仍准确的段落（item-first 论述），已吸收进 VISION.md，
  移植代码时可回查原文。

## 值得回查的资料

- legacy 的 ~26k 行测试：不移植，但其中记录的真实边界情况在移植 gateway
  和 IM 传输层时值得检索。

## 外部参考（借实现，不 fork 项目）

- **pi**（badlogic，TypeScript，极简）— agent loop 与 provider 处理的结构参考
- **OpenClaw** — 多 IM 通道接入与订阅认证的实现参考
- **Codex CLI**（Apache-2.0）— 订阅认证的官方实现；固定 0.146.0 Codex App Server（CAS）
  shape/schema 的事实来源，不是 ZAS、Core 或产品语义的权威
- **T3 Code** `apps/server/src/provider/Layers/CodexSessionRuntime.ts` —
  特定版本客户端实际调用面与互操作验收的事实来源

## 明确不移植

两层 AppServer、ProjectCoordinator、AgentScheduler、coordination journal、
command ledger、durable lease/wait/handoff、`docs/implementation` 过程档案、
Linear/Symphony 工作流文档。理由见 LESSONS.md。

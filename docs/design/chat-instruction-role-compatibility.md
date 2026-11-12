# Chat instruction-role compatibility

Reviewed 2026-10-28. This is a serialization fix, not a new compiler or a
claim that every model supports every feature.

## Decision

Semantic instructions remain `developer` in the committed ItemList. On the
bundled Chat Completions endpoints below, the adapter serializes that role as
`system`, preserving every message's text and position. It does not combine
instructions, add prose, rewrite history, or demote privileged instructions to
`user`. These APIs expose a single instruction role, so the distinction between
semantic `system` and `developer` cannot be represented on their wire protocol.
Their shared distinction from user/assistant/tool data is preserved.

Changing only the generated compaction prompt to `user` is insufficient:
workspace, permission, side-chat and compaction-reference instructions can also
be `developer`. The same adapter projection therefore applies to ordinary turns
and auxiliary requests. Compaction's immutable semantic inputs still record the
original roles, while existing `model_request` Trace artifacts record the exact
serialized request. No new persistence or hidden context is introduced.

## Reviewed protocol scope

| Endpoint                                                                                                    | Official contract                                                                                                                                                            | Wire instruction role |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| DashScope `dashscope.aliyuncs.com`, `dashscope-intl.aliyuncs.com`, workspace/regional `*.maas.aliyuncs.com` | [Chat schema](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions) lists system/user/assistant/tool and covers hosted Qwen, Kimi, DeepSeek and GLM. | system                |
| DeepSeek `api.deepseek.com`                                                                                 | [Chat schema](https://api-docs.deepseek.com/api/create-chat-completion/) lists system/user/assistant/tool.                                                                   | system                |
| SiliconFlow `api.siliconflow.cn`, `api.siliconflow.com`                                                     | [Chat API](https://docs.siliconflow.cn/docs/api/chat-completions-post) documents system messages, including its hosted DeepSeek/Kimi examples.                               | system                |
| Moonshot `api.moonshot.cn`, `api.moonshot.ai`                                                               | [Kimi Chat API](https://platform.moonshot.ai/docs/api/chat) documents standard and system messages across Kimi families.                                                     | system                |
| Zhipu `open.bigmodel.cn`                                                                                    | [Chat schema](https://docs.bigmodel.cn/api-reference/模型-api/对话补全) defines four roles for text models and system/user/assistant for vision/audio; includes GLM 5.x.     | system                |
| Native OpenAI Chat                                                                                          | [Chat schema](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) supports developer, and recommends it for o1 and newer.    | unchanged             |
| Custom gateway or unreviewed endpoint                                                                       | No inferred contract from a profile display label or model name.                                                                                                             | unchanged             |

Endpoint matching is exact, except DashScope's existing validated workspace and
region hostname shape. A hostname containing a provider's name is not enough.
Responses and subscription adapters are unchanged. Native OpenAI legacy-model
compatibility and custom gateways require their own explicit protocol evidence;
this change does not assert support for them or try a second protocol on error.

Model-specific exceptions remain important: DashScope documents that QwQ does
not recommend system messages and QVQ ignores them. A role accepted by the HTTP
schema is not proof of instruction-following quality, tool/media support, or
safe suitability for the Agent runtime. This fix does not enable those models,
change discovery metadata or silently convert their instructions to user text.

## Verification boundary

Synthetic tests exercise the real serializer for the five bundled providers,
regional endpoints, several supported model families, native OpenAI and unknown
endpoints. The compaction test uses the real AppServer, compiler, adapter,
durable auxiliary ItemList and Trace with a local injected HTTP fixture. It
checks successful compaction and a provider HTTP 400 that leaves history
uncompacted and performs one attempt only. Existing transport retries for
transient 408/429/5xx are unrelated and unchanged.

No paid model request or live user-history compaction was performed. The user
reported a real DashScope Kimi HTTP 400 from the developer role; the supplied
private request/log contents are not included in tests or this document.

# Deferred tool transport support

The compiler owns the stable, complete, eligible tool catalog. Provider adapters
render that catalog; discovery never grants permission or changes executor routing.
Native namespace summaries and the hosted search entry are prepared and committed
as an exact provider presentation before compilation, not injected during dispatch.

## Current transport matrix

| Transport                                                                             | Native deferred discovery                                                               | Ordinary fallback                               |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Public OpenAI `https://api.openai.com/v1/responses`, exact `gpt-5.4` or `gpt-6-astra` | Hosted `tool_search`; plugin functions grouped in namespaces with `defer_loading: true` | Non-plugin functions stay eager                 |
| Other public Responses endpoint/model pairs                                           | Not enabled                                                                             | Concise descriptions with real argument schemas |
| Chat Completions-compatible endpoints, including DeepSeek                             | Not enabled                                                                             | Concise descriptions with real argument schemas |
| ChatGPT subscription Responses endpoint                                               | Not enabled                                                                             | Existing ordinary tools                         |
| Anthropic Messages                                                                    | No adapter exists in this repository                                                    | Not applicable                                  |

The exact model allowlist is deliberately conservative. Unknown aliases, dated
snapshots, suffixes, proxy routes, and compatible brands do not establish native
capability. Extending the list requires official endpoint/model evidence and a
fixture. No paid API call is needed by these tests.

OpenAI's individual deferred functions still expose their names/descriptions to
the model initially. Namespace grouping instead exposes the group summary until
member discovery. Full catalog definitions still travel over the wire; this is
context deferral, not a smaller HTTP body. Stable sorting and namespace identities
avoid changing the tool prefix after a documentation read or discovery. Tests
check deterministic serialized prefixes, not actual provider cache hits or cost.

Hosted search calls and outputs are semantic history, not locally executable tool
calls. The stream decoder preserves completed search items once, including when
the terminal response repeats streamed items. Namespace identity is retained on
actual function calls. The compiler replays search semantics at the conversation
tail; transport provenance fences prevent forwarding them to another endpoint.
Malformed/client-executed search and namespace mismatches fail closed. There is
no hidden adapter conversation state and no automatic downgrade after dispatch.

Anthropic's documented design differs: deferred definitions are excluded from the
initial context, and hosted search yields inline `tool_reference` blocks which
must remain in conversation history. This informs the boundary but is not an
implemented Anthropic adapter or a claim about compatibility endpoints.

## Official references checked 2026-10-29

- [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search): Responses support starts at GPT-5.4; the guide also demonstrates GPT-6 Astra, namespace definitions, hosted search output, and client-executed search.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): stable common prefixes matter; dynamic conversation content belongs after them.
- [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool): deferred definitions, server tool use, reference results, and unchanged prefix behavior.

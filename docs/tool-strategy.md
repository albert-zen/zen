# Tool strategy and editing evaluation

Status: proposal for review; no tool implementation is approved.

## Product question

Zen supports multiple model providers, so the question is not “how quickly can we add a
string replacement helper?” The question is which model-visible editing contracts Zen
should deliberately support, and whether the answer differs by model family.

Three decisions must remain separate:

1. a generic exact replacement/edit tool for small local changes;
2. a whole-file create/overwrite tool;
3. vendor-native profiles that reproduce a vendor's name, schema, grammar, and result
   contract.

A local replacement tool must not be named `write`. Across the surveyed tool-schema
harnesses, `write` consistently means whole-file creation or replacement. `replace` or
`edit` would describe a local replacement, but this proposal does not approve either
name or any implementation.

## Evidence rules

The comparison uses three labels:

- **Direct training evidence**: the vendor publicly says a model was trained or optimized
  for an exact tool signature.
- **Harness-source observation**: an official repository exposes a tool contract or model
  routing choice. This says what that harness does, not how a model was trained.
- **Inference**: a Zen design implication derived from those facts. It is not a vendor
  guarantee.

“No direct evidence found” means only that the reviewed official public material does not
support the claim. It does not claim knowledge of private training data.

## Official-source comparison

| System                      | Observed editing surface                                                                                                                                                     | Evidence about training or adaptation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Relevance to Zen                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex / Responses    | `apply_patch` is a named freeform tool using the V4A patch format; shell is a separate tool.                                                                                 | **Direct training evidence:** OpenAI says GPT-5.2 was post-trained for `apply_patch` and shell, and reports 35% fewer patch failures for the named freeform tool than a custom patch implementation. [Latest-model guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2), [apply_patch contract](https://developers.openai.com/api/docs/guides/tools-apply-patch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **Inference:** copying only the name is insufficient. A Zen OpenAI-native profile would need the complete grammar and result contract.                |
| Claude Code / Anthropic API | Claude Code exposes exact `Edit` separately from whole-file `Write`. The Anthropic API exposes a versioned command-union text editor.                                        | **Direct training evidence applies only to the API signatures:** Anthropic calls its Anthropic-defined `text_editor`, `bash`, and other client tools “trained-in” exact signatures. [Tool-use guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works), [text editor](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool), [Claude Code tools](https://code.claude.com/docs/en/tools-reference)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **Inference:** Claude Code's `Edit` name must not inherit the API editor's training claim. A native profile means a supported versioned API contract. |
| DeepSeek Harness            | The first-party harness offers `edit` plus whole-file `write`, and a separate command-union string-replace editor.                                                           | **Harness-source observation; no direct training evidence found.** The harness is a developer preview and supports configurable native/PTC presentation. [README @ `0a53fb5`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/README.md), [filesystem tools @ `0a53fb5`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/fs/tool-fs/README.md), [editor @ `0a53fb5`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/fs/tool-str-replace-editor/README.md), [tool presentation @ `0a53fb5`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/core/tools/README.md)                                                                                                                                                                                                                                                                                                                    | **Inference:** schema presentation, execution, and stale-observation policy are separable choices.                                                    |
| Kimi Code                   | `Edit` performs local exact replacement; `Write` creates, overwrites, or appends.                                                                                            | **Harness-source observation.** Kimi-K2 documents native function-call serialization, but the reviewed sources do not say Kimi Code's editing names or schemas were trained in. [Tools @ `616d510`](https://github.com/MoonshotAI/kimi-code/blob/616d51045dbb7c3949c05713d4a0273c74dd07fc/docs/en/reference/tools.md), [tool-call guidance @ `1b4022b`](https://github.com/MoonshotAI/Kimi-K2/blob/1b4022bbb7187cf4011a8bdf0b4cd10e2daa26c4/docs/tool_call_guidance.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **Inference:** evaluate Kimi with the generic profile unless Zen results justify another profile.                                                     |
| Gemini CLI                  | `replace` is separate from whole-file `write_file`. Its executor may progress from exact matching to flexible/fuzzy matching and a second-model correction path.             | **Harness-source observation; no direct training evidence found.** The official source defines schemas by model family. [Tools @ `0bd1d43`](https://github.com/google-gemini/gemini-cli/blob/0bd1d439751478771c45d3d0895a6a9760554bf4/docs/reference/tools.md), [Gemini 3 definitions @ `0bd1d43`](https://github.com/google-gemini/gemini-cli/blob/0bd1d439751478771c45d3d0895a6a9760554bf4/packages/core/src/tools/definitions/model-family-sets/gemini-3.ts), [matching @ `0bd1d43`](https://github.com/google-gemini/gemini-cli/blob/0bd1d439751478771c45d3d0895a6a9760554bf4/packages/core/src/tools/edit.ts#L300-L350), [self-correction @ `0bd1d43`](https://github.com/google-gemini/gemini-cli/blob/0bd1d439751478771c45d3d0895a6a9760554bf4/packages/core/src/tools/edit.ts#L544-L635)                                                                                                                                                                                                                                                                                                        | **Inference:** hidden fuzzy or LLM correction is a distinct product policy, not an implementation detail of an “exact” tool.                          |
| pi                          | `edit` accepts multiple old/new edits for one file; `write` creates or overwrites a whole file. The executor normalizes some model output and text mismatches.               | **Harness-source observation; not vendor training evidence.** [Registry @ `853a80d`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/tools/index.ts#L93-L170), [edit @ `853a80d`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/tools/edit.ts#L34-L147), [matching @ `853a80d`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/tools/edit-diff.ts#L201-L361), [write @ `853a80d`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/tools/write.ts#L187-L232)                                                                                                                                                                                                                                                                                                                                                                  | **Inference:** batching and normalization may reduce turns, but each enlarges the contract and needs Zen evidence.                                    |
| Cline / OpenCode            | Cline provides a strict local `editor` and a separate patch tool. OpenCode provides `edit` plus whole-file `write`, while routing newer GPT models to `apply_patch`.         | **Harness-source observation; not vendor training evidence.** [Cline schema @ `48d6385`](https://github.com/cline/cline/blob/48d63852745460ff0fa3dfcc0457bbe2493841de/sdk/packages/core/src/extensions/tools/schemas.ts#L191-L244), [Cline executor @ `48d6385`](https://github.com/cline/cline/blob/48d63852745460ff0fa3dfcc0457bbe2493841de/sdk/packages/core/src/extensions/tools/executors/editor.ts#L141-L262), [Cline routing @ `48d6385`](https://github.com/cline/cline/blob/48d63852745460ff0fa3dfcc0457bbe2493841de/sdk/packages/core/src/extensions/tools/model-tool-routing.ts#L60-L75), [OpenCode edit @ `9f69463`](https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/opencode/src/tool/edit.ts#L47-L215), [OpenCode write @ `9f69463`](https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/opencode/src/tool/write.ts#L20-L104), [OpenCode routing @ `9f69463`](https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/opencode/src/tool/registry.ts#L291-L303) | **Inference:** a generic editor and vendor-specific patch profile can coexist without sharing semantics.                                              |
| Aider                       | Models emit SEARCH/REPLACE blocks or another configured edit format rather than JSON tool calls. Matching includes bounded tolerance, and edit format is selected per model. | **Harness-source observation; not vendor training evidence.** [SEARCH/REPLACE prompt @ `5dc9490`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_prompts.py#L120-L158), [executor @ `5dc9490`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_coder.py#L41-L187), [model settings @ `5dc9490`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/resources/model-settings.yml#L548-L655)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **Inference:** per-model format selection is plausible, but Aider's assistant-output protocol is not a Zen wire/tool contract.                        |

For editing-contract decisions, the direct signature/training evidence in this survey is
limited to OpenAI's named `apply_patch` contract and Anthropic's versioned API editor.
OpenAI also names shell in its post-training statement, and Anthropic names other API
tools, but those facts do not establish another editing contract. The other rows are
useful harness observations, not proof of model training.

## Current conclusions

- Do not introduce a local replacement tool named `write`.
- Treat generic exact replacement/edit, whole-file writing, and vendor-native profiles as
  independent product decisions.
- Do not silently add fuzzy matching, secondary-model correction, or format adaptation to
  a contract described as exact.
- Do not claim native compatibility from a shared name. Compatibility includes the full
  model-visible input and output contract.
- No editing tool, schema, runtime behavior, protocol change, or provider routing is
  approved by this document.

## Small evaluation before implementation

The evaluation compares tool surfaces, not executor engineering. It should use the current
Zen runtime and representative configured models, with no persistent coordinator or new
benchmark service.

For each provider/model family that Zen intends to support, select one currently usable
model and record the exact provider label and model id. Run at least three repetitions of
each applicable case in [`tool-eval-cases.json`](tool-eval-cases.json), starting each run
from an identical temporary fixture. Compare:

1. `shell_only`: today's baseline;
2. `generic_exact_replace`: a proposed exact-one local replacement contract, supplied only
   in the evaluation harness;
3. `vendor_native`: only where a complete supported native contract and direct evidence
   exist—OpenAI `apply_patch` or an Anthropic versioned API text editor.

The generic evaluation contract is intentionally narrow: `path`, `old_string`, and
`new_string`; exactly one literal current-content match; zero or multiple matches fail
without mutation. This is an eval hypothesis, not an approved Zen schema.

The cases cover unique replacement, repeated text, stale observations, CRLF/BOM/Unicode,
multiple edits in one file, file creation, multi-file changes, and correction after a
failed edit. Whole-file creation is included to expose whether a separate writer is useful;
it does not smuggle create semantics into the generic replacement profile.

Record every run using [`tool-eval-result.schema.json`](tool-eval-result.schema.json); the
companion [`tool-eval-result.example.json`](tool-eval-result.example.json) demonstrates the
shape and is explicitly not evidence. The primary metrics are task completion,
first-edit-attempt success, unintended changes, schema-valid model calls, tool calls, model
turns, input/output tokens, elapsed time, and failure codes. Preserve raw canonical Item
traces outside the repository when available; only reviewed aggregate results belong in
this document.

Validate the static cases and any result files before review:

```sh
npm run validate:tool-eval
npm run validate:tool-eval -- path/to/result.json another-result.json
```

The command validates fixtures and result shape only. It does not run a model, choose a
winner, or alter Zen.

### Decision rule

Do not select a profile from a single successful run. Compare per-model medians and inspect
every unintended change or incomplete run. A candidate may proceed to a separate design
and implementation review only when it improves completion or interaction cost without
increasing unintended changes, and the benefit repeats across the intended model set.
Vendor-native complexity requires a material advantage over the generic profile for that
vendor. Whole-file `write` requires evidence from create/overwrite cases independently of
local-edit performance.

## Decisions requested from reviewers

1. Approve or reject this small evaluation direction before any editing tool is designed.
2. Confirm the representative provider/model families and exact model ids to test.
3. Confirm whether vendor-native evaluation is limited initially to OpenAI and Anthropic,
   the only surveyed systems with direct signature/training evidence.
4. Confirm the repetition count and acceptance interpretation; the proposed minimum is
   three runs per applicable model/profile/case, with zero tolerance for unintended edits.

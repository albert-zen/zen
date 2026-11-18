# Independent correctness review

Reviewed production diff d7f93b83 to working tree, plus the untracked fork-boundary helper and tests. Read AGENTS.md and apps/zenx/docs/ui-ux.md. No production files changed.

## Blocking finding: copied older Turn can fall below separator

- `apps/zenx/src/renderer/src/ThreadView.tsx:3328–3335` derives a Turn's order from its **last** canonical Item, including post-fork closure Items. `:3366–3388` inserts the separator directly after the last started inherited Turn.
- `src/app-server.ts:7573–7603` appends synthetic `tool_result` closures after the fork marker for any copied unmatched tool calls, including those belonging to older aborted Turns. Such a call can precede a subsequent completed Turn in the source.
- Proven DOM reproduction: canonical Items contain Turns 0, 1 (aborted, unmatched tool call), 2 (final inherited turn), the current fork marker, and then a synthetic tool result for Turn 1. The actual `ThreadView` renders the separator with `User 2` immediately before it and `User 1` immediately after it. Thus copied history appears on the new-branch side and copied Turns are reordered. This violates ui-ux.md:668, even before any new branch Turn is appended.
- Minimal fix direction: derive stable Turn ordering from the original Turn position, not a later synthetic closure receipt; place all loaded inherited Turns and their historical compaction rows before the separator. Preserve correct placement of genuinely new-branch rows and existing stable keys.
- Required regression: render the above scenario including a later new branch Turn; assert `User 0`, `User 1`, `User 2`, separator, branch prompt, and inherited compactions appear in that order. Cover paged merge as appropriate.

## Checks

- `node --import tsx --test apps/zenx/test/thread-fork-boundary.test.ts apps/zenx/test/thread-fork-boundary-view.test.ts apps/zenx/test/editable-information-panel.test.ts apps/zenx/test/settings-interaction.test.ts`: 127 passed, 0 failed.
- Existing tests cover basic append identity, latest/nested provenance, full-context exclusion, page-position contiguity, empty-state owner/error gating, and Account route/focus. The above older-Turn closure ordering case is not covered by them.
- This review did not evaluate visual target fidelity or operate the UI. Appearance changes were still in progress during review.

## Re-review of fix

The divider blocker above is resolved. The helper classifies all rendered Turns by canonical start and rejects unclassifiable Turns; the row builder places the separator after all inherited Turn/compaction rows, and suppresses it if new or unknown rows are mixed into that prefix. The new DOM regression exercises an older aborted Turn, its post-marker synthetic tool result, a later inherited Turn and a new branch Turn. I independently ran both fork-boundary test files: 9 passed, 0 failed.

The earlier Turns still appear as 0, 2, 1 in that fixture because `indexTranscriptOrder` used last-Item ordering before this change. This pre-existing transcript-order problem is separate from the newly fixed separator placement; all three copied Turns now remain above the separator. No remaining blocker identified in the reviewed Fork change.

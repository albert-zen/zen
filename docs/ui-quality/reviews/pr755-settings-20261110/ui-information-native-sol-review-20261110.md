> Publication copy: only local paths, if present, are removed; scores and reasons are unchanged. Original SHA256: 0eb5db0a76979bd6a38da95419394f59f57cc44cb8218eeb88332c3d1f58686e.

# Independent native UI review

All five reference originals were inspected before all nine candidate originals. No source, earlier review, ledger, or nearby report was read. No file saved; coordinator should preserve this report.

Ratings: 0 unusable, 1 major weakness, 2 mixed, 3 solid, 4 exceptional. N/O means not observed.

Columns: H information hierarchy; R readability; C color appropriateness; M material/style consistency; A attention allocation; L layout/density; N navigation/context clarity; F visible keyboard focus.

## References

| Original filename | H | R | C | M | A | L | N | F |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| codex-official-project-thread-2026-02-23.jpeg | 3 | 2 | 3 | 4 | 3 | 3 | 3 | N/O |
| t3-pr25251-details-dark.png | 3 | 3 | 3 | 4 | 3 | 3 | 3 | N/O |
| t3-pr25251-model-picker.png | 3 | 3 | 3 | 3 | 3 | 3 | 3 | N/O |
| linear-preferences.png | 4 | 4 | 4 | 4 | 4 | 3 | 3 | N/O |
| vercel-emails-primary-light.png | 4 | 4 | 4 | 4 | 4 | 4 | 3 | N/O |

Evidence:
- **Codex:** Sidebar, workspace, and composer form clear regions. Central starting prompt is prominent, but sidebar metadata and composer placeholder are small and faint at this supplied scale. Material treatment is restrained and cohesive.
- **T3 details:** Separators and aligned glyphs organize repository, branch, PR, and action groups. The After panel’s filled blue Merge button distinguishes the action more clearly. Small secondary text remains subdued.
- **T3 picker:** Provider rail, search, selected model, and legacy group are legible. The After panel reduces repeated provider descriptions. Search underline and selected-model check do not establish keyboard focus.
- **Linear:** Strong heading, label, helper-text hierarchy; consistently aligned controls and dividers. Enabled toggles are distinct. Generous spacing helps scanning but consumes substantial height. Surrounding navigation is cropped.
- **Vercel:** Clear title and explanatory copy, explicit Verified/Primary badges, and well-separated menu actions. Red is reserved for Delete. Surrounding account navigation is not visible.

## Candidates

| Original filename | H | R | C | M | A | L | N | F |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 02-light-parent-information.jpg | 3 | 2 | 3 | 3 | 2 | 2 | 3 | N/O |
| 04-light-child-information-no-inbound.jpg | 3 | 2 | 3 | 3 | 2 | 2 | 3 | N/O |
| 07-light-information-source-A-focus.jpg | 3 | 2 | 3 | 3 | 2 | 2 | 3 | 3 |
| 08-light-information-source-A-keyboard-result.jpg | 3 | 2 | 3 | 3 | 2 | 2 | 3 | 3 |
| 10-light-general-initial.jpg | 3 | 3 | 3 | 3 | 3 | 3 | 3 | N/O |
| 11-light-general-scrolled-end.jpg | 3 | 2 | 3 | 3 | 3 | 3 | 3 | N/O |
| 12-dark-parent-information.jpg | 3 | 2 | 3 | 3 | 2 | 2 | 3 | N/O |
| 14-dark-information-with-companion.jpg | 3 | 2 | 3 | 3 | 2 | 2 | 3 | N/O |
| 15-dark-after-timeout.jpg | 3 | 2 | 3 | 3 | 2 | 2 | 3 | 3 |

Evidence:
- **02:** Information panel groups Subagents and Received from agents sensibly. Agent identity, Idle, and Hidden are visible. However, long raw command-result paths dominate the central conversation while compact inbound summaries receive less emphasis. Pinned and Recent repeat the same selected-looking thread.
- **04:** Child breadcrumb establishes context. Empty information panel explicitly explains availability and Customize. Tool input/result occupies much of the conversation; another raw result begins below it and is partly obscured by the composer.
- **07:** A continuous dark outline visibly encloses the second “From QA reviewer … View source” control. It is distinguishable from ordinary borders. Adjacent summaries are small and gray, while the command-result block remains visually dominant.
- **08:** Child breadcrumb and an outlined tool-result container show a different visible destination state. The outline is clear, but the exact relationship between the source message and this large technical result requires reading dense content. This screenshot alone does not prove keyboard activation succeeded.
- **10:** Settings heading, selected General navigation item, card headings, and full-width controls establish a clear hierarchy. Language and Interaction choices are easy to locate. The foreground-control section continues below the visible viewport; this is not evidence of inaccessible content.
- **11:** At the lower scroll position, Browser, Native cross-device tools, and Compact shell output are visibly available. The final card and bottom whitespace are visible above the persistent footer. Dense helper prose and multiple status treatments make this more demanding to scan than the initial settings view.
- **12:** Dark palette is coherent and blue is restrained. Received-message summaries and contextual metadata are relatively dim and small. Long linked paths and raw output attract more attention than the agent information.
- **14:** Companion tab and separate composers establish two conversation panes. The information surface overlays much of the parent pane, exposing fragments of output behind it. Truncation in the parent composer’s model label and narrow source rows increase scanning effort.
- **15:** Similar split-pane composition and occlusion. A visible outline encloses the first source control, giving a recognizable focus location. No timeout behavior or recovery outcome can be established from the static image.

## Prioritized issues

1. **Reduce raw-output dominance.** Long paths, JSON-like text, and repeated result representations consume prime conversation space. Prioritize the human-readable result and offer technical detail as a secondary disclosure.
2. **Improve information-panel legibility.** Increase the prominence of inbound summaries and source actions relative to small muted metadata. Preserve explicit sender identity.
3. **Resolve overlay competition in split view.** The information panel covers parent conversation content while the companion is open. Consider a layout that avoids exposing distracting text fragments behind it.
4. **Clarify source destinations.** Keep a strong source highlight, but add concise contextual labeling so the destination’s relationship to the selected received message is immediately apparent.
5. **Shorten settings helper prose.** Lower-page controls are demonstrably visible, but several explanatory sentences compete within each card. Separate essential implications from supplementary detail.
6. **Differentiate navigation states.** Repeated selected-looking entries under Pinned and Recent weaken the uniqueness of the current-location cue.

## Limits

All candidate data is isolated synthetic QA at 1188×848. Split panes were evaluated as internal panes, not narrow operating-system windows. Settings screenshots 10 and 11 were treated as different scroll positions of one page.

References differ in task, scaling, crop, and publication age. Ratings compare general visual principles, not pixel-equivalent tasks. Static images cannot establish interaction success, focus order, accessibility conformance, persistence, or timeout recovery. No overall score or historical delta is inferred.

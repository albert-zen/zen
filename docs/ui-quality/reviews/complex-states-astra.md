# Independent review: ZenX complex states

## Decision

**One scoped P2 visual improvement is supported: make Fork's pending state explicitly readable at the action location.** The production component's only visible pending cue is a very faint, icon-sized spinner. The useful pending label exists only as an accessible name/title. This is a feedback problem, not evidence of a broken Fork operation.

No P1 is established. The pending steer tray, separation of answer from process, and basic Information Board hierarchy do not justify a redesign. Other observed opportunities are P3. Some important coverage remains unobserved and must not be converted into presumed defects.

## Scope, evidence version, and method

- Rubric: `ui-quality-iteration/docs/ui-quality/rubric.md`, SHA-256 `17ebc022056f757546301be48b865fe712f4049461d3d03fb87bbe7b5e663490`.
- Frozen product source: `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`.
- Evidence: `/workspace/shared/ui-quality-evidence/complex-baseline/`.
- Capture authority: `native-capture-manifest.json`, SHA-256 `9cba62353311436d9f005ee428f667d05431bd04804b9e58488775124b0623f3`.
- Native manifest describes Electron 43.2.0 captures on 2026-11-09, light theme, 1180 × 812 screenshots of frozen real production components with synthetic facts.
- Independently inspected every original image using `view_image`, not thumbnails or a contact sheet. Verified every screenshot against its manifest SHA-256; all 13 matched. The files use `.png` names but the manifest identifies JPEG encoding.
- Inspected selected source at the frozen commit, only to attribute visible UI to production components versus fixture scaffold and to identify exact improvement targets. Source capabilities are not treated as observed interaction outcomes.
- No prior review reports, target score, desired threshold, or intended winner were consulted. This is a single-baseline review, not a paired comparison. Scores are not averaged.

### Evidence reconciliation

The earlier README and `manifest.json` describe blocked browser capture and zero accepted images. The later native capture manifest establishes the supplied rendered evidence; it does not establish full-app acceptance.

| Image                 | What is actually visible                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10-process            | Wide running reasoning summary, elapsed work label, assistant lead-in, composer and sidebar.                                                          |
| 11-fork               | Final answer with collapsed completed process; message actions not visible at rest.                                                                   |
| 12-information        | Closed Information entry point in synthetic chat/sidebar scaffold.                                                                                    |
| 13-pending            | One pending steer item with image, explicit waiting label/count, recall control, composer; a synthetic canonical image/message is also visible above. |
| 14-information-open   | Open Information surface, synthetic attention card, real trigger controls and first Board.                                                            |
| 15-information-agents | Lower Board content and second Board. **No agent card is visible.**                                                                                   |
| 16-information-bottom | Byte-identical to 15, not additional evidence of scrolling or content.                                                                                |
| 17-process-narrow     | **Wide** running reasoning after an append, not a narrow viewport.                                                                                    |
| 18-process-compact    | 420px synthetic component composition inside the same desktop capture.                                                                                |
| 19-fork-focus         | Clearly visible focus ring on Fork.                                                                                                                   |
| 20-fork-pending       | Synthetic pending copy callback and local pending spinner.                                                                                            |
| 21-fork-failure       | Synthetic failure text; source answer remains visible.                                                                                                |
| 22-fork-success       | Answer remains visible; fixture header says “Copied thread.”                                                                                          |

### Explicit limits

These images do not prove real delivery, durable Fork creation, persistence, actual agent communication, streaming timing, duplicate-action prevention, keyboard activation/order, assistive-technology behavior, reduced motion, measured contrast, or app scroll behavior. The fixture header's copy counter and “Copied thread” label are not product feedback. “Draft saved” and waiting labels are visible states, not evidence that real storage or delivery succeeded.

Expanded process content, reasoning/tool dividers, terminal tool output, waiting/approval/error process states, multi-item unified pending queues, held/recall-conflict states, agent cards, dark theme, full-app narrow layout, settings, and real branch navigation are **N/O**. A source implementation of those states does not fill the visual evidence gap.

## Ten-dimension scorecard

Scores apply only to the inspected visual scope. Each dimension includes a concrete limit or negative observation; N/O items are neither assumed failures nor awarded credit.

### 1. Information hierarchy and grouping — 3/4, high confidence

- **Evidence:** 10, 11, 13–15, 18, 21.
- **Positive:** Elapsed work is smaller and quieter than the assistant's sentence. The completed answer stays independently prominent below the collapsed “Worked for 3s” control. Pending content is grouped directly above the composer with a waiting heading and recall action. Board titles distinguish “Implementation plan” from “Acceptance notes.”
- **Negative:** In 14–15 a generic “Board” disclosure, “INFORMATION BOARD” eyebrow and specific document title form three heading levels for one small card. The generic levels repeat across Boards without adding much differentiation. The document title carries substantially more useful identity than either generic label. Expanded process/tool-divider hierarchy is N/O.
- **Severity / improvement:** P3. In the managed Information context only, test removing the duplicate Board eyebrow or reducing the duplicated header spacing. Preserve the disclosure and the authored title. Verify that each card's disclosure, title, field and save status remain attributable to the correct instance in the same 340px panel.

### 2. Color purpose and semantic accuracy — 3/4, medium confidence

- **Evidence:** 13, 14, 19–21.
- **Positive:** Blue trigger selection also changes thumb position; the red stop action also has a square icon. Focus has a distinct outline. Waiting and failure are expressed in words rather than relying solely on hue. Neutral panels do not compete with authored content.
- **Negative:** The pending Fork spinner in 20 is visually faint. Source attributes that to a 13px spinner inside a disabled button, with the global disabled opacity of 0.45. This is a visual legibility risk, not a measured contrast result. Failure text is neutral but explicit; absence of red is not itself a defect.
- **Severity / improvement:** P2 for the local pending cue, as detailed in F1. Give the pending state readable inline text and a spinner at the normal status treatment. Do not change global disabled opacity or replace meaningful active/focus/stop colors with gray. Verify the exact pending state in light and dark themes and measure contrast separately before making numerical claims.

### 3. Surface and material consistency — 3/4, high confidence

- **Evidence:** 10, 11, 13–15, 18.
- **Positive:** The rounded composer is consistently the primary input surface; message bubbles are flatter, lighter shapes. Pending content is a shallow tray rather than another large modal. Information uses one outer rounded shell with inset editable fields, not a full stack of elevated cards.
- **Negative:** Board field/footer/widget boundaries create closely repeated horizontal rules in 15. They are not broken, but distinct structural layers use similar line weight, adding some visual bookkeeping. Synthetic toolbar controls and the attention card's native HTML button are not evidence of production material inconsistency.
- **Severity / improvement:** P3. If simplifying Board chrome, remove only a demonstrably redundant adjacent rule or reduce spacing duplication. Re-capture two independent Boards and confirm their boundaries remain obvious. No new shadows, extra cards, or general radius redesign is justified.

### 4. Readability and density — 3/4, high confidence

- **Evidence:** 10, 13–15, 17–18, 21.
- **Positive:** Answer text, pending text and Board fields are readable at the captured size. Long running previews fade inside their line instead of overlapping the disclosure arrow. The compact composition contains the user bubble, assistant sentence and composer without horizontal text clipping.
- **Negative:** The Information trigger overlays part of the “Close information” label in 14–16. That is genuine obscured text in the supplied composition, although its full-app reproducibility is unknown. Source/ID/save captions in Boards are noticeably smaller than the authored title and body, but no unreadability is established. The running preview's faded tail is an intentional summary truncation, not proof that full content is inaccessible.
- **Severity / improvement:** P3 verification task for the top-control collision, F2. Reproduce with the real titlebar before editing production positioning. Require fully visible dismissal text and non-overlapping control rectangles in each supported dock/popover mode. Do not enlarge all metadata indiscriminately.

### 5. Attention allocation — 2/4, medium confidence

- **Evidence:** 11, 13–15, 19–21.
- **Positive:** The final answer dominates its collapsed process metadata. The pending steer tray shows a meaningful label and count where the user is composing. The Information attention slot appears before customization and Board content; the card itself is synthetic, so only placement is credited.
- **Negative:** After initiating Fork, the interface replaces a small icon with an even less conspicuous disabled spinner while the answer and ordinary timestamp remain much stronger. Only fixture chrome explains the operation outside that tiny location. This asks the user to monitor a low-salience symbol for an asynchronous action they just requested.
- **Severity / improvement:** P2, F1. Show concise local pending text without a toast, large banner, extra card or movement of the answer. It should remain visible without hover for the entire unresolved callback and disappear/change only on actual resolution.

### 6. Navigation and discoverability — 3/4, medium confidence

- **Evidence:** 10, 12, 14–15, 18–19.
- **Positive:** Project/recent groups and selected thread are visible in the process fixture. Information has Customize, Hide and disclosure controls; Board instances have distinct authored titles. Fork becomes clearly visible with focus. The Information entry has a recognizable list-detail symbol and a pressed background when open.
- **Negative:** At rest in 11, Fork is not discoverable from visible pixels alone. Source intentionally reveals actions on hover/focus and for coarse pointers; this is a discoverability tradeoff, not proven inaccessible behavior. The close-label collision also weakens the visible way back in the Information fixture. Actual branch navigation, current source context after Fork and keyboard order are N/O.
- **Severity / improvement:** P3 verification. Check first-use discovery and keyboard entry in the real app before making the entire action row permanently visible. Verify the Information exit geometry as in F2. Keep the low-noise answer surface if users can find and focus its actions reliably.

### 7. Interaction feedback and state integrity — 2/4, medium confidence

- **Evidence:** 13, 19–22; frozen `MessageForkButton` source attribution.
- **Positive:** Pending steer is explicitly labeled as waiting to enter the model, with one item and recall. Fork failure is written out below the action row and retains the original answer. Fork has an observed focus ring. Source contains `aria-busy`, an accessible pending label, error association and an alert role; those are implementation facts, not screen-reader test results.
- **Negative:** The visible Fork pending state is insufficiently explicit (F1). The success image changes the synthetic header, not a verified production branch boundary. No capture demonstrates accepted-versus-delivered transitions, real save conflicts, late response handling or repeated action behavior. These are N/O, not failures.
- **Severity / improvement:** P2 local visual fix, followed by F5 validation. Preserve existing busy guards, canonical targets, source-current checks, pending authority and actual promise resolution. Test delayed success/failure in the real product and verify feedback never claims success before completion.

### 8. Composition and responsive behavior — 3/4, medium confidence

- **Evidence:** 10, 13–18.
- **Positive:** The wide conversation has a consistent left content edge. Tray and composer share a near-identical content width in 13. In the 420px composition, the preview tail is bounded and the chevron/composer controls stay inside the component. Information reserves a narrow column without visibly covering the synthetic draft field.
- **Negative:** The Information top-control collision is the only obvious overlap. The 420px screenshot is not the app resized to 420px; 17 is not narrow; 15 and 16 are duplicates. Real responsive transitions and scroll containment cannot be rated from those names.
- **Severity / improvement:** P3 verification tasks F2 and F4. Capture actual viewport transitions and expanded content before altering layout. Require no overlapping controls, clipped authored content, or lost composer at supported widths; do not treat a fixture iframe as responsive acceptance.

### 9. Accessibility and input robustness — 3/4 within visible affordances, medium confidence

- **Evidence:** 13–14, 19–21; frozen source for attribution only.
- **Positive:** Fork's focused control has a clear outline separated from the surrounding background. Waiting/failure have text, switches have positional cues, and disclosure arrows remain visible. Source supplies names and relationships for Fork and Information controls.
- **Negative:** The faint spinner is a poor sole visible status cue, especially without motion. Ordinary keyboard traversal, focus retention after pending/failure/success, accessible announcements, hit-target operation, high contrast, contrast ratios and reduced-motion behavior are **N/O**. The one focus screenshot does not prove any of those.
- **Severity / improvement:** P2 for the visible cue; P3 validation for broader input behavior. Add visible pending text using the existing localized status meaning, then test keyboard-only activation and focus location across resolution, and inspect accessible status announcements. Do not claim WCAG compliance from screenshots or aria attributes.

### 10. Cross-surface consistency and product fit — 3/4, medium confidence

- **Evidence:** 10–15, 18–22.
- **Positive:** The inspected chat, composer, pending tray and Information surfaces share restrained borders, muted metadata and content-first emphasis. Distinct Board documents retain their own titles, values and save captions. Semantic blue selection/focus and red stop cues remain useful exceptions to neutral surfaces.
- **Negative:** Fork pending is much less self-explanatory than the pending steer's textual heading. Board containment adds a duplicate generic identity layer. Models, account, appearance, general settings, agent cards and real branch destinations are N/O; no whole-product consistency claim is made.
- **Severity / improvement:** P2 to bring Fork pending up to the existing explicit-state standard, not to make it imitate the tray's size or structure. P3 for managed Board heading duplication. Preserve existing product semantics and instance ownership.

## Five highest-impact findings

The list distinguishes implementation candidates from validation gaps. A P3 validation item is not a claim that unseen product behavior is defective.

### F1 — P2: Fork pending has no readable visible status

- **Exact target:** `apps/zenx/src/renderer/src/ThreadView.tsx`, `MessageForkButton` (around lines 5069–5125); local `.message-fork`/status styling in `styles.css`. The shared spinner is 13px and the disabled button inherits opacity 0.45.
- **Trigger:** A Fork callback remains unresolved. Evidence: 20 compared with focused 19 and failed 21.
- **Observed problem:** Only the faint spinner communicates pending in the production message action area. “Forking…” is a title/aria label, not visible text. The fixture's “1 fork request(s)” header cannot compensate in the product.
- **Consequence:** Users have to distinguish an asynchronous operation from an unavailable/faded action by inspecting a tiny moving glyph. The visual feedback is materially weaker than the pending steer's explicit label. No actual duplicate request or lost Fork is claimed.
- **Scoped change:** Add a concise localized inline pending label with a readable spinner while busy. Keep it visible independent of hover. Prefer a status sibling or a strictly local disabled-busy treatment; do not change all disabled controls. Keep error text and all existing operation guards.
- **Verification:** With a held synthetic promise and then real delayed Fork, “Forking…” remains plainly visible at the initiating action until resolution; the source answer does not move or disappear; failure replaces the pending status with the actual error; success does not appear before the operation resolves. Verify long/localized labels at narrow width. Confirm no regression to repeated-action protection through separate interaction tests.

### F2 — P3 verification: Information trigger overlaps its dismissal label in this fixture

- **Exact target:** `plugin-information-host.tsx` layout measurement/dock placement and close control; `.information-toolbar`, `.information-dock`, `.information-dismiss-toolbar` in `styles.css`; fixture `scripts/information-layout-preview.tsx`.
- **Trigger:** Open Information in 14–16. The icon control around x1097–1132, y48–84 obscures part of the close label near y80.
- **Observed problem:** Two real component controls overlap in the supplied composition. Source anchors the fixed trigger to Linux titlebar metrics and computes dock top from a `.window-titlebar-session` element absent from this synthetic scaffold. That makes full-app attribution uncertain.
- **Consequence:** Part of a way-back label is obscured in the fixture. No proven inaccessible dismissal or full-app regression is asserted.
- **Action:** First reproduce with actual platform titlebar and dock/popover transitions. If absent in the full app, correct the fixture's representative shell rather than shipping a speculative product offset. If present, use the measured titlebar/trigger bounds to reserve non-overlapping space.
- **Verification:** In real Linux/Windows/macOS layouts and the corrected fixture, trigger and dismissal rectangles do not intersect and the full localized close text is visible. A full-app capture with correct header geometry and no collision falsifies this as a production defect.

### F3 — P3: Board identity is repeated before the useful title

- **Exact target:** `EditableInformationPanel.tsx` widget header plus `board-ui.tsx` `.board-heading`/`.board-eyebrow`, only when Board is hosted in managed Information.
- **Trigger:** Multiple Boards in the narrow Information column (14–15).
- **Observed problem:** Generic “Board,” small all-caps “INFORMATION BOARD,” then the actual document title repeat for each instance. Thin rules also separate both footer and enclosing widget. Nothing is clipped, but limited panel height is spent on duplicate identity.
- **Consequence:** Slightly more scanning and vertical travel before reaching authored content and the field. This is polish, not a material inability to distinguish Boards.
- **Optional change:** Remove one generic identity label in the managed context or tighten only redundant spacing/rules. Retain the generic disclosure if it is the customization/visibility control; retain authored titles, source context, independent fields and save state. Do not globally remove the eyebrow from standalone Board surfaces without checking their identity needs.
- **Verification:** Re-capture the same two Boards in the same panel. There should be less repeated generic chrome, with no ambiguity about which disclosure, field or save caption belongs to which titled Board. If removing a label makes that ownership harder to identify, reject the change.

### F4 — P3 evidence gap: Expanded process/tool-divider and real narrow behavior are not visible

- **Exact target:** New evidence for `ThreadView` turn/process disclosures, trace item hierarchy, reasoning and tool output; actual native app viewport transitions.
- **Trigger:** Reviewer must judge process/work/reasoning/tool dividers or responsive behavior from 10, 17 and 18.
- **Observed limit:** The process captures show collapsed running summaries. The completed example shows a collapsed work row. No expanded tool boundary is visible; 17 is wide and 18 is fixture composition.
- **Consequence:** There is no defensible basis for changing divider hierarchy or declaring it accepted. A redesign here would optimize an unobserved state.
- **Action:** Capture completed work expanded with reasoning, a tool request/result and a final answer; also running and waiting/error states, at wide and real narrow app widths. This is an evidence task, not a requested product change.
- **Verification:** Images must clearly expose all semantic boundaries, label the actual viewport/state, and show the source answer separately from process content. Add interaction evidence for disclosure and scroll where those claims are required.

### F5 — P3 evidence gap: Synthetic labels do not establish pending or Fork outcome integrity

- **Exact target:** Native app end-to-end pending tray and Fork flows; `PendingSteerPanel`/unified pending host and actual branch navigation.
- **Trigger:** Evaluating 13 or 20–22 as proof of delivery, queue authority or durable success.
- **Observed limit:** 13 is one synthetic pending steer alongside a synthetic canonical message/image; it is not evidence of duplicate sends. 22's “Copied thread” is written by the fixture header. Multi-item pending sends, held state, recall conflicts and a real branch boundary are absent.
- **Consequence:** A purely visual pass could falsely certify state integrity, or incorrectly “fix” the intentionally distinct canonical/pending facts.
- **Action:** Exercise real queue/accepted/delivered transitions, recall success/conflict, delayed Fork failure/success and source navigation with supported product tests. Capture meaningful terminal states. Do not rewrite authority, remove one of the synthetic duplicate-looking messages, or invent success toasts based on this pack.
- **Verification:** Establish which real operation owns each label; show correct transition timing, durable branch identity and preserved source content. This requirement is satisfied by separate native interaction evidence, not more screenshots of fixture counters.

## Three strengths to preserve

1. **Answer and process have separate visual importance.** The answer remains clear and intact while completed work is collapsed; elapsed work and running summary stay below primary conversation text in emphasis.
2. **The pending steer tray tells the truth in words.** Waiting label, count, item preview and recall form one bounded surface directly above the composer. The tray does not visually promote pending content to a completed assistant result.
3. **Information content stays recognizable and editable without heavy card chrome.** Distinct Board titles and fields are readable within one reserved column; source/save metadata is secondary, and trigger state uses position as well as color. Keep independent Board identity and ownership intact.

## Prioritized next iteration

1. Implement only F1 as the justified P2 visual change: readable local Fork pending feedback, with no lifecycle changes. Capture before/after focus, pending, failure and success using the same fixtures, then separately validate real operation behavior.
2. Resolve F2's fixture/full-app attribution and acquire F4/F5 evidence before modifying Information placement, expanded process dividers or pending authority.
3. Consider F3 only as a small managed-Board polish pass if it demonstrably reduces repetition without losing identity. It does not need to block the Fork improvement.

### Changes that must not be made

- Do not flatten active, focus, stop or future warning/error semantics into monochrome for a calmer score.
- Do not globally strengthen all metadata, remove intentional preview fading, or make every process item a bordered card.
- Do not change pending admission/delivery ownership, canonical-vs-pending mapping, Fork target IDs, guards, current-source checks or persistence logic for this visual task.
- Do not remove source content or infer a duplicate-send defect from 13's deliberately synthetic canonical/pending comparison.
- Do not call 15 an agent-card test, 16 a new scrolling state, 17 narrow, or 18 full-app responsive acceptance.
- Do not change production dock offsets solely to correct a shell-less fixture, and do not add success notifications based on fixture-only success headers.
- Do not claim complete accessibility, reliable app scrolling or native behavior from static captures.

There is no paired candidate here, so candidate preference, regressions and per-dimension winner are not applicable. A future comparison should use the same frozen data, states, viewport and crop; F1 is falsified as an improvement if pending text becomes harder to identify, shifts the answer, masks errors, or is shown before/after the actual pending interval.

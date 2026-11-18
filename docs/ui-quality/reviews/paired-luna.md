# Independent paired UI review: A vs B

## Scope and evidence version

Reviewed all paired screenshots under `blind-review/A/` and `blind-review/B/` (01–09, 18 images total) and the three permitted references: T3 published product, Linear published comparison, and Vercel Geist docs. The target evidence is the same ZenX QA profile rendered by Electron 43.2.0 at 1188×848, per `blind-review/scope.md`. I did not inspect earlier reviews, research, source commit messages, or the Codex article image.

Evidence-pack fingerprint (SHA-256 over sorted hashes of the 18 A/B images, scope, rubric, and the three permitted references): `250b49bc45d536c62688192df4bae09b299e803ed1d47bc65929118b3557bea9`.

Limitations: still images do not establish interaction behavior, scroll persistence, keyboard order, accessible names, reduced motion, delivery, persistence, or contrast ratios. No narrow viewport or assistive-technology states were supplied. The appearance-page pair is not a matched selection state: A05 shows Light selected, while B05 shows System selected. The dark appearance pair (A07/B07) is matched. Ignore hover, timestamp, and spinner differences as instructed. Do not infer that A or B has better unseen behavior.

## Ten-dimension scorecard

Scores use the rubric’s 0–4 anchors. N/O means the supplied evidence cannot support a score without guessing. Preference is dimension-specific, not an overall ranking.

| Dimension                                     |         A |         B | Preference                                                               |
| --------------------------------------------- | --------: | --------: | ------------------------------------------------------------------------ |
| 1. Information hierarchy and grouping         |   3, high |   2, high | A, modestly                                                              |
| 2. Color purpose and semantic accuracy        | 3, medium | 2, medium | A                                                                        |
| 3. Surface and material consistency           |   2, high |   3, high | B                                                                        |
| 4. Readability and density                    |   3, high |   2, high | A                                                                        |
| 5. Attention allocation                       | 3, medium | 2, medium | A                                                                        |
| 6. Navigation and discoverability             |   3, high |   2, high | A                                                                        |
| 7. Interaction feedback and state integrity   | N/O, high | N/O, high | No supported preference; A09 gives clearer empty-state guidance          |
| 8. Composition and responsive behavior        | 3, medium | 2, medium | A at the tested viewport; narrow behavior N/O                            |
| 9. Accessibility and input robustness         | N/O, high | N/O, high | No supported preference; A has stronger visible non-color selection cues |
| 10. Cross-surface consistency and product fit | 3, medium | 2, medium | A, modestly                                                              |

### 1. Information hierarchy and grouping

- **A: 3, high.** A03–A06 separate Settings title, text-labeled categories, page title, and bounded control groups. A03’s subscription card includes `Open model settings`, and A09’s information pane labels its empty state and offers `Customize`. **Negative:** A01/A02 place the PAW text and outline CTA inline beneath the PAW heading, so that unit is less distinctly grouped than Settings cards. Severity P3.
- **B: 2, high.** B01/B02 improves the PAW unit by placing its heading, description, and filled CTA in a card. However, B03 removes the direct `Open model settings` button from the account card, and B09’s open Information pane retains a visible `Customize` action but omits A09’s `Information` label and empty-state explanation. The missing context weakens grouping, while the action itself remains discoverable. Severity P2 for the missing B03 shortcut and P3 for the B09 context omission.
- **Preference and falsifier:** A for the more complete hierarchy and visible next steps across settings and Information, despite B’s improved PAW grouping. This preference would weaken if the missing B03/B09 cues are intentionally absent in the intended state and another equally clear action/empty-state message is available there.

### 2. Color purpose and semantic accuracy

- **A: 3, medium.** A03–A06 use quiet selected-row fills, while A05/A07 use blue outlines plus explicit checkmarks on the selected Graphite preset chips and Azure accent; the selected Standard contrast option is also outlined. A07 is a matched dark-theme comparison. The checkmarks supply a non-color cue for settings selections. **Negative:** muted supporting text is low-emphasis; its actual contrast is unmeasured. Severity P3.
- **B: 2, medium.** B01/B02 adds a clear blue PAW CTA and B’s selected navigation/background accents remain visible. But in matched dark pair B07, the selected Graphite preset chips lack A07’s checkmarks, and the Neutral/Cool/Warm captions are visibly much smaller/fainter; B05 similarly lacks the checks, though its selected theme differs from A05. This makes the selection state less explicit and relies more on subtle border/fill. **Negative:** no status palette for error/waiting/complete is observed, and no contrast ratio is measured. Severity P2 for state clarity, P3 for contrast verification.
- **Preference and falsifier:** A, because its matched dark appearance state has a redundant checkmark cue and more readable preset descriptors. Falsified if interaction testing shows B’s selection outline is equally understood and captions are readable at normal scale. No WCAG claim is made from these images.

### 3. Surface and material consistency

- **A: 2, high.** A03–A06 use rounded, lightly bordered Settings cards; A02/A08 code blocks and composer are separately bounded. The PAW content in A01/A02 is the notable unframed exception. Severity P3.
- **B: 3, high.** B01/B02’s PAW card uses the same restrained border/radius family as Settings cards, with a primary button that reads as an action. Dark B07/B08 preserve the same treatment without added ornament. **Negative:** the repeated card consumes vertical space and the source metadata of the last sidebar item runs into the fixed footer at this viewport. Severity P2 for the space cost, not for a material-style mismatch.
- **Preference and falsifier:** B for the more coherent card treatment. This would change if testing shows PAW should remain inline and secondary, or if the persistent card materially obstructs navigation more often than it helps.

### 4. Readability and density

- **A: 3, high.** A02/A08 body copy, headings, bullets, and code blocks are readable at 1188×848; A03–A06 settings labels and helper text fit their groups. A01/A02 show the final `Release checklist` item and its `Local demo` line above the fixed Settings footer. A05/A07 show the `Neutral`, `Cool`, and `Warm` preset descriptors at a readable size. **Negative:** secondary sidebar metadata and some settings helper text are small and muted; this is a contrast risk to measure, not a confirmed failure. Severity P3.
- **B: 2, high.** Message and settings body text remain comparable in B02–B09/B03–B06, and the PAW card makes its own text clearer. But B05/B07 preset captions are visibly smaller/fainter than A05/A07, and in B01/B02 and repeated-sidebar views the `Release checklist` title sits just above the fixed footer while its `Local demo` line is obscured. Severity P2.
- **Preference and falsifier:** A for visible secondary text and sidebar density. Falsified if a verified overflow/scroll affordance makes the full final row readily available and users can read B’s preset descriptors at normal scale as well as A’s.

### 5. Attention allocation

- **A: 3, medium.** A03 makes the useful next step on an unconfigured account explicit with `Open model settings`; A09 gives a `Customize` action where information is unavailable. A05/A07 visibly mark selected presets. A01’s outlined PAW setup action is less prominent than B’s. Severity P3.
- **B: 2, medium.** B’s blue PAW CTA is immediately noticeable and B’s selected route remains visible. But B03 lacks A03’s direct model-settings action, B09 lacks A09’s Information heading and empty-state explanation while retaining Customize, and the persistent PAW CTA is prominent even during a thread or settings task. Severity P2 for the missing B03 shortcut; P3 for missing B09 context and possible attention competition.
- **Preference and falsifier:** A for the observed account and Information states; B is better only for PAW setup prominence. Falsified if B’s direct route and empty-state cues are reachable just as quickly through another clearly visible control.

### 6. Navigation and discoverability

- **A: 3, high.** A01/A02 show New thread, Triggers, Pinned (including the Chinese-titled thread and `Local demo` row), Rooms, Projects, project threads, source labels, and Settings. A03’s `Open model settings` button shortens the path from Account; A09’s `Customize` action helps users understand the Information pane. **Negative:** top-left workspace label is truncated to `ZenX Desi…`. Severity P3.
- **B: 2, high.** B01/B02 also show the pinned Chinese-titled thread and its source label; do not treat it as missing. The main route/thread list remains visible. However, B03 omits the direct `Open model settings` button. B09 retains `Customize` but omits A09’s Information label and empty-state copy. B’s last project thread source label is obscured by the fixed footer. **Negative:** the top-left workspace label remains truncated to `ZenX Desi…`. Severity P2.
- **Preference and falsifier:** A. B would improve if the direct model action and Information customization action are visible elsewhere with an equally short, clear path.

### 7. Interaction feedback and state integrity

- **A: N/O, high.** A02/A08 show a composer marked `Read only`, a muted send arrow, and `Worked for 0s`; A09 shows an explanatory empty Information state. These are visible snapshots, not proof that draft/sending/pending/failed/accepted transitions are truthful or recoverable.
- **B: N/O, high.** B02/B08 show the same visible Read only/composer/message context, but B09 retains a visible `Customize` action while omitting A09’s Information heading and empty-state explanation. Still images do not test repeated actions, cancel/back, late responses, unsaved changes, unavailable-source transitions, or actual send behavior.
- **Preference and falsifier:** no supported preference for dynamic state integrity. A09 is clearer in the visible empty state. Next check: exercise draft → send → pending → success/failure and cancel/retry in both candidates; verify visible labels and the empty Information state match actual conditions.

### 8. Composition and responsive behavior

- **A: 3, medium.** At 1188×848, A01–A08 maintain clear pane boundaries and alignment; the composer remains within the main chat area. A09’s composer border spans about x=289–799 (~510 px), consistent with the central conversation column; the Information pane occupies the right side. **Negative:** the sidebar title truncation remains. Severity P3.
- **B: 2, medium.** B01–B08 retain the same horizontal structure, but the PAW card reduces the sidebar’s vertical budget so the last `Local demo` line runs into the fixed footer. B09’s composer is also about x=289–799 (~510 px), not unusually narrow; its Information pane retains `Customize` but omits A09’s Information heading and explanatory text. No narrow-window or reflow state was supplied. Severity P2 for sidebar clipping.
- **Preference and falsifier:** A at the tested viewport. Falsified if B’s bottom source label is fully accessible by a clear scroll/overflow affordance without obscuring the footer. Responsive behavior below 1188 px remains N/O.

### 9. Accessibility and input robustness

- **A: N/O, high.** A01–A09 show labels for many controls and checkmarks in appearance selections, but no keyboard focus, tab sequence, screen-reader names, zoom, reduced motion, or contrast measurements. Screenshot evidence cannot establish accessibility compliance.
- **B: N/O, high.** B01–B09 show labels for many controls, but B05/B07 omit the checkmarks visible on A’s selected appearance presets and use smaller/fainter preset captions. No focus, keyboard, screen-reader, zoom, or motion evidence is supplied.
- **Preference and falsifier:** no supported overall accessibility score. A has the stronger visible non-color selected-state cue in Appearance. Next check: keyboard-only traversal and focus visibility for navigation, settings controls, composer icons, and the PAW CTA; screen-reader labels and measured contrast for muted metadata and selected states.

### 10. Cross-surface consistency and product fit

- **A: 3, medium.** A03–A06 maintain a readable Settings hierarchy and direct account-to-model action; A05/A07 show explicit selected preset checkmarks and larger descriptors; A09’s Information empty state explains what is missing and how to customize it. Dark/light states in A07/A08 preserve the same overall layout. The unframed PAW block is the main visual outlier. Severity P3.
- **B: 2, medium.** B’s PAW card and blue CTA are more consistent with existing Settings cards and actionable controls. However, B03 drops the `Open model settings` shortcut, B05/B07 reduce appearance selection cues and caption legibility, and B09 retains the `Customize` action but omits the Information heading and empty-state explanation shown in A09. Severity P2.
- **Reference fit:** the Linear comparison supports deliberate spacing and quiet inactive rows; Geist docs demonstrate purposeful color tokens. The T3 screenshot is a published product image, not evidence of an independently operated flow. B’s card/accent direction fits ZenX’s existing surfaces, but product fit also requires preserving the existing settings and Information cues; no imitation of another product’s multi-agent panel or runtime behavior is warranted.
- **Preference and falsifier:** A overall for cross-surface completeness, while B wins on PAW grouping/material. This would change if the omitted direct actions/empty-state guidance are intentionally out of scope and users still find the relevant destinations without extra navigation.

## Five priority findings

1. **P3 — B09’s Information pane omits A09’s empty-state heading and explanation.** **Target:** A09 vs B09, far-right pane beneath `Close information`. A09 shows `Information`, the `Customize` action, and “Information appears here when available. Use Customize to show or add components.” B09 still shows `Customize` (around x=1114, y=182) but omits the `Information` label and explanatory copy. **Trigger:** open the Information pane in the supplied empty state. **Consequence:** users retain a visible customization path but get less context for the otherwise empty pane. **Change:** restore the heading and empty-state explanation while preserving the visible Customize action. **Verify:** recapture the same state and confirm the label, explanation, and action are all present.
2. **P2 — B03 removes the direct model-settings action.** **Target:** A03/B03 account card. A03 shows `Open model settings` at the right of `Connect an account`; B03 leaves that area empty while the subscription is still `Not configured`. **Trigger:** open Account with no subscription configured. **Consequence:** the direct next step is less discoverable and requires navigating to Models & provider. **Change:** restore the direct action or an equally clear visible route. **Verify:** compare the same account state and confirm the route is reachable from the card.
3. **P2 — B07 weakens selected preset and descriptor cues.** **Target:** matched dark appearance pages A07/B07. A07 shows checkmarks on the Graphite chips for both Light and Dark presets, plus readable Neutral/Cool/Warm descriptors; B07 shows outlined chips without checkmarks and much smaller/fainter descriptors. **Trigger:** inspect or change appearance presets in dark theme. **Consequence:** selected state depends more on subtle outline/fill and preset distinctions are harder to scan. **Change:** keep a non-color selection mark and restore legible descriptors. **Verify:** rerender both dark and light states at 1188×848 and check that selected presets are identifiable without relying on color alone. A05/B05 are not state-matched (Light vs System), so use A07/B07 for direct comparison.
4. **P2 — B’s persistent PAW card reduces sidebar height.** **Target:** B01/B02 and shared sidebar in B03–B09, especially the `Release checklist` row above the fixed Settings footer. **Trigger:** any route with the PAW card mounted at 1188×848. **Consequence:** the thread title remains visible, but its `Local demo` source line is obscured. **Change:** compact the card, make it collapsible/contextual, or reserve more visible/scrollable sidebar space without removing project/thread navigation. **Verify:** rerender all routes at 1188×848 and confirm the full last row and footer are independently visible or clearly scrollable.
5. **P3 — B’s PAW CTA may compete with the current task when persistent.** **Target:** B02–B09, where the same blue `Set up your PAW` action remains in the sidebar during thread and settings views. **Trigger:** users are trying to read a thread or change settings rather than set up PAW. **Consequence:** an unrelated setup action may attract attention; screenshots do not prove this happens. **Change:** consider making the card contextual or dismissible only if task observation confirms competition. **Verify:** ask users to find the selected thread, model settings, or Information customization action while the card is present.

## Three strengths to preserve

- Settings are easy to scan: clear Settings heading, text-labeled categories, page titles, and bounded control groups (A03–A06/B03–B06).
- B’s PAW card groups its heading, explanation, and setup action; its blue CTA is much easier to notice than A’s outline CTA (A01/B01, A02/B02).
- A’s Appearance controls show explicit checkmarks and readable preset descriptors, while A09’s Information pane explains its empty state and offers Customize. Preserve these visible state/context cues.

## Recommended next iteration and non-goals

1. Keep B’s clearer PAW grouping and CTA, but reduce its persistent sidebar height so all thread/source rows remain visible.
2. Restore A03’s direct Open model settings action and A09’s Information heading/empty-state explanation in B, preserving B09’s visible Customize action.
3. Preserve A07’s checkmarks and legible preset descriptors in the dark Appearance page. Recapture A05/B05 under the same selected theme before comparing that state.
4. Test keyboard focus, accessible names, contrast ratios, and a narrow viewport before scoring those claims.

Do not remove text labels or flatten selected/action colors into a single neutral treatment. Do not hide pinned or project/thread navigation to make room for the card. Do not change scroll/pending semantics based on these stills, and do not claim delivery, persistence, accessibility, or contrast success from screenshot evidence alone.

## Correction record (added after pixel recheck)

- An earlier full-size read missed the pinned Chinese-titled thread in B01 and the conversation body in B09. Crops of the original pixels confirmed both are present; those false claims were removed.
- A later read initially estimated the A09/B09 composer as x≈289–543 (~254 px). Reopening the originals and enlarged composer crops shows both borders at approximately x=289–799 (~510 px); the alleged narrow-composer issue was false and has been removed.
- The B09 Information pane is not fully blank: it contains `Customize` (around x=1114, y=182), but lacks A09’s `Information` heading and explanatory empty-state copy. Earlier wording that said Customize was absent is superseded by this pixel recheck.

- Latest recheck of original B09 pixels confirms the `Customize` action is present at about x=1114, y=182. Only the `Information` label and empty-state explanatory copy are absent; severity for that localized omission is revised from P2 to P3.

# Independent blind paired ZenX UI audit

## Result first

A is preferable for the observed hierarchy, semantic selection cues, small-label readability, attention allocation, and account navigation. Its most concrete advantages are checkmarks and larger explanatory labels in Appearance, a direct Account → model-settings action, and a useful Information-panel empty state. B makes PAW onboarding more explicitly grouped and more conspicuous, which is a real advantage when onboarding is the task, but that same treatment competes with conversation and settings tasks and consumes more sidebar height.

The main conversation layout, composer, most settings surfaces, and selected navigation treatment are substantially the same. There is no evidence here that either candidate delivers messages, preserves Forks, handles pending work, or supports keyboard and assistive-technology users better. Those questions remain unobserved. There is no aggregate score and no inferred intended winner.

## Scope and frozen evidence

- Reviewed the supplied `blind-review/scope.md` and `rubric.md` before reviewing images. Used the rubric's absolute 0–4 anchors: 0 broken, 1 weak, 2 adequate with important friction, 3 strong with localized issues, 4 exemplary within the observed scope.
- Inspected every original image through `view_image`: A and B of 01 Welcome, 02 Thread, 03 Account, 04 Models, 05 Appearance light, 06 General, 07 Appearance dark, 08 Thread dark, and 09 Information. A/B order alternated between groups to reduce first-candidate anchoring.
- Inspected all three specified official reference images through `view_image`. No earlier reviews, research reports, agent outputs, source, or commit messages were inspected. No product edits were made.
- Scope identifies the product renders as native Electron 43.2.0, identical synthetic conversation content, 1188 × 848. I accept that provenance as supplied, rather than claiming independently to have operated these states. Metadata inspection confirms 1188 × 848 for all 18 product images. Although named `.png`, all 21 image files decode as JPEG; they were not altered for this review. Tiny-text and color judgments therefore concern these delivered images, not exact source CSS or measured display contrast.
- Frozen byte manifest: `/workspace/shared/ui-quality-evidence/review-pair-astra-evidence.sha256`. SHA-256 of that manifest: `81518a0fe13ee99daaafb3589b4b4c587ebd32c35ae94ded2860e8525231d3d1`. It records the scope, rubric, 18 product images, and three references. The manifest makes this report specific to the reviewed bytes rather than filenames alone.
- Image references below use `A/05`, for example, for `blind-review/A/05-settings-appearance.png`. Coordinates are approximate original-image pixels, origin top left; rectangular ranges are x then y. They locate visible evidence, not measurements of interactive hit areas.

### Important controls and limits

- Ignore timestamp, spinner, and hover differences, as instructed. In particular, the ellipsis visible on some selected thread rows is not treated as a navigation regression.
- A/05 selects **Light** while B/05 selects **System**, with a corresponding enabled/disabled Reset difference. These are different captured configuration states; they do not prove a Reset or theme-persistence defect. Both dark screenshots select Dark.
- A/09's larger information card contains more text. Extra height is not a composition defect by itself.
- Partly visible conversation content above the viewport is compatible with normal scrolling. General's lower card extends beneath the bottom viewport/footer; the stills do not establish that scrolling is broken or that this content is unreachable.
- N/O: full-app narrow viewport, sidebar collapse/transition, keyboard focus order, focus styles, actual hit targets, screen readers, contrast ratios, reduced motion, actual account connection, source failure, send/accept/deliver states, pending/queued/running/failure transitions, unsaved-change behavior, cancel/back behavior, real agent communication, Fork presentation and persistence. The Information panel supplies one narrower conversation-column state, not a responsive-device test.
- Confidence refers to the stated evidence and score within the observed scope. Missing behavioral evidence is not silently converted into a pass or a failure. Scores for state integrity and accessibility are explicitly provisional visual scores, not full functional ratings.

## Reference calibration, not imitation

1. **T3 published product image** (`t3-published-product-20261109.png`): the left sidebar separates Working and Settled; an activity line and right-side agent/task panel distinguish conversation from execution context. This is useful evidence for meaningful grouping and named work states. It is a marketing image, not a validated interaction or proof that ZenX needs this panel structure. Its dark palette and small text are not automatic quality targets.
2. **Linear official historical comparison** (`linear-published-comparison-20261109.png`): the published comparison explicitly labels refined icons, muted inactive text, and vertical padding. It supports deliberate active/inactive hierarchy, not indiscriminate dimming or extra padding everywhere. B's additional sidebar height demonstrates why padding has a navigation cost at a fixed viewport.
3. **Vercel Geist documentation** (`vercel-geist-docs-20261109.png`): clear heading/body scale, restrained component borders, consistent icon language, and a visible range of semantic colors. It supports clear typography and coherent components while showing that useful color need not be eliminated. Documentation composition does not establish product-task performance.

None of these references supplies a numerical benchmark score or justifies replacing ZenX's task, permission, or pending-work semantics.

## Dimension scorecard

| Dimension                                     |   A |   B | Preference within observed scope                       | Confidence A / B |
| --------------------------------------------- | --: | --: | ------------------------------------------------------ | ---------------- |
| 1. Information hierarchy and grouping         |   3 |   2 | A; B better for isolated PAW onboarding grouping       | High / High      |
| 2. Color purpose and semantic accuracy        |   3 |   2 | A                                                      | Medium / Medium  |
| 3. Surface and material consistency           |   3 |   3 | Tie; localized tradeoff                                | High / High      |
| 4. Readability and density                    |   3 |   2 | A                                                      | High / High      |
| 5. Attention allocation                       |   3 |   2 | A for the shown conversation/settings tasks            | Medium / Medium  |
| 6. Navigation and discoverability             |   3 |   2 | A                                                      | Medium / Medium  |
| 7. Interaction feedback and state integrity   |   2 |   2 | A for visible empty-state explanation; behavior N/O    | Low / Low        |
| 8. Composition and responsive behavior        |   3 |   3 | A slight desktop-density advantage; responsive tie/N/O | Medium / Medium  |
| 9. Accessibility and input robustness         |   2 |   2 | A for visible readability/non-color cues; input N/O    | Low / Low        |
| 10. Cross-surface consistency and product fit |   3 |   3 | A slight task-fit advantage; core visual system tied   | Medium / Medium  |

The same issue can affect more than one dimension for different reasons. These ratings must not be summed into an aggregate that would count it repeatedly.

### 1. Information hierarchy and grouping

**A: 3, high confidence.** Positive: in A/02 and A/08, conversation title and project path occupy the fixed header (x286–520, y50–82); the response heading, list, decision, quote, and code retain distinct typography (x300–1141, y338–666). Settings has a clear global sidebar, section navigation, and main heading in A/03–07. A/09 labels the side card “Information” and explains the empty state (x850–1158, y177–246). Negative: PAW's explanatory text remains permanently interleaved above Rooms and Projects (x20–236, y273–368), and repeated “Local demo” lines take substantial navigation space. Severity P3 in A.

**B: 2, high confidence.** Positive: the PAW card (x16–238, y266–396) more clearly groups its title, explanation, primary action, and Later action; the response hierarchy is otherwise intact. Negative: the filled PAW CTA and bordered card compete with selected conversation/settings navigation despite being a secondary task. B/09's side card (x836–1176, y100–214) presents Close information and Customize without an information heading or empty-state explanation. That is an important disclosure gap, not merely a sparse aesthetic. Severity P2.

**Preference and falsification:** A for ongoing work; B for an onboarding-only task. Give B/09 an explicit, truthful empty-state label and subordinate the persistent PAW CTA outside onboarding. A no longer has a hierarchy advantage if matched task tests show equal understanding of the information card and no diversion to onboarding. Preserve B's clear grouping if it can be achieved without equivalent attention and height cost.

### 2. Color purpose and semantic accuracy

**A: 3, medium confidence.** Positive: selection uses the same blue family in Appearance (A/05, A/07, x497–1147, y262–644), while selected preset and accent cards also carry checkmarks at approximately (583,460), (913,460), and (688,551). The destructive Delete action is separately red and explicitly labeled in A/04 (x1093–1148, y460–492). Negative: the System/Light/Dark row and Standard/High row still indicate selection principally through border/tint; they lack the checkmark cue used by neighboring cards. Color-only discrimination and contrast remain risks, not measured failures. Severity P2 for the incomplete selection-cue pattern.

**B: 2, medium confidence.** Positive: the same action/selection palette and labeled Delete treatment are present; the blue PAW button is a real action rather than decorative color. Negative: B/05 and B/07 do not show the preset/accent checkmarks, leaving all these selections more dependent on the blue outline and fill. The very small subtitle text further weakens differentiation. Severity P2.

**Preference and falsification:** A, because additional shape cues have semantic value. Add a consistent checkmark or equivalent persistent selected marker to every mutually exclusive choice group, without changing the saved value. Verify selected options remain unambiguous in grayscale and that accessible checked/selected states agree. Error, waiting, and complete state color semantics remain N/O; seeing those states could materially change either score.

### 3. Surface and material consistency

**A: 3, high confidence.** Positive: account/model/appearance/general cards share subtle borders and rounded corners (A/03–07 main column x478–1166); inset selects and tiles are distinct from their parent surfaces. Dark chat's composer (A/08, x305–1147, y722–831) remains visibly separate from the canvas and code panel. Negative: the large rounded composer, small rectangular settings choices, and thin code headers create several border/radius families; their roles are mostly understandable, but the visible surfaces do not establish a fully resolved component rule. Severity P3.

**B: 3, high confidence.** Positive: the same coherent light/dark system is present. Its PAW card uses the existing inset-card vocabulary rather than introducing an unrelated material. Negative: that extra bordered container repeats an enclosure around a small group already introduced by a section heading, adding local visual weight. It is not a global material-system failure. Severity P3.

**Preference and falsification:** tie on material consistency. A is less enclosed; B more explicitly grouped. A component inventory should verify equivalent controls share border, radius, elevation, and disabled rules across themes. Evidence of mismatched menus/dialogs or inconsistent equivalent controls would change the tie; those surfaces are currently N/O. Do not flatten useful inset/raised distinctions merely to remove borders.

### 4. Readability and density

**A: 3, high confidence.** Positive: Appearance subtitle words “Neutral,” “Cool,” “Warm,” “Clear blue,” “Soft violet,” and “Fresh green” are plainly distinguishable in A/05 and A/07 (x507–1110, y471–562). Chat body/list/code are legible and unclipped within the column in A/02 and A/08. Negative: the provider row's “Local demo,” “fake,” “Default,” and “Title” chips are still very small in A/04 (x631–1041, y460–484). The long sidebar thread title is ellipsized at x20–232, y589–599; full-title recovery is N/O, so truncation itself is not called a defect. Severity P3 for the persistent tiny chips.

**B: 2, high confidence.** Positive: chat, settings headings, and form labels retain the same readable scale. Negative: B/05 and B/07 compress the preset and accent subtitles to visibly tiny text at approximately y477 and y558, despite ample tile height. This is repeated across nine choices rather than an isolated badge. The same provider-chip issue remains. Severity P2 for appearance-choice subtitles.

**Preference and falsification:** A. Keep explanatory text at the larger A scale and verify all named subtitles are readable at native display scaling in light and dark themes, including a higher-scale/zoom capture without clipping. Native rendering that demonstrates the apparent subtitle difference is an image artifact would falsify this preference. No specific CSS font-size or contrast ratio is inferred from the image.

### 5. Attention allocation

**A: 3, medium confidence.** Positive: active conversation content and the composer remain the main workspace landmarks (A/02, A/08). PAW setup is still visibly actionable but uses an outline action (x20–137, y336–369), reducing unrelated emphasis during work. Negative: onboarding remains high in the sidebar even in settings and information contexts, and an empty welcome canvas does not offer a concrete sample next step beyond the composer. The latter is a limited onboarding observation, not proof of task failure. Severity P3.

**B: 2, medium confidence.** Positive: B/01 makes PAW setup particularly easy to locate. Negative: the saturated setup button (x29–138, y347–383) is among the strongest accents in B/02, B/03, B/06, B/08, and B/09, even though their current tasks are elsewhere. In B/04 it also competes with Add custom provider, a relevant main-panel action (x1030–1166, y392–431). Different-importance elements therefore receive similar emphasis. Severity P2 for the shown established-work routes.

**Preference and falsification:** A for these tasks, with B's onboarding salience retained as a potential first-run advantage. Test locating the next conversation/provider action with PAW unconfigured. If B improves onboarding without delaying or distracting from those tasks, the attention preference should be narrowed or reversed. Do not hide real pending/failure states to achieve a calmer image; none are proven by these stills.

### 6. Navigation and discoverability

**A: 3, medium confidence.** Positive: selected global/section rows are visibly distinct and accompanied by labels. A/03 provides “Open model settings” beside the connection instructions (x1011–1147, y246–284). A/09 pairs a visible Close information action with a clear Information heading and explanation that Customize adds components. Negative: the global sidebar's small top utility icons and thread-header icons remain unlabeled in the stills; hover labels and keyboard discovery are N/O. The section label “Models & provider” differs from the page heading “Models & providers” (A/04, x325–450 versus x478–691), a minor naming inconsistency. Severity P3.

**B: 2, medium confidence.** Positive: the same thread/project/section structure and selected states are visible, and PAW setup is easy to find. Negative: B/03 tells the user to add a subscription in Models & provider but omits A's direct action in the otherwise equivalent account card. Users must infer that the left-side settings section is the route. B/09 gives Customize without explaining what can be customized. Severity P2.

**Preference and falsification:** A. Verify A's button actually reaches the named settings destination and that return navigation retains context; the still only proves the affordance exists. The preference is falsified if that button is nonfunctional or the matching B state has an equally direct, accessible route not represented in this evidence. Align singular/plural naming and verify icon labels rather than changing core navigation.

### 7. Interaction feedback and state integrity

**A: 2, low confidence; visual states only.** Positive: Account explicitly says “Not configured” and explains why usage is unavailable (A/03, x497–1148, y188–432); General pairs “Blocked” text with an off toggle (A/06, x1092–1139, y658–746). Models/General show “Your settings are up to date” with a visually inactive Apply in their footers. A/09 explains the Information empty state. Negative: that message says information appears “when available” without establishing whether it is truly empty, loading, unsupported, or unavailable. The exact runtime distinction is N/O. Severity P2 if these states are conflated; not a demonstrated runtime bug.

**B: 2, low confidence; visual states only.** Positive: the same account, blocked-toggle, and settings-footer labels exist. Negative: B/09 provides no visible account of why the information region is empty, so its visible uncertainty is greater. Severity P2 for the missing explanation. Draft/sending/accepted/pending/running/failed distinctions cannot be scored behaviorally for either candidate.

**Preference and falsification:** A for the explanation only; no behavioral preference. Capture controlled empty, loading, unavailable, and failed Information states, then run send/queue/cancel/late-response/unsaved-change checks. A's generic copy should not replace error or loading states. A trace showing hidden failure under that message would falsify its apparent benefit. Spinner and timestamp differences were excluded entirely.

### 8. Composition and responsive behavior

**A: 3, medium confidence within desktop scope.** Positive: at 1188 × 848 the main settings and chat columns align consistently. A/09 reduces the conversation/composer to roughly x288–799 and places information at x836–1176 without visible overlap; paragraphs wrap and code stays contained. Negative: General's final explanatory text extends below the footer boundary (A/06, y789), requiring scrolling whose reachability is unobserved. The full-app narrow layout is N/O. Severity P3 geometry/check item, not a proven clipping bug.

**B: 3, medium confidence within desktop scope.** Positive: the same information-column reflow and settings alignment are present. Negative: the PAW card adds about 20 px before Rooms/Projects; for example, the selected project thread starts at y540 in B/02 versus y520 in A/02. The last visible Release checklist row's source line is cut by the sidebar/footer boundary near y798, whereas A shows it around y781. This is less first-viewport capacity, not proof the item cannot be reached. Severity P3.

**Preference and falsification:** slight A advantage for desktop sidebar efficiency, not enough to cross the anchored score boundary. Preserve natural scrolling; do not shrink all text to fit or reset scroll positions. Test minimum supported width, 200% scaling, sidebar collapse, both information-panel states, and scrolling the last General control/last sidebar row fully above the fixed footer. If B's extra height yields better grouping without practical retrieval cost, the slight preference disappears.

### 9. Accessibility and input robustness

**A: 2, low confidence; screenshot-visible subset only.** Positive: selected appearance presets/accents include non-color checkmarks (A/05 and A/07), and Delete/Blocked/Not configured use words rather than color alone. Larger subtitles make the choices easier to distinguish. Negative: theme and contrast selections lack an equivalent non-color marker; the small chips persist in Models. No focused element or keyboard route is provided. Severity P2 for incomplete visual selected-state redundancy; input behavior N/O.

**B: 2, low confidence; screenshot-visible subset only.** Positive: labeled form controls, section labels, and the same explicit status words exist. Negative: missing preset/accent checkmarks and tiny explanatory text create additional visible risks in B/05 and B/07. The PAW button looks larger/stronger but actual clickable geometry and accessible name are untested. Severity P2.

**Preference and falsification:** A for visible cues, with neither awarded a keyboard/AT pass. Verify focus visibility, keyboard order, radio/selected announcements, accessible names for every icon button, effective targets, contrast on source tokens/native renders, forced colors, and reduced motion. A keyboard or screen-reader failure could outweigh the screenshot advantage. No WCAG compliance or ratio claim is made.

### 10. Cross-surface consistency and product fit

**A: 3, medium confidence within represented surfaces.** Positive: chat, settings, sidebar, and information preserve the same icon/typography/color vocabulary in light and dark; account/setup and empty-information guidance follow the current task without adding a new conceptual layer. Model and permission choices remain visibly associated with the composer. Negative: naming is not perfectly consistent, and the Information empty state is more explanatory than the less contextual small model/source badges. Fork, dialogs, and several settings sections are absent. Severity P3.

**B: 3, medium confidence within represented surfaces.** Positive: the same core ZenX structure, composer semantics, settings taxonomy, and themes are preserved; the PAW container is visually consistent with the card vocabulary. Negative: unrelated onboarding retains primary-action treatment across very different tasks while Account and Information have weaker task-specific guidance. This is a local task-fit cost, not evidence that the entire visual system is inconsistent. Severity P2 for those local omissions, already tracked in findings below.

**Preference and falsification:** slight A task-fit preference, same score for the coherent represented system. Inspect an actual Fork boundary, information-filled state, provider dialog, live connection, and permission/pending flows before claiming product-wide consistency. A different runtime, changed queue policy, or invented Fork representation would invalidate a purely visual improvement. The published references do not justify those changes.

## Five priority findings

### 1. Make appearance-choice explanatory text readable

- **Severity:** P2 in B; A substantially resolves the observed issue.
- **Exact target:** B/05 and B/07, preset subtitles x507–1110/y474–481 and accent subtitles x534–1094/y555–562. Compare A at the same cards.
- **Trigger:** selecting a light/dark preset or accent using its explanatory words rather than the color swatch alone.
- **Consequence:** tiny subtitles make distinctions harder to read even though the cards have room for larger text; the issue repeats across the chooser.
- **Falsifiable improvement:** use at least the visibly legible A-scale subtitle treatment without cropping. At native scale and 200% display/text scaling, a reviewer can identify Neutral/Cool/Warm and Clear blue/Soft violet/Fresh green in both themes, with no overlap or truncation. Check provider badges separately; do not confuse synthetic “fake” content with a production status requirement.

### 2. Keep a direct route from unconfigured Account to setup

- **Severity:** P2 in B; A supplies a relevant affordance.
- **Exact target:** Account connection card, A/03 x1011–1147/y246–284 versus empty corresponding area in B/03.
- **Trigger:** a user opens Account while no OpenAI subscription is configured and follows “Connect an account.”
- **Consequence:** B describes another settings location without providing the inline action; users must resolve the section name themselves.
- **Falsifiable improvement:** provide a clearly named action that lands in the correct model/provider setup section and preserves a way back. Test click and keyboard activation using an unconfigured test profile. The presence of A's button alone does not establish that navigation works.

### 3. Explain the Information panel's empty state without hiding failures

- **Severity:** P2 in B; A improves visible explanation but still needs runtime verification.
- **Exact target:** B/09 right card x836–1176/y100–214; A/09 adds heading and body at x850–1158/y177–246.
- **Trigger:** open Information when no content is shown.
- **Consequence:** B's empty panel offers Customize without explaining whether content is unconfigured, absent, loading, or unavailable. A tells users where content belongs and how to add components, but its generic “when available” must not mask other states.
- **Falsifiable improvement:** define distinct empty/loading/unavailable/error states and show appropriate explanation or recovery for each. In a forced empty state, the panel names itself and gives an actionable next step; in forced failure, it visibly reports failure rather than showing benign empty copy. Preserve the existing conversation width/scroll behavior.

### 4. Reduce persistent onboarding competition during established work

- **Severity:** P2 in B's shown work/settings routes; P3 residual persistence in A.
- **Exact target:** B all images, PAW card x16–238/y266–396 and filled CTA x29–138/y347–383; compare A's outline action x20–137/y336–369. Sidebar project rows shift down about 20 px in B.
- **Trigger:** the user reads an existing conversation or configures models while PAW is not configured.
- **Consequence:** unrelated setup receives primary-action salience and reduces immediately visible project navigation. Conversely, B is stronger if PAW onboarding itself is the task; that benefit should not be discarded blindly.
- **Falsifiable improvement:** retain an understandable PAW group and discoverable setup action while using secondary emphasis on established-work routes. Test first-run setup discovery and next-action location during an existing conversation/provider task. Reject the change if onboarding becomes hard to find, or if no attention/navigation benefit appears. Do not remove meaningful status or accessibility cues in the name of quietness.

### 5. Complete non-color selected-state cues consistently

- **Severity:** P2 in both; broader in B.
- **Exact target:** theme buttons x497–1147/y262–301 and Standard/High x497–613/y610–645 in A/05, B/05, A/07, B/07; also preset/accent cards in B/05 and B/07.
- **Trigger:** determining the active setting without reliably distinguishing the blue border/fill from adjacent neutral surfaces.
- **Consequence:** users receive inconsistent selected-state redundancy: A gives checkmarks to presets/accents but not neighboring theme/contrast groups; B omits those checkmarks throughout these cards.
- **Falsifiable improvement:** add an equivalent persistent non-color marker to each selected choice without changing its stored semantics. A grayscale/forced-color capture and keyboard/screen-reader check must identify the same chosen values as the ordinary screenshot. Check measured contrast separately; no current ratio is asserted.

No P1 task-blocking defect is demonstrated by this evidence.

## Regressions, unchanged problems, and tradeoffs

Because revision direction is undisclosed, these are directional risks rather than claims about which build came later.

- **If moving A → B:** lose the direct Account setup action, Information empty-state explanation, appearance checkmarks, and legible appearance subtitle scale; increase unrelated PAW emphasis and reduce sidebar first-viewport capacity.
- **If moving B → A:** PAW onboarding loses its enclosing card and filled primary CTA. The group is less explicitly bounded and could be less discoverable for a first-time user. This is the only clear visual tradeoff favoring B; its practical cost needs an onboarding task test. A's larger Information card is an intentional cost for explanation, with no observed overlap.
- **Unchanged:** small provider-profile badges, long-title ellipsis, singular/plural model-section naming, icon-only utility affordances in stills, theme/contrast selection without a checkmark, and General content requiring scroll beyond the initially visible footer boundary.
- **Unchanged strengths:** main conversation typography and code/quote hierarchy; consistent settings-card alignment; main composer placement; model and permission labels; selected navigation backgrounds; explicit “Not configured,” “Blocked,” and up-to-date settings text.
- **Not classified as regressions:** timestamp/spinner/hover differences, Light-versus-System capture state in 05, corresponding Reset availability, normal top-of-conversation clipping, or any unobserved send/Fork behavior.

## Three strengths to preserve

1. **Content hierarchy survives light and dark modes.** A/B 02 and 08 keep heading, list, decision, quotation, and code visually distinct while the composer remains in a stable lower region. The narrower column in 09 still wraps prose and contains code.
2. **Settings are organized around understandable tasks.** A/B 03–07 separate account, model defaults/provider profiles, appearance, and general controls. Explicit status words and contextual descriptions make these more than unlabeled controls.
3. **A's targeted explanatory improvements do not require a visual rewrite.** The Account shortcut, appearance checkmarks/readable subtitles, and Information empty-state message improve observed task clarity within the existing components, palette, and layout. B's coherent PAW grouping is also worth preserving where it does not overpower the active task.

## Prioritized next iteration and checks

1. Preserve or restore the concrete A advantages: appearance subtitle legibility/checkmarks, Account shortcut, and a truthful Information empty state. Complete non-color selection markers for theme/contrast controls. Keep PAW grouping understandable while testing route-appropriate emphasis.
2. Verify the direct actions and state model: Account → model setup → back; Information empty/loading/unavailable/failure/customization; settings dirty/apply/revert. Record the actual outcome, not just the visual action.
3. Exercise existing pending/queue/guide-current-reply/cancel/late-response flows, including disabled and failure states. Capture real Fork boundaries and persistence. Screenshots here do not authorize changes to these semantics.
4. Run geometry/input checks at supported narrow widths, higher scaling, sidebar transitions, and expanded Information. Scroll General and the sidebar to their ends; ensure controls and explanatory text can clear fixed footers. Test keyboard and assistive technology, names/selected states, focus visibility, effective hit areas, forced colors, measured contrast, and reduced motion.
5. Repeat the paired review with frozen matched states, including identical theme selection and no transient hover differences. Retest first-run PAW discovery before accepting reduced onboarding salience as an unqualified improvement.

### Changes that must not be made on this evidence alone

- Do not alter existing conversation scroll anchoring, user scroll position, pending/queued-message handling, guide-current-reply behavior, or permission semantics to make stills look cleaner.
- Do not remove failure, uncertainty, blocked, or unavailable states; generic empty copy is not a substitute.
- Do not invent Fork persistence, real delivery, sign-in success, or accessibility claims from these screenshots.
- Do not suppress useful color, shrink content to avoid scrolling, or imitate the T3/Linear/Geist reference compositions without a ZenX task reason.
- Do not treat the Light/System capture mismatch, spinner/timestamp/hover differences, or partial scroll view as proven product regressions.

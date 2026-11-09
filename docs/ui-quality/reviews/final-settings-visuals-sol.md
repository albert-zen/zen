# Independent ZenX Settings and short live-reading evidence review

## Verdict and scope

No P1 task blocker or P2 material problem is demonstrated in the **final observed `bebe9276` numeric-input and short live-reading states**. The supplied final run supports recovery from native incomplete numeric input and a bounded hold/switch/sidebar/follow/Stop journey. This is not a claim that every Settings journey was repeated on that version or that the application passed full acceptance. Stop success is supported; generated-body retention after Stop, completeness of all 88 emitted chunks, persistence and restart recovery are **N/O**. The “Progress kept” text is a UI claim, not proof of those outcomes.

Two small presentation concerns are visible in the earlier `4893830a` Settings captures: truncated closed-state provider/model identities and a generic “Settings saved” toast while other settings remain unsaved. They are P3 polish concerns, not evidence of failed persistence. The final version has not been freshly pictured in those provider states. They must not be reported as newly reproduced final-source defects.

Reviewed independently: repository `AGENTS.md`; the Settings, message/composer/live-following, responsive/focus and continuing UI-acceptance rules in `apps/zenx/docs/ui-ux.md`; and `docs/ui-quality/rubric.md`. No other reviewer report, previous score, or code-author implementation summary was read. The evidence order was original screenshot pixels first, then the supplied native-validation narrative and field-only assertions. I did not operate the app, run tests, rebuild, or alter code/docs.

The numeric scores below use the fixed anchors: 0 broken, 1 weak, 2 adequate, 3 strong, 4 exemplary **within the stated observed scope**. Unseen behavior is N/O, not an inferred pass or a numerical penalty. No overall or averaged score is supplied.

## Immutable evidence identity and verification

All native evidence used is within `settings-native-public-allowlist.json`, exactly 42 files. I independently computed SHA-256 and byte lengths for all 42 and checked all 35 listed original screenshots with an image decoder: **all match; all are JPEG, 1188 × 848**. The 35 files contain 33 distinct image hashes. I viewed every original. In particular, I17/I19 have identical bytes, as do I04/I33; duplicated pixels are not independent proof of the different action sequences attributed to them.

- Manifest: `settings-native-manifest.json`, SHA-256 `10197f7a07a5e3d7405630021eca20d279e7b482fd80c4dfbafbd576f566e77a`.
- Public allowlist: SHA-256 `fb867c6a7a1baf665e2abe68618518a7edb72b5475c560003edc21ad134b20fd`.
- Operator narrative: `settings-native-validation.md`, SHA-256 `a534fb7a64bbaeb4d962ac6dcaea906de073e01a67714425e41b7f9201859328`.
- Platform/window: native Linux Electron 43.2.0, light theme; English except the explicitly Chinese capture I03. Synthetic isolated local FakeModel data, no actual sign-in or remote provider. The live sequence uses a controlled text-only stream.

Keep these source stages separate:

1. **Before:** `58df4ea3852e4826d3aa31a931c3383258bc0c47` (I32–I35). I32 shows “Unavailable selection” after the operator's independent provider save; I34 shows a numeric error while Apply is still enabled. These are baseline failures.
2. **First combined:** `4893830a2139e074e9091d5d5a22651bb9e03032`, tree `a60532bbfb805d4b17abb761e33ff05062a78fa8` (I01–I16). It provides the provider/draft/locale journeys but also the genuine **stale numeric error after direct clearing**, I07. That screenshot is a failed recovery branch, not a successful final result.
3. **Corrected combined:** `bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`, tree `746ff97626902500d8ae5f73cba6d706a4da9910` (I17–I31). Manifest build fingerprint `8ac22504f95551ccea66697bfff73af820adfeb77d43a5586c3f2f60a3c01d52`, renderer `index-DJHKR4sn.js`. The numeric/live final findings refer to this stage.

I independently verified the two combined Git tree IDs. Git-object hashing also confirms that Settings production checkpoint `1ebcb0501f0e5f3d8886b6e8288921adff78fb68` and `bebe9276` contain identical `SettingsView.tsx` SHA-256 `2d48a680ad3e9bd9a989bf53b1f31956a99478ada6a0664d9284dd33c957401f` and `settings-interaction.test.ts` SHA-256 `02c645b9d51c350a5a351015b200505ec38ca0542f43e28272ac611cf2e7360d`. Those match the manifest. This verifies the stated Settings-file linkage, not that the entire two trees are identical. Build provenance and reported test results remain supplied operator evidence, not an independent rebuild or test run.

### Evidence classes

- **Pixels:** displayed text, geometry, selected/focus/error/disabled appearances and visible checkpoint locations.
- **Operator observations:** navigation actions, keyboard sequences, blur, duration, ongoing generation, cancellation, and which actions preceded captures.
- **Field-only/derived assertions:** persistence and Stop facts from the allowlisted JSON extracts. I checked these extracts, not private profiles, raw Trace, runtime logs or authentication files.

Official T3, Linear, Geist and Codex images named in the assignment were also viewed. They inform narrow questions about hierarchy, muted navigation and composer grouping only. They are published product/Docs material, not live competitor audits. The Codex original is a historical new-thread window published in the February 23 article, not a Settings screen or a verified current build. No competitor score or relative ranking is made.

## Flow evidence, in sequence

1. **Account → Models: healthy as reported on `489`.** I01 shows the Models destination and selected section. The operator says an unconfigured Account's “Open model settings” navigated there without authentication. The initial Account screen/action itself is N/O in pixels.
2. **Section and routed-page draft retention: healthy as reported on `489`.** I04 displays the Queue choice after the reported Models → New thread → Settings return. A single screenshot alone would not prove retention.
3. **General invalid input and cross-section blocking: healthy on `489`, with a separate clear failure.** I05 has zero, explicit whole-number error and disabled Apply; I06 shows the named General error in Models. I10/I11 show minus/error across the reported section round trip. I07 genuinely retains an error after the visible field is empty. I08/I09 show the different valid-number/then-clear workaround, not proof that direct clear worked.
4. **Provider validation, cancel and unrelated drafts: healthy as reported on `489`.** I15 shows linked summary plus field error. I12 shows the saved `fake` ID and a focused display-name field after the reported Cancel/Enter reopening. I13/I14 show max 12 and Queue retained after independent provider save. I16 shows provider completion alongside a still-dirty global footer. The three relevant persistence extracts support that provider save alone changed revision/name, then Apply committed Queue and max 12.
5. **Apply and locale: healthy as reported on `489`.** I02 shows saved/up-to-date feedback; I03 shows Simplified Chinese and the Queue choice. The immediate language change and English return are operator observations. No translated numeric-error or provider-editor state is shown.
6. **Corrected numeric input: healthy in final observed `bebe` states.** I21 and I18 show actual minus and incomplete `1e`, each with an explicit error and disabled Apply. I19/I17 show empty fields without that error and enabled Apply, attributed to direct clear by the operator. I20 shows valid 18; I22 shows saved/up-to-date. `persisted-final-numeric-apply.json` records revision 1, Queue, explicit provenance true and max 18.
7. **Short live following/held reading: healthy within the final text-only sequence.** I26/I24 show advancing checkpoints 7/16. I28/I27 keep Reading checkpoint 28 at the same vertical location. The supplied timestamps/derived assertions establish a 16.773-second interval and emitted checkpoints 30/40 during it. I30/I29 show the same reading checkpoint after the reported switch-return and sidebar collapse.
8. **Resume and Stop: healthy within that final sequence.** I23/I25 show checkpoints 71/87 after the reported Back to live action. I31 visibly says “Stopped · Progress kept.” and has the idle composer. The derived assertion attributes `model_interrupted` after 88 chunks and `turn_aborted`/“Interrupted by user”; those execution facts are not inferred from the screenshot. The operator additionally confirmed that I23/I25 are pre-Stop body captures; after Stop only the stopped label, collapsed Activity and idle composer were checked. Activity was not expanded. Neither the label nor interruption receipts prove that the streamed body remains available, that all 88 chunks were persisted, or that a restart recovers it. Those outcomes are **N/O**.

## Ten-dimension scorecard

### 1. Information hierarchy and grouping — **3/4**, high visual confidence

**Positive:** I01 separates selected Settings section, page heading, Default models and Provider profiles. I15 nests the catalog inside the provider editor and puts the linked error summary above the field. I28 keeps “Worked for”, message content and metadata subordinate to the reading text. I22 reserves the bottom bar for host Apply state.

**Negative:** In I16 the top-right global-sounding “Settings saved” competes with the bottom “Unsaved changes across settings” message, although they refer to different scopes. It takes an extra reading step to reconcile them. **Severity: P3**, observed on `489`, not newly confirmed on `bebe`.

**Falsifiable next check:** Save only a provider with a dirty General draft. Feedback should explicitly name the saved provider scope while the footer continues to identify unsaved host changes. If the user can already retrieve that scope unambiguously from a visible label omitted in I16, this concern is falsified.

### 2. Color purpose and semantic accuracy — **4/4 within displayed states**, high visual confidence

**Positive:** I15 uses red tint, warning icon and explicit linked text together; I18/I21 use error text, not color alone. I01 has a labeled red-outline Delete action, not a green connectivity claim; the fixture states “Local testing.” I22 couples the saved toast with a check mark and words. I26 versus I31 distinguishes the red Stop square from idle Send and explicitly labels the stopped outcome. Blue marks available primary actions, while a selected Settings section uses a quiet surface and border.

**Negative:** No semantic-color contradiction is demonstrated in final observed states. **Severity: none demonstrated.** Actual contrast ratios, forced colors and other themes are **N/O**; this score is not WCAG certification.

**Falsifiable next check:** Measure the actual enabled/disabled/error/focus tokens against their rendered surfaces. A failed required text/control contrast or a status distinguishable only by color would change this assessment.

### 3. Surface and material consistency — **4/4 within the sampled surfaces**, high visual confidence

**Positive:** I01/I14/I22 share restrained canvas, rounded pale cards, inset controls and fine borders. I12/I15 make the active provider editor stronger than its inner catalog, without making every model row a heavy card. I28/I29 use the same light material family for the user bubble and composer, with a stronger composer outline appropriate to input. Back to live is a compact floating control rather than another large panel.

**Negative:** No inconsistent radius, clipping seam or accidental elevation is demonstrated across these sampled surfaces. **Severity: none demonstrated.** Unpictured popovers/dialog variants and other themes are **N/O**.

**Falsifiable next check:** Compare an open shared Select and the provider editor at the same theme/scale. An unrelated menu surface, mismatched equivalent control border or focus clipping would falsify this bounded consistency finding.

### 4. Readability and density — **3/4**, high visual confidence

**Positive:** I14 groups labels with immediately adjacent help; I03's Chinese layout wraps within the content column. I18's invalid value/error remains readable. I27's reading text has clear paragraph rhythm, and the final live bottom text sits above the composer in I23/I25.

**Negative:** I01/I16 visibly ellipsize both selected-model captions and provider display names despite substantial remaining row whitespace. The only profile is still understandable here, but the complete closed-state identity is not readable. This is an unchanged **P3** limitation under the supplied long synthetic names, not proof that the menu or accessible name also truncates. Whole-name reveal is **N/O**.

**Falsifiable next check:** Use two long same-prefix provider/model labels and keyboard-open the selector. The complete unique provider and model identity must be retrievable before selection. If that is already clear in the open control or a focus-accessible reveal, the concern stays limited to closed-state polish.

### 5. Attention allocation — **3/4**, high visual confidence

**Positive:** I18/I21 place the actual correction message immediately under the invalid field and block Apply. I15 promotes actionable errors above routine catalog metadata. I27 keeps Back to live directly above the stable composer; I31 makes the stopped UI result explicit without leaving a red running action behind; generated-body retention is not visible there. There is no large success-card noise.

**Negative:** I16's generic saved toast gives temporary success emphasis while a different settings scope still needs Apply. The footer mitigates this; it does not demonstrate data loss. **Severity: P3**, same scoped-feedback concern as dimension 1, not a second defect. Motion and attention under real multi-tool output are **N/O**.

**Falsifiable next check:** After a provider-only save, confirm that the completion cue cannot be mistaken for completion of the remaining General draft, including after the toast disappears.

### 6. Navigation and discoverability — **3/4**, medium confidence

**Positive:** I01/I14 have a persistent Settings section list with icon, selected surface and page heading; global Settings remains in the lower-left navigation. I30 identifies the selected conversation on return. I29 retains a visible sidebar-restore control after collapse; the reading context remains visible.

**Negative:** The English section label “Models & provider” differs from the page heading “Models & providers” (I01, also the section label in final I22). This is minor terminology polish, **P3**, not a navigation blocker. The actual Account entry screen, selector-open state and sidebar restoration action are **N/O** in pixels; the Account→Models action is operator-reported on `489` only.

**Falsifiable next check:** Capture the initial unconfigured Account and its model-settings action on `bebe`, then its destination. The action should name the destination consistently and require no sign-in just to configure a model.

### 7. Interaction feedback and state integrity — **3/4**, medium confidence overall; high for displayed final numeric states

**Positive:** The before/final contrast is substantive, not cosmetic. I34's enabled Apply with invalid zero is replaced by disabled/error states I05/I06; I07's stale-error clear is replaced by I19/I17. I20/I22 plus the field-only final extract support valid correction and persistence. The `489` provider extracts distinguish independent provider save from host Apply. I27–I31, together with attributed operator/assertion evidence, support held reading, explicit resume and actual interruption in one bounded run.

**Negative:** I16's provider completion wording remains less precise than its distinct save scope (**P3**). Fresh `bebe` provider/cancel/locale repetition is **N/O**; screenshots cannot establish response ordering, request-time edits or concurrent-client behavior. Component-test claims in the narrative do not make those native observations.

**Falsifiable next check:** Repeat the provider-only save with unrelated General drafts on the exact final build; read the field-only persisted values before and after explicit Apply. Any silent commit, draft reset or stale response overwrite would be a material regression and change this score.

### 8. Composition and responsive behavior — **4/4 for the observed desktop expanded/collapsed states**, high visual confidence

**Positive:** I22 has separate global navigation, section navigation and a scrollable content area with a stable Apply bar. I26/I27 keep a contained composer and full-height transcript scrolling. Between I30 and I29, collapse recenters the bounded transcript/composer column while retaining Reading checkpoint 28's vertical location. I23/I25 place the latest visible text above the bottom input zone. Native window controls occupy the top row separately from the thread title.

**Negative:** No material overflow or unreachable core control is demonstrated at 1188 × 848. Partially cut content at the top/bottom of a deliberately scrolled viewport is not itself a clipping defect. **Severity: none demonstrated.** Narrow/fullscreen resizing, multi-column workspaces and other viewport sizes are **N/O**.

**Falsifiable next check:** At this same desktop size, grow the composer while held on a known reading anchor; verify the anchor and Back to live remain usable without horizontal overflow or covering the last live content. Do not infer that result from the current empty-composer captures.

### 9. Accessibility and input robustness — **3/4 for sampled native input/focus**, medium confidence

**Positive:** I12 shows a clear keyboard-style ring on the display-name field. I03 shows visible Select focus; I18–I22 show robust native minus/exponent recovery with explicit textual errors. I15 has both summary and field-local validation. Cancel→Enter reopening and Escape dismissal are specifically operator-reported, rather than claimed from still pixels.

**Negative:** Full keyboard order, accessible names/descriptions, error announcements, true hit-target geometry, screen-reader output, reduced motion and measured contrast are **N/O**. This is not an accessibility-compliance score. The closed-state identity truncation in I01/I16 is a **P3** visible readability concern; whether accessible/focus paths resolve it is unobserved. No inaccessible primary action is demonstrated.

**Falsifiable next check:** On the same native Linux build, keyboard-traverse the provider form and error summary, cancel/reopen, then correct General input without a pointer. Record focus restoration and accessible error linkage; a trapped/lost focus or undiscoverable error would require a lower assessment.

### 10. Cross-surface consistency and product fit — **3/4 for General/Models/chat/sidebar only**, medium confidence

**Positive:** The observed interface respects routed Settings, independent provider editing versus host Apply, immediately described Language changes, and one stable composer primary-action location. The held reader receives an explicit Back to live action, rather than automatic bottom snapping. “Local testing” does not claim external connectivity. Provider, model and conversation settings remain distinct surfaces instead of inventing alternate runtime semantics.

**Negative:** Generic provider-success wording and singular/plural Models labels are small cross-surface terminology inconsistencies (**P3**, already counted above). Account authentication, Appearance, Plugins, Fork, information cards, other platforms and other clients are **N/O/outside this review**.

**Falsifiable next check:** Capture provider-only completion and host Apply completion on the exact final build. Their words should distinguish the same scopes that the persistence evidence distinguishes, without changing either operation's semantics.

## Defects, unchanged polish and remaining gaps

### Demonstrated historical material defects, not final failures

- **P2, baseline `58df4ea3`:** after an independent provider save, the General choice becomes “Unavailable selection” (I33→I32, attributed action; narrative reports draft loss). Separate provider save must not discard another section's draft. The subsequent `489` provider/persistence sequence addresses this; final `bebe` repetition is N/O.
- **P2, baseline `58df4ea3`:** invalid zero plus another dirty setting leaves global Apply enabled (I34). I05/I06 show blocking in `489`; final incomplete-input blocking is also visible in I18/I21.
- **P2, first combined `4893830a`:** direct clearing of native minus leaves a stale error and disabled Apply (I07). I08/I09 are only a workaround. Final I21→I19 and I18→I17, with the attributed sequence, address the direct-clear branch without an intermediate valid value.

### Remaining observed polish

1. **P3, closed provider/model identity, I01/I16 (`489`).** Trigger: long synthetic names in the closed control/row. Consequence: full identity is not readable without another reveal step. A unique-choice failure is not demonstrated with the single fixture provider. Verify with the same-prefix selector task above; do not widen every field or remove useful metadata before checking the reveal behavior.
2. **P3, provider completion wording, I16 (`489`).** Trigger: save provider while General is dirty. Consequence: “Settings saved” sounds broader than the completed mutation, while the bottom bar still correctly says unsaved. Verify the exact final state, then scope the message to provider completion if still present. This is not evidence that the General draft was saved or lost.

The Models singular/plural mismatch is a lesser instance of unchanged terminology polish, not another material finding. There is no need to invent five defects.

## Specific strengths to preserve

1. **Errors are local and actionable, with a safe global gate.** Provider summary plus field error (I15), and final numeric text plus disabled Apply (I18/I21), make correction possible without hiding invalid input.
2. **Independent editing has an explicit visible save boundary.** The host footer remains dirty after provider-only save (I16), and the supplied extracts distinguish those writes. Do not “simplify” this by committing or resetting all drafts together.
3. **Reading and active work coexist.** A named reading checkpoint survives a live hold, thread return and sidebar collapse; an explicit Back to live resumes following; Stop ends in a clearly labeled stopped UI and idle composer. The screenshots and interruption assertions support this limited sequence. The visible “Progress kept” label does not establish generated-body retention, complete persistence or restart recovery.

## Prioritized falsifiable future checks, not new work or acceptance claims

The source is frozen and this review requests no additional UI operation or implementation. These are bounded ways to resolve remaining uncertainty if a later acceptance decision needs them.

1. **Close the exact-final-build coverage gap:** repeat Account→Models, provider validation/Cancel→Enter, provider-only save with Queue/max drafts, and Chinese→English on `bebe` with stage-pinned originals and field-only reads. Fail if another draft is lost/committed or the invalid gate is bypassed. These flows passed on `489`, not freshly on `bebe`.
2. **Verify sampled keyboard/error behavior:** perform the pointer-free provider/General sequence described in dimension 9 and measure contrast separately. Fail on unreachable correction, missing focus restoration or missing programmatic error linkage. Screen-reader compliance remains a separate unverified claim.
3. **Test identity retrieval before changing layout:** open/focus two long same-prefix model choices. Fail only if the complete unique provider/model identity cannot be retrieved before committing. If already available, limit any change to closed-caption polish.
4. **Make saved-scope wording precise if the final toast still matches I16:** provider-only success should name that scope while leaving the General dirty footer intact. Fail if the message implies completion of settings that remain uncommitted.
5. **Extend the reading test only where confidence is needed:** at the same native desktop size, repeat held reading with composer growth and a disclosure/content-height change, then explicit resume and Stop. Fail on unsolicited bottom snapping, lost reading anchor, inaccessible Back to live or a false stopped state. The existing 16.773-second text-only run does not establish these unobserved cases. If retained progress is an acceptance criterion, separately inspect the actual generated body after Stop and its persisted/reopened representation; the current evidence does not do so.

Do not copy competitor colors/materials wholesale, split the composer into permanent Stop/Send/Steer controls, clear unrelated drafts during provider mutations, coerce unfinished numeric input to Unlimited, or resume following merely because a resize/navigation returned the reader near the bottom. Those changes would sacrifice the product contract for superficial simplification.

## Image ID index

IDs below are the manifest's top-level screenshot order; their original hashes and paths are independently verified as described above. Every path is under `settings-interrupted-20261109/` in the evidence directory.

- I01: `after-account-model-route.jpg` — `4893830a`; SHA-256 `fc1987c6827acf3f2483e78422a8acae14ba3f599cc8f9eb9f617ccbb50a988b`.
- I02: `after-general-applied.jpg` — `4893830a`; SHA-256 `9a7abaf8f3e5bdaf225a7be32460b8b15c9fff93c120b6f872839d33884c73a6`.
- I03: `after-general-chinese-language.jpg` — `4893830a`; SHA-256 `2926ca570c09278d5259315766b7ec9ab5f824eb25c93ba6da5021e56ee7fc47`.
- I04: `after-general-unsaved-reopen.jpg` — `4893830a`; SHA-256 `e27861555361ca6f477fe8d2b66cfc608cd7ccdf4877445baabf5e3fb3100ecd`.
- I05: `after-general-zero-invalid.jpg` — `4893830a`; SHA-256 `c6562356ef8ff860133092259cf410a9c0c76dac7385c1198929a47621d1dfc8`.
- I06: `after-models-blocked-by-invalid-general.jpg` — `4893830a`; SHA-256 `9c34391f4a1e21d179a2ea490ad2308f80a125083dfdeb227ff9bb51d355126e`.
- I07: `after-native-cleared-minus-stuck-invalid.jpg` — `4893830a`; SHA-256 `ca77ca9a1e9ae893577a02cd848bcc7fa28542fbe0a97b5063150d2aadd3fece`.
- I08: `after-native-corrected-number-valid.jpg` — `4893830a`; SHA-256 `514b328587d97bfbf02d0e561ac6e7e85d9bbef5389b50cd4913192ee8deedd2`.
- I09: `after-native-empty-from-valid.jpg` — `4893830a`; SHA-256 `24478542deecd86fbc434a836dc3be7f825db98bbd1c5c06c88cfa34fc809796`.
- I10: `after-native-minus-invalid.jpg` — `4893830a`; SHA-256 `180d0168a248b4e8be2115a3b04286d7a156d701e89445d4a1ba9bded3d6f483`.
- I11: `after-native-minus-reopened.jpg` — `4893830a`; SHA-256 `b1bda834e97ce3e35b94f90448c8fcc75386c85a3c37762ee539df10f1dd346b`.
- I12: `after-provider-cancel-keyboard-reopen.jpg` — `4893830a`; SHA-256 `da393ae560f48643be65dd5d6ba3358901c050758efbf94606a5bedc4d526607`.
- I13: `after-provider-general-max-retained.jpg` — `4893830a`; SHA-256 `4d951d36e4d9a3765ece70e38a1ffcc29ea9a92f59131ee424d9e3b5c7cd7c75`.
- I14: `after-provider-general-queue-retained.jpg` — `4893830a`; SHA-256 `9bc7ae412cccdfb0ee8609a2ac54a52fb8a3484a1ccfba7cde1df2ff671dd50f`.
- I15: `after-provider-invalid-model.jpg` — `4893830a`; SHA-256 `70da6b548354048ffaa40295feca7b9f6f2f99507c56743f29cf9ef9ce9eba7d`.
- I16: `after-provider-save-unsaved-general.jpg` — `4893830a`; SHA-256 `02142a39b5f26c3bb212c43c8773bab72f5bd65825afa3e490d392a17ff19628`.
- I17: `final-input-exponent-cleared-unlimited.jpg` — `bebe9276`; SHA-256 `c78f4d6d6a73b58426bda227297305434875b01cad5f8e0d03d427c017a4abf1`.
- I18: `final-input-exponent-invalid.jpg` — `bebe9276`; SHA-256 `e3921f75221b905cc750482e7c3876340cb68c0d077dc9b0d1f3af6db037905a`.
- I19: `final-input-minus-cleared-unlimited.jpg` — `bebe9276`; SHA-256 `c78f4d6d6a73b58426bda227297305434875b01cad5f8e0d03d427c017a4abf1`.
- I20: `final-input-minus-corrected-valid18.jpg` — `bebe9276`; SHA-256 `53cb51d044bc0b166d247af05b8a4227016bcec6d2fe3f0b5a21e3b2e5a12825`.
- I21: `final-input-minus-invalid.jpg` — `bebe9276`; SHA-256 `ec871627aa0c19aa3cd17bb6f880c7da4216daa964282ddc144d5f1cfc542af6`.
- I22: `final-input-valid18-applied.jpg` — `bebe9276`; SHA-256 `5dfc6445eab471a2498a4a3d37655953706b61121b35bd6f040bee260b16852a`.
- I23: `final-live-back-to-live.jpg` — `bebe9276`; SHA-256 `c6419e466d493d923d76671ce150ce35931ac4bd0827ea07af30d071cc0dcc18`.
- I24: `final-live-follow-advanced.jpg` — `bebe9276`; SHA-256 `1a6b294489657fee3a1836c9f43de24ba08d2afe067cb21b158ca8442a6f9f82`.
- I25: `final-live-follow-resumed.jpg` — `bebe9276`; SHA-256 `50cc219eb0e17ee997cf8fab20bc478a240f50692cdc15fa0c94ba1852f39c27`.
- I26: `final-live-follow-start.jpg` — `bebe9276`; SHA-256 `6b4fe8dc85b004056d6ae5a3a67ba4d88c0d6c6d2e199facd7080d008732223c`.
- I27: `final-live-reading28-held.jpg` — `bebe9276`; SHA-256 `7b3fed08cad98df44e3153bc3f53b20f3c13e2fc98aac2359c250c94d73442c2`.
- I28: `final-live-reading28-hold-start.jpg` — `bebe9276`; SHA-256 `cf5a785f6d3a5115fd705cccac9fe8eb6a8d00fc36b8cdeaf088d639634b8d5c`.
- I29: `final-live-reading28-sidebar-collapsed.jpg` — `bebe9276`; SHA-256 `00a588660a715e11fb2dad95570b0eb9a41a38b5206aa3d8c5c33581282b8c43`.
- I30: `final-live-reading28-switch-return.jpg` — `bebe9276`; SHA-256 `1e73009d10d18aeea05638fc391265187da7623581ac74ee119458b0512bf763`.
- I31: `final-live-stopped.jpg` — `bebe9276`; SHA-256 `af751f5a762ce9753506b33f016c9f7a2fb1351b8fac34dcc3f793635133d150`.
- I32: `general-draft-lost-after-provider-before-fix.jpg` — `58df4ea3`; SHA-256 `f6539ef0e3390048605ecad97af1d1d8fa7a1b490777991968b24c4986340615`.
- I33: `general-draft-retained-before-provider.jpg` — `58df4ea3`; SHA-256 `e27861555361ca6f477fe8d2b66cfc608cd7ccdf4877445baabf5e3fb3100ecd`.
- I34: `general-invalid-number-before.jpg` — `58df4ea3`; SHA-256 `192bcd5d761079c09d244ade6ee383af9868ab28d5737b8060f6a4e108091b04`.
- I35: `provider-invalid-model-before.jpg` — `58df4ea3`; SHA-256 `f095da33621313f533081237967cad019d80e5139d10a5a2c63ca02181509a8b`.

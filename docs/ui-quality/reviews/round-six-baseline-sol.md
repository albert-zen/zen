# ZenX Projects / Rooms sidebar: independent first-batch review

## Scope and immutable evidence

This is a scoped review of the **first frozen 13-image batch**, not an all-app rating and not a baseline/candidate comparison. There is no aggregate score or average.

- Source commit: `bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`.
- Source tree: `746ff97626902500d8ae5f73cba6d706a4da9910`.
- Frozen manifest: `round-6-baseline/sidebar-batch-1.manifest.json`; SHA-256 `0c40724ecf310b254df10ae98f7e58fc4f24a3eed68deb24791656b9fcd7324b`.
- Environment recorded by the manifest: actual native Linux Electron 43.2.0, 1188 × 848, light Graphite/Azure; fresh isolated synthetic local fake-only data. Renderer/main build hashes are recorded in that manifest.
- All 13 listed original JPEGs were opened individually at their original dimensions. Their current SHA-256 hashes all match the manifest. No newer unmanifested image contributes to this review.
- Repository reading was limited to `AGENTS.md`, relevant parts of `apps/zenx/docs/ui-ux.md`, and `docs/ui-quality/rubric.md`. No implementation code, other Zen reviewer report, or earlier Zen score was used. No native/CUA operation, new UI action, or source change was performed.
- The manifest was opened for version/file enumeration, so its embedded action captions were available during that enumeration. The pixel observations below are independent visual observations; captions are not presented as screenshot proof of behavior.

### Evidence IDs

| ID  | Original file                                     | Pixel-visible state                                                                                   | Separate operator-record claim                                       |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| S01 | `01-projects-populated-rooms-empty.jpg`           | Populated Project/Thread sidebar; PAW welcome expanded; empty Rooms helper; welcome composer          | Fresh profile launched and allowed to load                           |
| S02 | `02-long-thread-selected-keyboard-menu-focus.jpg` | Long Thread selected; ellipse has visible circular focus; full title in main header                   | PAW collapsed, Thread selected, Tab focused menu                     |
| S03 | `03-keyboard-thread-menu.jpg`                     | Thread menu open with wrapped full title, Project/path, machine, last message, actions                | Return opened focused menu                                           |
| S04 | `04-selection-versus-keyboard-focus.jpg`          | Original Thread remains selected/main header unchanged; next row has outline and details popup        | Escape closed menu; Tab advanced focus without selecting next Thread |
| S05 | `05-project-menu-two-projects.jpg`                | Two Projects visible; first has no displayed children; second has one child; Project menu open        | First Project collapsed, then its menu opened                        |
| S06 | `06-project-long-name-draft.jpg`                  | Edit Project modal; focused name field shows long draft tail; explicit Cancel/Save; red Remove action | Long synthetic name entered                                          |
| S07 | `07-project-cancel-reopen-original.jpg`           | Same modal shows original `ZenX Design QA` name                                                       | Cancel, then reopen restored original name                           |
| S08 | `08-long-project-saved-rooms-hover.jpg`           | Project row and global context show new truncated long name; Rooms + visible                          | Save submitted; Rooms header hovered                                 |
| S09 | `09-new-room-empty-form.jpg`                      | New Room drawer with labeled empty fields and disabled-looking Create Room                            | Rooms + opened form                                                  |
| S10 | `10-rooms-empty-after-close.jpg`                  | Rooms landing with explanatory empty state; no body creation control or visible header +              | Close dismissed New Room                                             |
| S11 | `11-room-member-picker-long-titles.jpg`           | Room/member fields filled; searchable bounded conversation picker; title/path/short ID rows           | Form reopened/filled; picker opened                                  |
| S12 | `12-long-room-created-empty-history.jpg`          | Selected one-member Room with long title, empty-conversation guidance, composer and visible More      | Local Thread selected and explicit Create Room submitted             |
| S13 | `13-room-context-menu.jpg`                        | Room More menu open with Rename conversation / Conversation settings                                  | Created Room ellipse opened                                          |

The sequence corroborates the reported result of the small navigation/form exercises. It does **not** establish restart persistence, delivery, mutation atomicity, failure handling, complete Tab order, accessible names, actual hit-box sizes, measured contrast, or reduced-motion behavior.

## Public reference calibration

The same specified originals were inspected, solely as published visual references:

- Codex: `codex-official-project-thread-2026-02-23.jpeg`, original asset from [Run long horizon tasks with Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex). Its global-action/project separation and task-centered composer are relevant. The article date is not a capture date or app build, and the desktop backdrop is not a Zen shell requirement.
- Linear: `linear-published-comparison-20261109.png`, official annotated comparison from [Behind the latest design refresh](https://linear.app/now/behind-the-latest-design-refresh). Consistent small icon roles and navigation that recedes are useful; its faint inactive text is not a contrast target.
- Five originals in `ui-benchmark-references/round-6/manifest.json`, with the supplied README provenance: T3 General dark/light and Providers from [PR 28842](https://github.com/pingdotgg/t3code/pull/28842), and model-picker/details comparisons from [PR 25251](https://github.com/pingdotgg/t3code/pull/25251). The former is an open experimental **DO NOT MERGE** proposal, not a shipped-state assertion. The separated context/action groups and selected-model check are relevant design questions. The Settings pair cannot validate Zen Settings because no Zen Settings state belongs to this batch.

These are historical/published development references, not interactive competitor audits. No competitor shell, settings-modal routing, model inventory, runtime semantics, or faint contrast is treated as a requirement for Zen.

## Dimension scorecard

Scores use the fixed 0–4 rubric and apply only to the observed sidebar/chat/form states. Unobserved subcases are identified rather than silently scored as successful.

### 1. Information hierarchy and grouping — 2/4, high confidence

- **Positive, S01/S05/S12:** fixed New thread / Triggers actions, named sections, bottom Settings, folder icons, and subordinate provider/member lines give several useful levels. The Room row's participant icon and member count distinguish it from a private Thread.
- **Negative, S01/S05:** owning Project text begins around x38, but its child Thread titles begin around x20. Children visually outdent their owner. The first collapsed Project and second expanded Project in S05 use the same folder-only visual treatment, without a visible disclosure-state cue. Parent/child ownership and open/closed state consequently depend too heavily on sequence and whitespace. Project names and section labels are also similarly subdued despite different roles.
- **Severity:** P2, material navigation/grouping friction, not task failure.
- **Falsifiable change/check:** make the existing Project disclosure state visible and establish nesting through a modest indent/alignment or similarly explicit group cue. Recapture both Projects expanded, then one collapsed, with similarly prefixed Thread names. A reader should identify each Thread's owner and each Project's state without opening a menu. Preserve canonical Project grouping and existing row actions.

### 2. Color purpose and semantic accuracy — 3/4, medium confidence

- **Positive, S02/S04/S06/S09/S12:** blue is restrained to meaningful selection/primary action; Save has a stronger fill than Cancel, Remove is explicitly named and red, and empty Create Room is visually subdued. The selected Thread fill and next-row keyboard outline are different cues, not merely different hues.
- **Negative/limit:** no definite semantic-color error is visible. This pack has no demanding mix of running, unread, Asking, approval, failed and uncertain rows, nor distinct real provider identities. It cannot establish their relative salience or truthfulness. Visual appearance is not a measured contrast result.
- **Severity:** no color defect established; attention/status coverage gap.
- **Falsifiable check:** capture a real local state mix with readable labels/icons, and measure text/focus contrast in Standard and High modes. Keep status meaning distinguishable without color. Do not flatten useful identity/action colors to match a reference.

### 3. Surface and material consistency — 3/4, high confidence

- **Positive, S03/S05/S06/S09/S11/S13:** continuous opaque application surfaces, restrained separators, elevated menus, modal scrim, and inset fields form a legible depth system. The Project modal and Room side drawer are visibly different interaction surfaces rather than nested decorative cards.
- **Negative, S03/S05 versus S13:** Room menu commands are comparatively bold and text-only, whereas Project/Thread menus use regular-weight icon/label rows. This is a localized hierarchy inconsistency rather than a reason to force every surface into one shell.
- **Severity:** P3 polish.
- **Falsifiable change/check:** compare equivalent rename/settings menu rows side by side at native size and align command typography/row rhythm where appropriate. Preserve the visible Room More button and existing menu contents; do not add icons merely to decorate.

### 4. Readability and density — 3/4, high confidence

- **Positive, S02/S03/S04/S11:** ordinary titles remain readable at this width; the selected long Thread has its full name in the header and wrapped menu title. Project, machine and canonical-message metadata in the Thread card are labeled and separated from commands. Picker rows include a shortened workspace and a distinguishing short ID instead of a bare long identifier.
- **Negative/limit, S08/S11/S12:** long Project, Room and conversation-option labels truncate. S11's first option visibly loses the descriptive title tail, although the path/short ID helps distinguish it. Full-name inspection/search/accessibility may address this, but that recovery was not exercised in this pack. Repeated `Local demo` lines consume considerable vertical space; because this is a homogeneous fake-only seed, that alone is not evidence that provider identity should be removed.
- **Severity:** P3 visible truncation; long-name recovery is an evidence gap, not a proven inaccessible identity.
- **Falsifiable check:** use two same-prefix names and verify full exact identity via keyboard and pointer before selection, including Project rows and conversation options. Preserve readable metadata or the existing compact-density option rather than deleting source identity to fit more rows.

### 5. Attention allocation — 2/4, high confidence

- **Positive, S02/S06/S12:** selected work, primary Save, and the Room's `Type @` next-step hint are easy to locate without bright competing chrome. There is no extra activity rail or permanent strip of Thread action buttons.
- **Negative, S10 with S08/S09:** the empty Rooms body says `Create a room to bring your agents into one conversation` but offers no action there. On the resting sidebar, the header + is invisible; S08 shows it only in the recorded hover state. The most useful first-use action has no persistent visible cue on the empty landing.
- **Severity:** P2 first-use friction. Creation itself worked in the recorded flow.
- **Falsifiable change/check:** add a visible, concise entry to the **existing** New Room action in the empty body. A first-time user should reach S09 from S10 without discovering a hover zone. Retain the contracted transparent hover/focus header + and explicit Create Room submission.

### 6. Navigation and discoverability — 2/4, high confidence

- **Positive, S01/S03/S05/S12/S13:** named Projects/Rooms, fixed Settings, context in Thread details, and direct Room selection provide a coherent basic route. The Room's visible More immediately exposes rename/settings, as required. Long titles are not replaced with unrelated stand-ins.
- **Negative, S01/S05/S10:** Project nesting/disclosure ambiguity and the hidden first-use Room action are the material problems described above. S10 also does not visibly select a Room because none exists; that is an empty state, not an incorrect selection.
- **Severity:** P2, shared with findings 1–2 rather than counted as additional defects.
- **Falsifiable check:** ask a new reader to collapse a specific Project, identify the owner of a same-prefix Thread, create a first Room and reopen its settings. Navigation should use the same objects/routes and not require inference from a menu's metadata.

### 7. Interaction feedback and state integrity — 3/4, medium confidence

- **Positive, S02–S08/S09–S12:** selected content stays on the original Thread while another row receives focus; draft and saved Project names are visually distinguishable across the recorded Cancel/reopen and Save sequence. New Room starts with a disabled-looking submission and ends in a selected one-member Room only after the recorded explicit creation. Close returns to the empty landing.
- **Negative/limit:** there is no observed failure, slow save, repeated click, uncertain outcome, reload, late response, or Room-edit cancellation. The snapshots show the reported sequence's visible results, not durable-store correctness or exhaustive cancellation semantics.
- **Severity:** no state-integrity defect established; material acceptance coverage remains open.
- **Falsifiable check:** native local tests should cover rejected save/create, retained draft, duplicate submit, and navigating away before a delayed response. Record the exact outcome and verify no stale response changes the new selection or editor. Do not introduce a new persistence/retry state machine to address a visual review.

### 8. Composition and responsive behavior — 3/4 for the observed desktop, medium confidence; narrow/reflow N/O

- **Positive, S03/S05/S06/S09/S11/S12:** menus, modal, drawer and picker fit within the 1188 × 848 viewport. The main title, conversation and composer retain clear zones; form labels and inputs align. The long Room title fits the main header while the sidebar uses deliberate truncation. Lower navigation uses an existing scroll area instead of escaping the window.
- **Negative/limit:** only one window size and expanded-sidebar layout are in this manifest. S11 shows the bottom of the bounded picker cutting through a further row, but a still image does not establish whether scrolling/keyboard reveal works. No narrow containment or sidebar-collapse conclusion can be made from these files.
- **Severity:** evidence gap, not a demonstrated responsive defect.
- **Falsifiable check:** recapture the same long-name picker/form/menu states at a narrower desktop and 390 × 600, including first/last keyboard-focused options, deliberate internal scrolling, and collapsed/restored sidebar. Do not invent an exact mobile navigation pattern from the competitor images.

### 9. Accessibility and input robustness — 3/4 for the limited observed path, medium confidence

- **Positive, S02/S03/S04/S06/S11:** the ellipse, next row, name input and search input have visible focus indications. Focused and selected rows are distinguishable. The operator record explicitly covers Tab → Return → Escape → Tab for the Thread menu; S04's still-selected original Thread corroborates that focus movement is not selection.
- **Negative/limit:** Room More keyboard activation, drawer focus/return, section-add keyboard discovery, search matching, assistive technology, accessible labels, hit targets, touch/no-hover behavior and reduced motion were not tested here. The small visible plus/ellipse glyphs do not establish small hit boxes. No screenshot-only WCAG claim is warranted.
- **Severity:** no input failure established; keyboard coverage gap.
- **Falsifiable check:** exercise the existing Room menu using Shift+F10/Context Menu and Tab, creation and close/Escape focus return, full-name inspection from the picker, plus coarse-pointer visibility. Confirm semantic names/expanded states with an accessibility inspection, separately from pixels.

### 10. Cross-surface consistency and product fit — 3/4 for sidebar / Thread / empty Room / creation forms, medium confidence

- **Positive, S01–S13:** the same shell anchors surround Projects and Rooms; Room creation selects a distinct shared conversation rather than pretending it is a private Thread. Room and Thread composers share a visual family while Room retains member-directed `@` guidance instead of inheriting model/permission controls. Rename/settings stay contextual, and there is no invented permanent Delete command in the visible Thread menu.
- **Negative/limit:** the menu typography discrepancy is localized. Fork boundaries, populated Room exchanges, information cards, account, models and Settings are outside this 13-image scope, so their cross-surface consistency is **N/O**. The T3 Settings references do not fill this Zen evidence gap.
- **Severity:** P3 for the observed menu polish; no broad product-fit failure established.
- **Falsifiable check:** extend the same frozen identity to populated Room and Settings/Information captures. Confirm shared visual roles while keeping each surface's actual permissions, source ownership, data and actions distinct.

## Highest-impact evidenced findings

Only two findings meet the material-friction bar in this frozen batch. This is not a quota of five defects.

### F1 — P2: empty Rooms has no visible first action

- **Exact target / trigger:** S10, `10-rooms-empty-after-close.jpg`, after closing New Room; compare the Rooms header in S08 and form S09.
- **Evidence:** explanatory body copy instructs creation but supplies no body control; resting Rooms header has no visible +. The recorded hover in S08 reveals the +.
- **Consequence:** a first-time user must discover an invisible header action to start the empty area's main task. The pack demonstrates a working action, not a broken create flow.
- **Smallest improvement:** a visible empty-state action routed to the existing New Room action. Do not change the header hover/focus contract or submission semantics.
- **Verification:** from the resting S10 state, a new reader can point to the start action and open the form without hovering arbitrary sidebar headings; keyboard activation reaches the same form and does not create a Room by itself.

### F2 — P2: Project ownership and disclosure state are visually under-specified

- **Exact target / trigger:** S01 populated expanded Project; S05 with the first Project collapsed and second expanded.
- **Evidence:** child titles start left of the parent name. Expanded and collapsed Project labels share the same folder-only state cue. Contrast with the explicit disclosure chevrons on section headings.
- **Consequence:** scanning must infer ownership and expandability from vertical order. This becomes more consequential with multiple Projects or similarly named Threads. No wrong-owner navigation was observed.
- **Smallest improvement:** expose the existing Project disclosure state and establish a restrained child/parent alignment cue. Keep the title usable at full width and preserve current row/menu actions.
- **Verification:** capture two Projects with same-prefix Thread names, both expanded and then one collapsed. Ownership and open/closed state should be identifiable without opening context menus, changing the selected Thread, or adding a second navigation model.

## Important evidence gaps, not defect claims

1. **Long-name disambiguation:** S08/S11/S12 establish truncation but not all recovery paths. Test same-prefix Projects, Rooms and member-conversation choices, including keyboard full-name reading and exact identity. S11 already gives useful short workspace/ID context; preserve it.
2. **Beyond one light desktop:** Room-menu keyboard behavior, native failure/uncertain states, darker/high-contrast modes, narrow reflow, collapsed-sidebar recovery, and populated Room history are not in this manifest. Do not treat later unmanifested screenshots as silently extending these scores.

## Three specific strengths to preserve

1. **Selection and keyboard focus are independent.** S02–S04 keep the original Thread selected while the next row gets its own visible focus and details. Preserve this model, Escape behavior, complete-title card and ordinary Tab entry to the hidden ellipse.
2. **Form intent and cancellation are explicit.** S06–S08 show labeled name/folder context, a separate destructive Remove action, primary Save, and the recorded Cancel/reopen returning to the original name. S09–S12 do not present a Room until explicit Create Room. Keep those boundaries and report failures rather than merely making forms look calm.
3. **Rooms retain distinct identity in a shared shell.** S12–S13 combine a long readable header, member-directed composer hint, one-member sidebar metadata and an immediately visible More button. Preserve the difference between Room More visibility and Thread ellipse hover/focus visibility.

## Prioritized next iteration and invariants

1. Address F1 and F2 with small presentation changes tied to the existing actions/disclosures. Reuse the identical synthetic content and light viewport to verify the visual change rather than changing the evidence task.
2. Close the long-name/keyboard gaps, then capture the additional theme, narrow, populated Room and Settings/Information states as a separately frozen scope. Only then extend this review.
3. Align the minor Room-menu typography if it improves the shared command hierarchy; do not let that polish outrank first-use creation or ownership clarity.

**Do not change:** canonical cwd/Project identity; owning Thread/Room navigation and source identity; explicit creation/save/cancel semantics; the currently visible Room More button; the Thread ellipse's hover/focus/menu-only behavior; fixed New thread and bottom Settings anchors; independent focus and selection; provider/source identification; the single integrated title-bar/divider shell. Do not invent new persistence, runtime actions, repair loops, custom navigation objects or competitor-style settings routing. Do not remove meaningful semantic color, fabricate status to enrich the screenshots, or claim untested failures/accessibility/responsiveness passed.

No preference between candidates is asserted because only one frozen implementation is in scope. Any later evidence should be appended as a distinct follow-up without rewriting these first-batch observations.

---

# Scoped follow-up: second frozen batch, S14–S36

## Extended evidence boundary

This appendix adds **23 new originals**, not a changed implementation. The first-batch observations, scores and limitations above remain as originally recorded. Numbers below describe a larger, different scope; they are not an improvement/regression delta and must not be averaged with the first scorecard.

- Manifest: `round-6-baseline/sidebar-settings-batch-2.manifest.json`; SHA-256 `d8a36a43dfca9b0017a67279d9fd61ce23a18c14839420b6ea47de4559b8e14b`.
- The source commit/tree, all recorded renderer/main build hashes, Electron version, synthetic profile and 1188 × 848 viewport match the first frozen batch.
- All 23 listed originals were opened at native dimensions **before reading their actions and field assertions**. Every image hash matches the manifest. Only enumerated file names were obtained before pixel inspection; no manifest `findings` text was read.
- Safe field record: `settings-field-assertions.json`, checked 2026-11-09 19:38:00 UTC; SHA-256 `7e4b96f123227537dcea011f0e9caf9d188d6b760c1412bca5b421f05e3b2161`.
- New scope: two same-prefix Rooms; Room selection/focus; section and whole-sidebar collapse/restore; unconfigured Account; two local fake providers, model selection and provider editing/validation/cancel; General draft retention; Appearance light/dark and English/Simplified Chinese.
- Still outside scope: empty Projects, Information cards, populated Room messages, sustained streaming, live accounts/remote providers, authentication/credential flows, restart persistence, actual model delivery, narrow viewports, assistive technology, measured contrast and reduced motion. No new UI actions or implementation/source inspection were performed by this reviewer.

### New image / action index

| ID  | Original file                                        | Pixel observation                                                                                  | Separate operator-record claim                             |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| S14 | `14-two-same-prefix-rooms.jpg`                       | Two identically truncated Room labels / `1 member`; selected main header ends Beta                 | Beta explicitly created with a different local fake member |
| S15 | `15-room-switch-keyboard-focus.jpg`                  | First Room selected; its More has visible focus; main header ends Alpha                            | Switch to Alpha, then Tab to its menu                      |
| S16 | `16-projects-rooms-collapsed.jpg`                    | Rooms/Projects collapsed; chevrons and Recent remain                                               | Both sections collapsed                                    |
| S17 | `17-sidebar-collapsed-room-retained.jpg`             | Sidebar hidden; Alpha header and wider composer remain; restore control visible                    | Whole sidebar collapsed                                    |
| S18 | `18-sidebar-restored-room-retained.jpg`              | Rooms restored; Alpha selected; Projects remains collapsed                                         | Sidebar and Rooms reopened, selection retained             |
| S19 | `19-account-unconfigured-native.jpg`                 | Account says Not configured; directs to model settings; no quota figures; Refresh disabled-looking | Account opened; no sign-in attempted                       |
| S20 | `20-models-native-default-title-local-providers.jpg` | Distinct Default/Title selectors; two local provider rows; disabled-looking Apply                  | Open model settings route followed                         |
| S21 | `21-general-light-initial.jpg`                       | General with labeled cards; language says changes immediate; clean footer                          | General opened in light theme                              |
| S22 | `22-general-unsaved-maximum-rounds.jpg`              | Maximum tool rounds is 12; dirty bar and active Apply                                              | 12 entered without Apply                                   |
| S23 | `23-provider-validation-context-required.jpg`        | Error icon/text/link names Model 2/context; typed name/model retained; context-required disclosure | Save rejected missing positive whole-number context        |
| S24 | `24-provider-valid-before-save-general-dirty.jpg`    | Expanded context field is 32768; Save provider separate from global Apply                          | Context corrected; provider not yet saved                  |
| S25 | `25-provider-saved-general-still-unsaved.jpg`        | Provider editor closed/new row identity shown; global dirty bar remains                            | First provider saved                                       |
| S26 | `26-general-draft-survives-provider-save.jpg`        | General still shows 12 and unsaved footer                                                          | Returned to General after provider save                    |
| S27 | `27-provider-only-save-toast-general-dirty.jpg`      | `Settings saved` toast appears with active Apply and unsaved footer                                | Second provider saved; immediate toast captured            |
| S28 | `28-provider-name-hover-no-full-identity.jpg`        | Long provider names still clipped; no visible full-name popup in this still                        | First provider name hovered; no tooltip observed           |
| S29 | `29-default-selector-full-provider-identities.jpg`   | Default popup wraps full provider/model identities; selected option has check                      | Selector opened, selection not changed                     |
| S30 | `30-appearance-system-light.jpg`                     | System chosen; light full shell and preview; independent light/dark presets                        | Appearance opened, System resolves light                   |
| S31 | `31-appearance-dark-immediate.jpg`                   | Dark chosen; full shell, fields, footer, preview all dark                                          | Dark chosen; immediate update                              |
| S32 | `32-general-dark-zh.jpg`                             | General/nav/footer translated to Simplified Chinese                                                | Language changed immediately                               |
| S33 | `33-appearance-dark-zh.jpg`                          | Dark Appearance Chinese labels, but System/Light/Dark and Standard/High remain English             | Appearance reopened in Chinese                             |
| S34 | `34-appearance-light-zh.jpg`                         | Light Appearance Chinese with same geometry and mixed option language                              | Light chosen                                               |
| S35 | `35-models-light-zh-long-identities.jpg`             | Chinese Models page retains clipped long provider rows beside Edit/Delete                          | Models reopened in Chinese                                 |
| S36 | `36-provider-cancel-reopen-original-name.jpg`        | Provider editor heading/input show original Alpha identity                                         | Name changed to discardable text, Cancel, then reopen      |

The field-only assertion confirms two distinct provider display names ending `· Alpha` / `· Beta`, the synthetic model IDs, unchanged Default/Title selections, persisted `maxToolRounds: null`, and UI draft `12`. This supports the interpretation that independent provider saves **did not apply or discard General's draft**. It is a supplied safe readback, not a new test performed by this reviewer. No raw profile or credentials were read.

## Extended-scope 10-dimension scorecard

### 1. Information hierarchy and grouping — 2/4, high confidence

- **Positive, S19–S24/S30:** Settings has a clear page title, scoped navigation, section labels and labeled fields. Account separates connection from usage; Default and Title models are distinct. Error summary, model rows and expanded capability fields have identifiable roles.
- **Negative, S27/S28/S35:** the important provider display name receives only a narrow fragment while model chips and Default/Title badges occupy the middle/right of the same row. The distinguishing Alpha/Beta tails are absent beside Edit/Delete. Provider identity and secondary model metadata compete with the wrong width priority. S14 also shows two indistinguishable Room labels. The original Project grouping finding is not invalidated by section-collapse captures.
- **Severity:** P2, actionable object identity loses priority.
- **Falsifiable change/check:** reserve enough readable space for the provider's distinguishing name, move/wrap subordinate model summaries when needed, and test same-prefix Rooms/providers at native size before invoking their menus or Edit/Delete. Keep actual object identity and action targets unchanged.

### 2. Color purpose and semantic accuracy — 3/4, medium confidence

- **Positive, S23/S27/S30–S34:** validation has an icon, explicit text and red treatment; success has a check as well as color; selected appearance options have checkmarks. Accent, destructive actions, selected settings rows and dirty Apply retain recognizable roles across light/dark. Account does not color a missing subscription as a connection success.
- **Negative/limit, S27:** the success-colored toast accompanies overbroad save wording while a dirty state remains. This is primarily a message-scope defect, not evidence that green/check or blue accents themselves are wrong. Dark secondary text and tiny provider chips pose a visual contrast/readability risk; ratios have not been measured. High contrast is visible as an option but untested.
- **Severity:** P2 for the shared save-feedback issue; no separate color-system defect established.
- **Falsifiable check:** retain non-color status cues, scope the toast correctly, and measure dark/light text/focus contrast, especially secondary labels and chips. Do not compensate by eliminating semantic color.

### 3. Surface and material consistency — 3/4, high confidence

- **Positive, S19–S36:** Settings uses the same opaque shell and left divider as conversation surfaces. Cards, inset inputs, bordered provider editor, floating selector, toast and fixed save bar read as consistent layers. The dark/light Appearance pair updates the entire surface family, not just the preview. The model popup wraps inside its viewport.
- **Negative, S24/S27:** provider editor, catalog group and row summaries produce more nested borders and small badges than Account or General. That is localized density/role competition rather than proof that all cards should be removed. The original minor Room-menu typography discrepancy remains.
- **Severity:** P3 material/density polish, below identity and save-scope issues.
- **Falsifiable change/check:** simplify only redundant provider-row framing/metadata emphasis, then compare with General/Account at the same size. Preserve useful editor-versus-list distinction and the routed Settings surface; do not copy T3's floating settings shell.

### 4. Readability and density — 2/4, high confidence

- **Positive, S19/S23/S24/S29/S36:** Account's missing state and next step are readable; validation explains the required value; full model/provider identities wrap clearly in S29; the opened provider editor exposes the full Alpha identity. General fields and explanatory text have orderly alignment.
- **Negative, S14/S27/S28/S35:** Room rows are identical at the visible name/count level. Provider names lose their distinguishing suffixes, and dense tiny model chips are harder to scan than the model selector's full wrapping options. The S28 still has no full-name popup; the operator explicitly reports no recovery on that tested hover. This does not prove that every accessibility or editing path is missing.
- **Severity:** P2 for row-level disambiguation; not a claim that full identities are absent everywhere.
- **Falsifiable change/check:** show/recover the exact differentiating portion before selection or editing, using readable wrapping/truncation or pointer **and** keyboard full-name disclosure. Test two same-prefix names with equal member counts and two same-type provider profiles. Preserve S29's wrapping and selection check.

### 5. Attention allocation — 2/4, high confidence

- **Positive, S19/S22–S24/S30–S34:** Account offers a direct setup route; dirty Apply is persistently visible; validation is explicit; Appearance groups mode, light/dark presets, accent and contrast with selected checks. Resting content is not drowned in animated or bright chrome.
- **Negative, S27:** top-right `Settings saved` and bottom `Unsaved changes across settings` present competing completion messages. S27/S35 also give model chips disproportionate horizontal space beside an incomplete provider name. Immediate Appearance and pending Host settings are correctly different scopes, but the generic success wording obscures that model.
- **Severity:** P2 for misleading save scope; provider hierarchy shares the identity finding rather than constituting another defect.
- **Falsifiable change/check:** after Save provider with General still dirty, the most salient confirmation should explicitly identify the provider-only result and retain the pending App settings bar. Do not silently Apply General to make the messages agree.

### 6. Navigation and discoverability — 2/4, high confidence

- **Positive, S15–S20/S29:** Rooms switch correctly in the recorded sequence; section and full-sidebar controls remain recoverable; Settings remains fixed; Account's Open model settings leads to the appropriate page. Full identities in the searchable model selector provide a good pattern to preserve.
- **Negative, S14/S15/S27/S28/S35:** same-prefix Rooms require selecting to confirm the Alpha/Beta suffix in the current main header, unless another untested disclosure is used. Provider rows place Edit/Delete beside clipped identities; the tested hover did not recover the full name. Opening a separate Default model selector or an editor is extra work to identify the row being managed.
- **Severity:** P2 navigation/management friction. No wrong-target edit/delete was observed.
- **Falsifiable change/check:** identify and focus Alpha or Beta without selecting the wrong Room, and identify the provider before clicking Edit/Delete. The existing object routes and menu commands must remain unchanged. Room hover recovery remains untested, so verify it rather than claiming it does not exist.

### 7. Interaction feedback and state integrity — 2/4, high confidence for the visible defect; medium for the supplied state assertions

- **Positive, S22–S26/S36 plus safe assertions:** invalid provider save keeps the entered data and presents a concrete context error. Provider saves preserve General draft 12, leave persisted maximum rounds null, and keep Default/Title unchanged. The recorded provider Cancel/reopen returns to the original Alpha name. Sidebar restore retains Alpha without changing the selected conversation.
- **Negative, S27:** the provider-only operation reports `Settings saved` while the unrelated Host draft is still pending and Apply remains active. The field record shows correct separation underneath, so this is a misleading success-scope message, **not demonstrated data loss, auto-Apply or draft destruction**.
- **Severity:** P2 feedback/state-understanding defect.
- **Falsifiable change/check:** repeat the exact General=12 / Save provider sequence. Confirm with safe readback that General remains uncommitted and retained, and that the toast says provider saved rather than globally saved. Then test failure/late-response cases separately; no new durable recovery machinery is warranted by these images.

### 8. Composition and responsive behavior — 3/4 for the observed desktop and collapse transition, medium confidence; narrow N/O

- **Positive, S16–S18/S19–S36:** collapsing the sidebar releases horizontal room for the composer; restore brings navigation back without losing Alpha. The Settings navigation, main content, bounded selector and fixed Apply bar fit the desktop viewport. Long provider editing deliberately uses a scrollable content region rather than expanding beyond the window.
- **Negative/limit, S17:** the collapsed Room's header/bottom rule still begin substantially inset from the left (roughly x254/x232), although the conversation/composer now use the wider main area. This is a localized alignment discrepancy to check, not a task-blocking layout claim. Narrow widths, last-option keyboard reveal and short-window footer containment remain untested.
- **Severity:** P3 collapsed-header alignment; responsive coverage gap remains.
- **Falsifiable change/check:** compare header/content start edges before and after collapse, preserving the Linux native-control/drag boundaries. Verify whether that inset is intentional; remove an unnecessary reserved sidebar offset if present. Recapture long-name forms/selectors at narrower widths before asserting responsive robustness.

### 9. Accessibility and input robustness — 3/4 for the limited observed paths, medium confidence

- **Positive, S15/S22/S23/S29/S30–S34:** Room More and edited fields have visible focus; validation includes text/link and an icon; selected Appearance choices and chosen model use checkmarks in addition to color. The sidebar restore control remains visible when collapsed. No source identity is replaced by a visual-only stand-in.
- **Negative/limit:** Room menu activation/return is not exercised beyond the recorded Tab focus. No native accessibility-tree, hit-box, screen-reader, reduced-motion, touch, High contrast, or full keyboard error-link recovery inspection is included. S33/S34 leave generic mode and contrast choices in English despite Chinese labels, adding reading burden for a Chinese-only user. Preset/brand names are a separate matter.
- **Severity:** P3 localized language inconsistency; other items are untested, not failures.
- **Falsifiable change/check:** localize generic System/Light/Dark and Standard/High labels while retaining internal values and proper preset names; check accessible names in both languages. Exercise Room More, validation-link focus, full provider identity recovery, and drawer/menu return with keyboard only, then measure contrast separately.

### 10. Cross-surface consistency and product fit — 3/4 for the extended captured scope, medium confidence

- **Positive, S19–S36:** Account truthfully presents Not configured and no invented quota; Models distinguishes Default/Title scope and labels fake providers Local testing instead of connected; General states that defaults apply to new replies; Appearance clearly says changes apply immediately and updates shell/preview together. The safe field readback supports independent provider/Host setting authority. These fit Zen's documented ownership rather than a copied competitor runtime.
- **Negative, S27/S33/S34:** generic save wording undercuts the otherwise useful independent save scopes. Chinese Appearance has untranslated generic choice labels amid translated headings/descriptions. Information cards, populated Room state and real Account/provider outcomes remain N/O.
- **Severity:** P2 save-scope clarity; P3 localization consistency.
- **Falsifiable change/check:** keep provider-only saves, Host Apply and renderer-local immediate appearance distinct in behavior **and** wording. Translate user-facing generic options without translating user-chosen names or inventing Account/model actions. Extend the same frozen capture discipline to Information/populated Room before judging them.

## New highest-impact findings in the extended evidence

### F3 — P2: provider-only save is reported as globally saved

- **Target / trigger:** S27, `27-provider-only-save-toast-general-dirty.jpg`, immediately after Save provider with General Maximum tool rounds draft 12 still un-applied; corroborated by S22/S26 and the safe field assertion.
- **Evidence:** `Settings saved` success toast and `Unsaved changes across settings` plus active Apply appear simultaneously. Provider names are committed, while persisted maximum rounds remains null and UI draft remains 12.
- **Consequence:** the user cannot rely on the completion wording to know which settings are in effect. Correct draft isolation underneath does not repair the overbroad confirmation.
- **Smallest improvement:** confirm `Provider saved` and, where useful, mention other pending App settings. Keep the dirty bar and independent Save provider / Apply behaviors.
- **Verification:** repeat that exact cross-section sequence; provider success must not suggest global completion, auto-apply the General draft, clear it, or disable its pending Apply.

### F4 — P2: provider-row identity is clipped beside management actions

- **Target / trigger:** S27/S28/S35 after saving two long same-prefix fake providers; S28 operator-tested hover over the first display name.
- **Evidence:** Alpha/Beta suffixes are removed from both list labels, while secondary model chips and badges occupy more width. Edit/Delete remain directly actionable. The tested hover shows no full-name recovery. S29 demonstrates that complete identity is available and readable in a different selector; S36 also exposes it after entering an editor.
- **Consequence:** managing the intended profile requires extra inspection elsewhere or entering an editor. The current row presents its actions more clearly than the identity they act on. This is not proof of a wrong-target operation or a missing name in storage.
- **Smallest improvement:** prioritize the display name and provide exact full identity on both pointer and keyboard inspection before management. Keep model summaries subordinate and preserve stable provider identity, actual profiles and existing actions.
- **Verification:** distinguish Alpha from Beta in the provider list before opening Edit/Delete, in English and Chinese, with both pointer and keyboard. Preserve full wrapping/selection semantics in S29.

### F5 — P2: two long Rooms become visually indistinguishable in navigation

- **Target / trigger:** S14/S15, after creating same-prefix Alpha/Beta Rooms with equal member counts and switching between them.
- **Evidence:** both rows display `Research planning room wit…`, the same participant icon and `1 member`; the distinguishing name tail appears only for the current Room in the main header in these captures. S15 focus is on the first Room's More, while the row label remains clipped.
- **Consequence:** a user scanning navigation cannot identify the intended Room from its resting row. Selecting one to read its header is an extra navigation step. A full-name hover path may exist but was not tested, so its absence is not asserted.
- **Smallest improvement:** retain an identifiable part of each exact name at the tested width and ensure full-name inspection works on hover **and** keyboard focus. Use existing Room identity/name presentation, not new object names or fabricated IDs.
- **Verification:** identify and target Alpha/Beta before navigating, including from keyboard focus, with same-prefix names and identical member counts. Keep visible More, selection state, row order and Room ownership unchanged.

F1/F2 remain first-batch findings. F3–F5 are additional evidence on the same implementation, not regressions introduced by a new candidate. The broader pack narrows the earlier long-name gap into the specific Room/provider row defects above; it does not retroactively rewrite the first scorecard.

## Three additional strengths to preserve

1. **Collapse is recoverable and retains current work.** S15–S18 preserve the Alpha Room through section collapse, whole-sidebar collapse and restore, with an obvious restore control and more composer width while hidden.
2. **Independent saves protect unrelated drafts.** S22–S26 and the safe readback establish that provider saves leave General's uncommitted 12 intact without persisting it or changing Default/Title. S23 keeps invalid model input and presents a real error. Fix the success wording without changing those boundaries.
3. **Theme changes have whole-shell continuity.** S30–S34 keep the same geometry, meaningful checks, opaque material roles and preview across light/dark and locale changes. Preserve immediate Appearance behavior and proper preset/user names while completing generic option localization.

## Follow-up priorities and unchanged constraints

1. Correct provider-save confirmation scope; keep all write boundaries and pending drafts intact.
2. Make exact provider and Room identities readable/recoverable before the associated navigation or management action. Apply separate object-appropriate presentation fixes rather than merging their semantics.
3. Address the earlier first-use Rooms and Project grouping findings; then complete generic Chinese Appearance labels and check the collapsed-header inset.
4. Freeze further Information, populated Room, narrow and keyboard/error recovery evidence as a new scope. The present files do not certify those cases.

The initial “do not change” list remains in force. In particular, **Room More stays visible**, Thread ellipsis keeps its distinct hover/focus contract, provider saves do not apply General, Appearance remains immediate/renderer-local, user-chosen names and canonical source identities stay exact, and unconfigured Account must not display invented usage/connectivity. No new runtime abstraction, persistence layer, action, forced competitor shell or global score is justified by this review.

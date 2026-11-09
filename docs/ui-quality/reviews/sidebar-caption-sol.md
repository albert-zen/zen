# Sidebar-caption follow-up: closure of the visible-scope finding

Independent visual follow-up, 2026-11-09. This is a separate four-image extension, not a rewrite or rescoring of the frozen 18-image review. No code edits, desktop actions or test execution were performed for this review.

## Verdict

**The specific P2 resting-label ambiguity is resolved within the observed scope.** A single quiet **Sidebar / 侧栏** caption now identifies the Hidden/Shown column while the separate card-level **Hide / 隐藏** action remains above it. The caption does not consume inline child-name or lifecycle width. No new width, clipping or child-name readability regression is visible in these four states.

This closes the concrete missing-scope wording defect. First-time-user comprehension has not been empirically tested, so it does not prove every user will understand the control unaided. It does not automatically increase any earlier dimension score or close the earlier P3 findings.

## Evidence and source

All four originals in `sidebar-caption-captures/` were inspected as stored. They decode as **JPEG, 1188×848**, despite `.png` filenames. The parent reports the normal native production build at **58df4ea3852e4826d3aa31a931c3383258bc0c47**, using the same authentic isolated local plugin profile. I inspected that commit's Subagents component, CSS, localization, product-documentation and test diff. The change adds one conditional caption and its styling/localization; the diff does not modify switch activation, visibility persistence, row width or child navigation logic. Added tests were inspected, not rerun by this reviewer.

Build record: `sidebar-caption-build.sha256`:

- Main: `3c3927332a1352aa8d07b832bdd3c8a87742d7508278e4a3663e5ed059b7778f`
- Renderer JS: `dac0e998f84a9e60ad1d8db112be4cedef3376e0d08d64582d87ee7440ecaa45`
- Renderer CSS: `2eb3e067ad842c043ff92e27073df53c67d44ed06e37c62b30914add1a6f3195`

## Exact observations

| Image                                 | Positive evidence and comparison                                                                                                                                                                                                                                                                                                         | Remaining negative evidence                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 `01-split-sidebar-caption.png`     | In the roughly 416px conversation allocation, the popup contains **Sidebar** directly above **Hidden**. **Idle** remains a separate lifecycle column. Compared with old A09, popup horizontal edges and complete **QA reviewer · native child** title are retained; one caption line adds vertical height rather than taking name width. | No new clipping observed. The entire card still overlays conversation text, as before; this follow-up does not evaluate that existing interaction choice. |
| 02 `02-split-shown-sidebar-child.png` | **Shown** remains under **Sidebar**, and the same child visibly appears in Projects and Recent while the parent remains selected. This visible state pair reinforces the caption's meaning without changing the row's name/status layout.                                                                                                | Click sequence is attributed to the operator, not inferred from two screenshots. Persistence and failure behavior are not proved here.                    |
| 03 `03-docked-sidebar-caption.png`    | The approximately 340px docked card keeps the complete child name and separate **Idle / Hidden** text. **Sidebar** is aligned over the visibility control, while **Hide** stays associated with the Subagents heading. Against old A01, no horizontal expansion or title compression is visible.                                         | The card is approximately one caption line taller. This is a small, justified vertical cost, not a material regression in this state.                     |
| 04 `04-chinese-sidebar-caption.png`   | Normal Chinese UI displays **侧栏** over **已隐藏**, separate from lifecycle **空闲** and card action **隐藏**. All fit without wrapping into the child title.                                                                                                                                                                           | Only Chinese docked/hidden is observed, not Chinese split/shown, long translated names or other locales.                                                  |

## Falsifiable acceptance and remaining limits

The visible checks for this fix pass: the scope word exists once above real controls; card Hide remains distinct; complete tested child names and lifecycle text remain readable at both supplied allocations; the caption remains within the existing card width; Chinese uses the corresponding localized term. Keep this compact heading rather than lengthening every row control.

Reopen the issue if a matched capture shows the caption over the wrong column, a real visibility control without the caption, a clipped child name caused by the new layout, or confusion between lifecycle and sidebar visibility during an unprompted user task. If broader testing is needed, use long/common-prefix and nested children, archived rows and narrow/zoom combinations before changing layout again.

No new keyboard/focus, contrast-ratio, screen-reader, reduced-motion, dark-theme, 200% caption, full-app narrow-window/mobile, macOS/Windows, persistence or failed-write validation is claimed. The source diff and earlier focus captures do not replace new execution checks. The retained black-frame anomaly is outside this follow-up and is not resolved by these images. No fourth-native delivery images were added to this review.

## Original-image SHA-256

| File                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `01-split-sidebar-caption.png`     | `50d47f1bda96126d6fbdf820e169331c851475f11a558ec0deb74ea69a7db106` |
| `02-split-shown-sidebar-child.png` | `abe9f22aaf23a4fb4496c38e8c19ba55c40dbf3b6c19f9a7ae1562b9252626c0` |
| `03-docked-sidebar-caption.png`    | `99a02465d238ca413b0c46842635e55960bffad13e254ba3a9439ac94b47412e` |
| `04-chinese-sidebar-caption.png`   | `37b15e93b759ed843a0f0ec274b568c029cfa9ece20eb1b3742ae7950fce96fc` |

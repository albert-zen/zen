# Original blind P/Q review

**Verdict:** Q makes selected values easier to find, especially in light mode, but also makes unselected choices look less available. I narrowly prefer Q for scanning current settings, not as an unqualified usability improvement. The six dimensions remain tied at 3/4; neither sample demonstrates an exemplary result without material verification gaps.

## Scope

Blind review of P-dark.jpg, P-light.jpg, Q-dark.jpg and Q-light.jpg at their supplied 1180×812 size, using only the fixed rubric and these images. No source, candidate mapping, prior reviews or GUI interaction inspected. Reviewed P before Q, which leaves possible order bias. These are local production SettingsView captures, not full application acceptance or a matched competitor comparison. Evidence directory: ../evidence/appearance-followup-20261109/.

## Scorecard

| Dimension                         |   P |   Q | Confidence          | Evidence, limitation and falsifiable next step                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | --: | --: | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Information hierarchy             |   3 |   3 | High                | All images: page heading, section heading, mode selector, presets, accent and contrast are distinctly grouped. Q’s selected-card outlines make current values easier to scan. Both display Light preset and Dark preset at equal prominence even when only one mode is active; users must reconcile this with the explanation at the bottom. P3: test whether users correctly identify which preset affects the current preview without prompting.                                                              |
| Readability / density             |   3 |   3 | High                | All labels and footer text are visible without clipping. The compact card fits comfortably within the viewport. Descriptions and navigation labels are relatively small and subdued, especially in dark mode. Q additionally subdues unselected option names, weakening their readability relative to P. P3: measure text contrast and test available-choice identification at actual display scale before lowering any more text emphasis.                                                                     |
| Color purpose / semantic accuracy |   3 |   3 | Medium              | Selection has checkmarks as well as fill in both candidates. Accent colors have names and descriptions, so their identities are not conveyed by color alone. Q adds a consistent selection outline to preset, accent and contrast controls. However, the blue outline appears beside a blue accent selection; these captures cannot establish whether selection color remains semantically coherent with Iris or Jade selected. P3: inspect those states and distinguish selection styling from keyboard focus. |
| Surface consistency               |   3 |   3 | High                | Both use a coherent rounded-control system within a single enclosing card and a distinct inset preview. Q aligns the smaller selected controls more closely with the selected mode button’s outlined treatment. P’s quieter smaller controls are also internally legible, rather than broken. Both give the preview’s “Accent” sample the appearance of a real button. P3: establish whether that element is interactive, then verify its styling communicates its actual role.                                 |
| Attention allocation              |   3 |   3 | High                | The content heading is dominant; Reset remains peripheral; the selected navigation row is clear. Q improves current-value detection, but five outlined selected controls across the card introduce more competing edges, particularly in Q-light. The preview’s saturated Accent sample attracts attention ahead of several actual controls in both. P3: compare timed setting-change tasks, not only “find the selected option” tasks.                                                                         |
| Composition                       |   3 |   3 | High for this width | All images retain clear navigation/content separation, aligned control rows, balanced margins and viewport containment. Neither has visible clipping. The side-by-side preset groups have a relatively narrow gutter compared with their overall control density. Responsive behavior is unobserved. P3: verify the group boundary and reflow at narrower widths and enlarged text.                                                                                                                             |

No overall score assigned. Differences within a scoring anchor do not justify forcing a numerical winner.

## Five highest-impact findings

1. **P3: Q weakens the apparent availability of unselected options.** Target: Q-dark and Q-light, especially System/Light/Dark alternatives, Cobalt/Ember and High. Trigger: looking for a setting to switch to rather than checking the current value. Consequence: muted alternative labels can resemble disabled controls; this is most noticeable in dark mode. Verification: ask users to identify all available choices without hovering. Retain Q’s selection outline while restoring P-level unselected label emphasis, then compare errors and time. Actual disabled behavior is not established.
2. **P3: Current-mode and remembered-mode presets compete equally.** Target: Light preset / Dark preset groups in all four images. Trigger: changing a preset while Light or Dark is explicitly active. Consequence: both checked Graphite tiles look equally relevant to the preview. The footer explains separate remembered presets, but only after the controls. Verification: ask which group changes the current display. If confusion occurs, test a short local cue indicating the active mode; do not disable the other group merely to simplify the screenshot.
3. **P3: Small subdued helper text needs measured verification.** Target: dark-mode explanatory copy, preset descriptions, footer and inactive navigation labels. Trigger: reading at normal display scale, particularly with less favorable viewing conditions. Consequence: extra reading effort is plausible; no supplied text is actually clipped or demonstrably unreadable. Verification: measure actual foreground/background values and inspect text scaling. Do not infer WCAG compliance or failure from these screenshots.
4. **P3: Preview sample looks like a live action.** Target: the blue “Accent” rectangle inside the preview in all images. Trigger: a user attempts to change the accent by selecting that prominent element. Consequence: if decorative, it offers a misleading interaction cue; if interactive, its relationship to the accent controls is unexplained. Verification: inspect its actual role and test first-click behavior. Preserve a representative accent preview, but label or style it as a sample if needed.
5. **P3: Q’s stronger selected borders may trade calmness for redundant emphasis.** Target: Q-light, selected mode, both preset cards, Azure and Standard. Trigger: scanning the full panel rather than one setting group. Consequence: equal perimeter emphasis draws attention to several independent selected values simultaneously. This is a tradeoff, not proof Q is worse. Verification: compare both “read current settings” and “change one setting” tasks. Q’s advantage is falsified if it increases search time or causes focus-versus-selection confusion.

## Three strengths to preserve

- Checkmarks provide a non-color selection cue in every setting group.
- The layout fits the complete Appearance task into one contained, readable panel at the supplied viewport.
- Light and dark versions preserve the same geometry and control ordering, while Reset remains visually secondary.

## Next iteration and recommended compromise

1. Keep Q’s clearer selected outlines provisionally, but restore stronger text emphasis on available alternatives.
2. Verify the active-versus-remembered preset distinction and preview-button role with short task tests.
3. Test alternate accents, High contrast, System mode, hover, keyboard focus, narrow widths and enlarged text before choosing a final treatment.

Do not remove checkmarks, dim available choices further, make the inactive-mode preset inaccessible, or add more borders simply to raise visual emphasis.

**N/O:** Actual setting changes, immediate-apply behavior, persistence, reset effects, system-mode following, disabled states, keyboard order, focus rendering, assistive technology labels, hit-target implementation, reduced motion, measured contrast, responsive behavior and cross-surface consistency. No WCAG or full-app acceptance claim is supported.

---

# R addendum: independent visual challenge

## Scope and verdict

Inspected R-light.jpg and R-dark.jpg from the same evidence directory at 1180×812 after completing the original P/Q review. No source or candidate mapping inspected. This is an additional visual comparison, not a fresh blind randomized trial: I know my preceding recommendation. The reported narrow capture attempt remained 1180×812 and is not narrow-layout evidence. Narrow behavior remains N/O and receives no score.

**R is the preferable compromise in these observed states.** Its current selections retain Q’s outlines and checkmarks, while unselected labels are visibly stronger than Q’s. This is particularly evident on Cobalt/Ember, Iris/Jade and High in R-dark. It restores the distinction between an unselected option and a potentially unavailable one without losing current-value boundaries. Relative to P, the advantage is selected-value scanning; relative to Q, the advantage is available-choice readability. These are localized improvements within the same anchors, not grounds to raise every score.

## R scorecard

| Dimension                         |   R | Confidence               | Positive evidence                                                                                                                                                                  | Negative evidence / next verification                                                                                                                                |
| --------------------------------- | --: | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Information hierarchy             |   3 | High                     | R-light/R-dark: current mode, both remembered Graphite presets, Azure and Standard remain clearly identifiable through checkmarks plus outlined fills.                             | P3: equal emphasis on the active and inactive mode’s preset remains; test which group users expect to alter the current preview.                                     |
| Readability / density             |   3 | High                     | R-dark: unselected preset and accent names, mode alternatives and High appear stronger than Q. R-light preserves readable labels and untruncated text. Density remains controlled. | P3: small subdued descriptions/footer remain. Measure contrast and test enlarged text; this is not a contrast-compliance finding.                                    |
| Color purpose / semantic accuracy |   3 | Medium                   | R-light/R-dark: selection is consistently outlined and checked; accent choices retain named colored dots.                                                                          | P3: alternate accent selections and keyboard focus still unobserved; inspect Iris/Jade with selection and focus separately.                                          |
| Surface consistency               |   3 | High                     | R-light/R-dark: the outline treatment stays consistent across selected controls without changing the panel’s material system.                                                      | P3: preview Accent sample retains button-like styling; verify its role and first-click interpretation.                                                               |
| Attention allocation              |   3 | High                     | R-light/R-dark: current values remain easier to pick out than P, while alternatives compete less through ambiguity than Q.                                                         | P3: multiple selected perimeters still compete in R-light, and preview Accent remains visually prominent. Compare change-task time as well as current-state reading. |
| Composition                       |   3 | High for this width only | R-light/R-dark: aligned rows, complete panel containment and stable geometry match P/Q.                                                                                            | P3: adjacent preset groups still have a modest separating gutter. No narrow evidence; separately verify real viewport reduction and text scaling.                    |

## What remains unchanged

All five original concerns remain relevant except that R materially reduces the first concern about Q’s unselected-label treatment. The small helper text, equal preset emphasis, preview ambiguity and multiple simultaneous selection outlines remain. No newly visible clipping, geometry regression or missing checkmark appears in R.

## Falsification and next verification

- Test “read the current mode, light preset, dark preset, accent and contrast” and “switch to another available option” separately. If R is slower or more error-prone than P/Q, the visual preference is not validated.
- Test identification of available versus disabled choices without hover. If Q performs equally well, its muted-label risk may be inconsequential; if R still reads as disabled, restoring label emphasis alone was insufficient.
- Test keyboard focus against selected outlines. The screenshots do not establish that these states are distinguishable.
- Capture actual narrower viewports, confirming changed screenshot dimensions and layout width. Do not accept the unchanged-width attempt as responsive validation.
- Preserve R’s checkmarks and stronger alternatives pending these tests; avoid additional decoration or score-driven changes.

No overall score, WCAG conclusion, behavior pass, narrow-layout score or full Host/application acceptance is claimed.

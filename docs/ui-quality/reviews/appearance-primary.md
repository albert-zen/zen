# Original blind P/Q review

## Result

Q makes selected options easier to identify in both themes; P is slightly calmer, especially in light mode. Neither demonstrates a broad quality improvement. Differences are localized and do not justify different whole-number scores under the fixed rubric.

## Scope and limitations

Inspected original P-dark.jpg, P-light.jpg, Q-dark.jpg and Q-light.jpg pixels at supplied 1180x812 viewport, plus fixed docs/ui-quality/rubric.md. No source, mapping, other reports, GUI operation or implementation inspection. Evidence version: four supplied files under deliverables/ui-appearance-hierarchy-20261109. No hashes inspected. Review order P-dark, P-light, Q-dark, Q-light; order bias remains possible. Appearance settings only, fictional fixture data. No interaction, persistence, responsive behavior, measured contrast, assistive technology or cross-surface product behavior established. Public product references were not pixel benchmarks. No overall score or acceptance threshold.

## Scorecard

Each score applies separately to P-dark, P-light, Q-dark and Q-light. H/M = confidence.

| Dimension                             | P-dark | P-light | Q-dark | Q-light | Confidence |
| ------------------------------------- | -----: | ------: | -----: | ------: | ---------- |
| Hierarchy and grouping                |      3 |       3 |      3 |       3 | H          |
| Color purpose                         |      3 |       3 |      3 |       3 | H          |
| Materials                             |      3 |       3 |      3 |       3 | H          |
| Readability and density               |      3 |       3 |      3 |       3 | M          |
| Attention allocation                  |      3 |       3 |      3 |       3 | M          |
| Composition, fixed-width scope        |      3 |       3 |      3 |       3 | H          |
| Navigation, visible scope             |      3 |       3 |      3 |       3 | M          |
| Accessibility, visible cues only      |      3 |       3 |      3 |       3 | M          |
| Interaction feedback/state integrity  |    N/O |     N/O |    N/O |     N/O | —          |
| Cross-surface consistency/product fit |    N/O |     N/O |    N/O |     N/O | —          |

### Concrete evidence and falsifiable improvements

- Hierarchy: In all four images, Appearance heading, labeled groups and aligned choices make structure clear. Q's outlined selections are quicker to locate; P gives primary theme selector stronger relative emphasis. Both place Light and Dark presets at equal prominence even when only one theme is active. P3: test whether users correctly identify which preset changes the current view without explanation.
- Color purpose: In all four images, accent swatches have names, descriptions and selection checks. Selected theme has a check and outlined treatment. Q applies outlined treatment more consistently to presets, accent and contrast. P's selected fills are subtler but still have checks. P3: test selected-state identification across groups without relying on hue. Contrast ratios unmeasured.
- Materials: In all four images, shared radii, inset choices, preview and outer card form a coherent system. Q's selected borders strengthen state consistency but add more visible outlines, most noticeably in Q-light. P has fewer competing edges but different selected treatments across groups. P3: compare selected, hovered and focused controls together before standardizing borders.
- Readability: No clipped labels observed in any image; compact labels/descriptions fit, including two-line footer. Secondary text is small; dark-theme descriptions and inactive labels appear subdued. Q's inactive theme/contrast labels appear more muted than P's. P3: measure actual text contrast and inspect at normal display scale before claiming a readability regression.
- Attention: In all four images, section title/theme selector are clear; reset is restrained. P is calmer. Q highlights several independent selections simultaneously, producing more competing edges, particularly Q-light. Both devote substantial space to schematic preview. P3: timed tasks should determine whether Q's clearer selections outweigh visual competition.
- Navigation: Named sidebar destinations and selected Appearance row establish location in all images. No return-to-work affordance visible within supplied frame; behavior/broader navigation N/O. P3: verify users can leave settings without searching.
- Feedback: Checks show static selections and copy says changes apply immediately, but screenshots cannot establish application, saving, failure handling or reversibility. N/O.
- Composition: All images have consistent left edges, even columns and comfortable outer margins; complete card fits. Both retain a relatively tall abstract preview while controls below are compact. P3: test shorter viewport and larger text for deliberate scrolling rather than clipping. Responsive behavior N/O.
- Accessibility: In all images, text names plus checks provide non-color selection cues. Q adds stronger boundaries. Keyboard focus, semantics, actual targets, contrast compliance and reduced motion N/O. P3: verify selected outlines remain distinguishable from keyboard focus.
- Product fit: One settings surface only. P/Q share terminology/structure; broader product fit cannot be scored reliably.

## Five highest-impact findings

1. P3, selected presets/accent/contrast: Q adds border around every selected control; P primarily uses fill plus check. Trigger: scanning current settings. Consequence: Q reduces dependence on subtle fill differences. Verify timed identification of all selected values, separately by theme.
2. P3, Q-light attention competition: Multiple blue selected outlines compete with theme selector. Consequence: busier control field, not observed task failure. Verify whether requested setting is located/changed more slowly than in P-light.
3. P3, inactive theme/contrast labels especially Q-dark: System, Light and High look subdued, risking unavailable rather than unselected interpretation. Verify enabled-state recognition and measure rendered contrast. No unreadability or disabled behavior established.
4. P3, both candidates' simultaneous Light/Dark preset groups: Both contain selected Graphite regardless of current theme. Labels explain distinction but preset affecting current preview is not additionally signposted. Verify first-time users predict which preset changes current view versus remembered alternative.
5. P3, both candidates' schematic preview: Area exceeds several functional groups while placeholder strokes give limited evidence of real text/surface differences. Verify users predict actual appearance after preset/contrast changes. Preserve preview if it measurably helps.

No P1 or P2 issue established.

## Three strengths

- Explicit selection checks, readable names and accent descriptions.
- Stable alignment and containment across light/dark themes.
- Clearly grouped settings, restrained reset and immediate-application explanation.

## Paired comparison and recommended compromise

Dark: slight preference Q for state legibility and consistent selected treatment. P retains attention advantage and somewhat stronger-looking inactive labels.
Light: no clear overall preference. Q's state boundaries clearer; P's reduced outline competition calmer.
Q improves local selection hierarchy, color semantics and material consistency. P stronger on restraint. Readability at best unchanged, possible Q inactive-label regression. Navigation/composition unchanged.
Unchanged weaknesses: small secondary text, abstract preview, equally prominent remembered presets, no focus/application feedback evidence.
Recommended compromise, derived from these findings: retain Q's explicit selected-state boundaries and checks, while preserving P-like legibility of available inactive labels; validate that selected outlines do not compete with focus. This is a recommendation, not an observed third candidate or a requirement to increase scores.
Next iteration: resolve enabled-versus-inactive readability and focus-versus-selection distinction first; then validate preview usefulness. Do not remove checks, collapse separate remembered presets without behavioral evidence, or add stronger decoration to imitate reference products.

## Top three falsifiable next checks

1. Blind, counterbalanced selection-recognition and setting-change tasks in both themes. Record errors/time. Q preference falsified if outlines give no recognition benefit or materially slow target finding.
2. Capture focus, hover and selection together; measure text/control contrast. Reject outline treatment if users cannot distinguish focus from selection or enabled from disabled options.
3. Test shorter/narrower viewport and enlarged text, then change presets/contrast. Verify containment, understandable preview changes and correct remembered-theme behavior.

# R follow-up addendum

## Evidence and limits

Inspected original R-light.jpg and R-dark.jpg, followed by R-focus-light-preset.jpg, R-focus-dark-preset.jpg, R-focus-accent.jpg, R-focus-contrast.jpg and R-focus-reset.jpg in the same deliverables directory. No source, mapping or GUI inspected. R was reviewed after P/Q with knowledge of prior findings, so this is not an independently order-blind comparison. Correction: I did not create or inspect separate crops. My earlier statement that some focus images were cropped was an unsupported inference from their presentation in the image-viewing output, not a property established about the source files. The parent reports that all source screenshots are unmodified 1180x812 originals, verified with PIL. My focus observations concern the visible rings and controls; I did not independently verify source dimensions. The screenshots do not establish responsive containment at other viewport sizes. All focus examples depict the dark theme: 'light-preset' identifies the Light preset group, not a light-theme focus state.

## Result

Current-setting visibility and available-option legibility are acceptable within the supplied static states, with medium-high confidence. This is an observed-scope judgment, not an acceptance gate or accessibility certification.

R-light and R-dark retain Q-like selected outlines, fills and checks on Graphite, Azure and Standard. All selected values are identifiable. Available alternatives remain visually distinct from the selection. System/Light/High and inactive option names look clearer than Q, particularly R-dark, reducing the prior visual concern that available options could seem disabled. No actual enabled behavior is proven.

R-focus-light-preset and R-focus-dark-preset show an additional pale offset ring around the focused Graphite control, separate from its existing blue-toned selected border. R-focus-accent and R-focus-contrast show the same additional ring around Azure and Standard. R-focus-reset shows a pale offset ring around Reset appearance, which has no selected fill/check. Focus versus selection is visually distinguishable in these dark-theme captures. That resolves the specific screenshot evidence gap, not live keyboard behavior, focus order, focus persistence, assistive technology semantics or light-theme focus visibility.

## Scores and regressions

Retain 3 for each of hierarchy, color purpose, materials, readability, attention and fixed-width composition, separately for R-light and R-dark. Confidence H for hierarchy/color/materials/composition; M for readability/attention. Visible navigation remains 3/M. Visible accessibility cues remain 3/M with stronger focus evidence; no forced score increase. Interaction integrity and cross-surface product fit remain N/O.

No material new regression versus P/Q observed. Versus P, R retains Q's extra selected-border competition, especially R-light (P3). Versus Q, inactive-label legibility appears improved without losing state boundaries. Persistent limitations: small secondary text, abstract preview usefulness, equal prominence of remembered Light/Dark presets. These are localized questions, not established task blockers.

## Next checks

1. Inspect and live-test focus in light theme and on unselected choices, including theme mode controls; verify selection/focus remain independently identifiable.
2. Measure actual text/control contrast and test enabled-state recognition for inactive options in both themes; current visual acceptability would be falsified by repeated unavailable-state misidentification.
3. Run counterbalanced current-setting recognition and setting-change tasks, plus narrower/shorter viewport and enlarged-text checks. Confirm R's retained borders help recognition without slowing target finding or causing overflow. Persistence, immediate application and reset behavior remain untested.

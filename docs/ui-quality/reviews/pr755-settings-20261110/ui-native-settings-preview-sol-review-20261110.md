> Publication copy: only local paths, if present, are removed; scores and reasons are unchanged. Original SHA256: 089e673fd459fe2e51c85ad0f3c9c319fc970511343e5816f572406c0e5fdc32.

# Independent native settings and preview review

Inspected the five reference originals first, then all ten candidate originals using view_image. Only the reference manifest was read. No code, other reviews, mappings, or historical scores inspected. Static evidence only. Rubric: 0 unusable, 1 major shortcomings, 2 mixed, 3 solid, 4 exceptional; N/O unobserved. No overall score or average.

Columns: H hierarchy; R readability/density; C purposeful color; M material consistency; A attention management; L layout; N visible navigation; K visible keyboard/accessibility cues. Confidence applies to visible evidence, not interaction behavior.

## References, separate assessment

Publisher framing, cropping, unknown CSS scale and capture dates limit transferability. No raw raster font-size comparisons were made. Linear team/members are historical December 2024 publication assets; Vercel assets are cropped documentation illustrations, not full application views. Source URLs: https://linear.app/docs/account-preferences ; https://linear.app/changelog/2024-12-18-personalized-sidebar ; https://vercel.com/docs/accounts .

| Original | H | R | C | M | A | L | N | K | Confidence and concrete reasons |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| linear-preferences.png |4|3|3|4|3|4|N/O|N/O|High: clear title/group/row/help hierarchy, aligned right controls and quiet dividers; generous spacing and gray help text. Gradient is publisher surround, not app chrome. Navigation/focus absent.|
| linear-team-settings-20241218.png |3|3|3|4|3|3|3|N/O|High: grouped sidebar, consistent icon tiles and summary counts; broad empty gutter separates navigation/content, long sidebar and cropped lower workflow constrain scanning. No visible focus.|
| linear-members-settings-20241218.png |4|3|4|4|4|4|3|3|High: coherent columns and row rhythm, differentiated invite action, active navigation and search outline/caret. Secondary metadata subdued. Only search focus is visible.|
| vercel-authentication-light.png |3|4|3|3|3|3|N/O|N/O|High within crop: strong heading, concise explanation and spacious action group. Provider colors compete equally for attention; right/left button groups leave a broad gap. No navigation/focus evidence.|
| vercel-emails-primary-light.png |4|4|4|4|4|4|N/O|N/O|High within crop: address/status/action hierarchy, text-labeled status chips and red destructive menu item. Menu anchored near overflow; footer distinct. Open menu does not establish keyboard focus.|

## Candidate originals, independent per-image assessment

Actual 1188×848 production Electron captures, fixed build and synthetic local-only FakeModel per assignment. Unconfigured Account is not treated as an error or live-account failure. General lower content is unobserved. Preview snapshots and draft strings do not establish sending, restoration, or persistence outcomes.

| Original | H | R | C | M | A | L | N | K | Confidence and concrete reasons |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
|13-light-account-unconfigured.jpg|3|3|3|3|3|3|3|N/O|High: title and two cards scan easily; explicit Not configured and next-step button. Subscription usage occupies a large mostly empty card; pale Refresh is visibly subordinate. Two navigation rails consume substantial width. No focused control shown.|
|14-light-general.jpg|3|2|3|3|2|2|3|N/O|High: card headings and full-width selects are consistent. Interaction explanation is dense; lower security explanation is cut by fixed footer, making continuation less clear. Apply is subdued with up-to-date text. No focus evidence.|
|22-light-explicit-appearance.jpg|3|3|3|3|3|3|3|N/O|High: mode, preview, presets, accent and contrast form a readable sequence. Checks supplement selection outlines; many similarly outlined options and dual selected presets add visual work. Reset is separated from choices. No observed focus state.|
|17-dark-account-unconfigured.jpg|3|2|3|3|3|3|3|N/O|High: cards and current nav remain distinct; secondary account/help text and disabled Refresh recede strongly. Clear next action but usage card remains mostly blank. No focused control shown.|
|18-dark-general.jpg|3|2|3|3|2|2|3|N/O|High: labels/selects have predictable alignment, while several subdued explanatory lines and clipped lower card demand effort. Footer overlays the reading continuation. Active General remains recognizable.|
|16-dark-appearance.jpg|3|2|3|3|3|3|3|N/O|High: preview and checked choices are legible; inactive preset labels and footer explanation are subdued. Accent samples carry meaning and checks prevent color-only selection. Numerous boxed options crowd the card moderately.|
|21-dark-preview-readonly-no-menu.jpg|2|2|3|3|2|2|3|N/O|High: tabs and split boundary distinguish panes; long wrapped raw outputs dominate both columns. Parent/preview drafts are present but provenance is below dense content. Read only beside bright send arrows is semantically ambiguous without interaction evidence. No focus observed.|
|23-light-preview-draft-restored.jpg|2|2|3|3|2|2|3|N/O|High: light surfaces and tab selection are consistent, two drafts visually distinct. Wrapped paths/JSON overwhelm content hierarchy; parent bottom message is partly hidden by composer and Back to live. Screenshot does not prove restoration.|
|08-light-B-forward-keyboard-focus.jpg|3|2|3|3|2|3|3|3|High: visible dark focus outline surrounds View sent message, with readable action label. Tool panel grouping helps, but input/output duplication and long paths create dense clutter; composer occludes bottom output. Focus score covers this control only.|
|11-light-A-source-focus-visible.jpg|2|2|3|3|2|2|3|3|High: visible source-chip focus outline is distinct, sender label readable; selected tab and split boundary orient. Dense wrapped paths in parent, clipped top child text and overlapping bottom affordances weaken hierarchy. Keyboard judgment covers source chip only.|

## Prioritized concrete findings

1. **Preview information hierarchy:** In 21/23/11, raw output paths and JSON receive nearly continuous body-text emphasis. Put verbose payloads behind compact labeled tool-result summaries, preserve selectable raw details, and elevate source identity and snapshot status near the pane heading. Current static views make provenance harder to find than technical payload.
2. **Fixed-bottom occlusion:** General 14/18 cuts through the foreground-control explanation; preview/chat 23/08/11 hides content behind composers and Back to live. Provide sufficient content-bottom clearance and a clearly discoverable continuation/scroll cue. The screenshots establish occlusion, not whether scrolling resolves it.
3. **Dark secondary readability:** 17/18/16 use subdued text for meaningful explanations, not merely decorative metadata. Strengthen the meaningful help/description tier while keeping disabled controls distinct. No measured contrast or WCAG conclusion is made.
4. **Preview affordance semantics:** Read only and an enabled-looking blue send arrow coexist in 21/23. Visually clarify whether read-only describes tool permissions or the conversation itself; place snapshot/side-chat explanation closer to composer or header. Do not infer disabled sending from this label.
5. **Appearance choice economy:** 22/16 communicate selections with both checks and outlines, a strength worth retaining. Reduce simultaneous visual weight across mode buttons, two preset groups, accent tiles and contrast buttons, for example stronger group spacing and quieter inactive borders. Keep separate light/dark preset labels explicit.
6. **Account empty-state economy:** 13/17 accurately explain unconfigured state and offer model settings. A smaller usage placeholder or closer coupling of usage availability to connect guidance would reduce vacant card area without manufacturing an error treatment.
7. **Preserve observed focus cues:** 08/11 show a dark visible outline on the focused labeled action/source chip. Keep equivalent cues across controls; these two examples do not establish tab order, focus coverage, screen-reader labeling, or accessibility completeness.

No interaction outcomes, numeric improvement, complete accessibility, or current-product equivalence to references are claimed.

> Publication copy: only local paths, if present, are removed; scores and reasons are unchanged. Original SHA256: 093186ef77505d9f38fa1281cd717e2a6733789b567c5c41acb40637a3cd38af.

# Independent visual baseline review

Scope: only the five supplied originals and brief. Scores are independent image-level judgments: 0 unusable, 1 major shortcomings, 2 mixed, 3 solid, 4 exceptional; N/O means not observable. Confidence applies to the visible image, not the product. Reference images are enlarged public documentation crops, with different task and scale and no surrounding app navigation; they are not verified current live-product captures. Their scores are not direct like-for-like comparisons with the 1188 × 848 dark Linux Electron candidate captures.

## Reference images

| Image | Dimension | Score | Visible evidence; confidence |
|---|---|---:|---|
| Linear preferences | Hierarchy | 4 | Large Preferences heading, distinct section headings, then row labels and subdued descriptions create clear levels. High. |
| Linear preferences | Readability/density | 3 | Spacious rows and legible enlarged text; gray descriptions are less prominent than labels. High within crop; actual-scale readability not established. |
| Linear preferences | Purposeful color | 3 | Purple switches identify enabled-looking states while the rest remains neutral. High for visible appearance. |
| Linear preferences | Material consistency | 4 | Repeated dark cards, separators, rounded selects and aligned switches form a coherent system. High. |
| Linear preferences | Attention allocation | 3 | Labels lead and controls sit consistently at right; bright exterior gradient is visually prominent but outside the settings content. Medium. |
| Linear preferences | Layout | 4 | Consistent row spacing, aligned text and controls, clear section separation. High. |
| Linear preferences | Visible navigation | N/O | This crop does not show surrounding navigation. High. |
| Linear preferences | Visible focus/accessibility cues | 2 | Text labels, switch position and selected values provide state cues; no keyboard focus is visible. Medium; not an accessibility compliance assessment. |
| Vercel email | Hierarchy | 4 | Heading, explanatory copy, grouped addresses, status badges and action menu are distinct. High. |
| Vercel email | Readability/density | 4 | Large dark text, generous spacing and short rows are easy to scan at this crop scale. High; actual-scale readability not established. |
| Vercel email | Purposeful color | 4 | Blue Verified, green Primary and red Delete convey distinct status/action roles, reinforced by words. High. |
| Vercel email | Material consistency | 3 | Fine borders, rounded controls and popover use a restrained consistent light surface language. High. |
| Vercel email | Attention allocation | 3 | Addresses and status are prominent; the open menu clearly exposes actions, with red reserved for Delete. High. |
| Vercel email | Layout | 3 | Aligned rows and roomy menu are orderly; menu overlaps lower page content. High. |
| Vercel email | Visible navigation | N/O | No surrounding product navigation appears in the crop. High. |
| Vercel email | Visible focus/accessibility cues | 2 | Written status badges and action labels are visible; ellipsis actions are icon-only and no focus ring is shown. Medium; keyboard and assistive behavior unobserved. |

## Candidate images

| Image | Dimension | Score | Visible evidence; confidence |
|---|---|---:|---|
| context-upper.jpg | Hierarchy | 3 | Page title, card titles and field labels establish levels; long help paragraphs compete within the budget card. High. |
| context-upper.jpg | Readability/density | 2 | Small muted gray copy and several long paragraphs are dense at capture scale, particularly near the bottom. High. |
| context-upper.jpg | Purposeful color | 3 | Neutral palette reserves brighter treatment for text and selected navigation; switch has a visible position. Medium, since only one state is shown. |
| context-upper.jpg | Material consistency | 3 | Dark rounded cards, outlined fields and quiet borders recur coherently. High. |
| context-upper.jpg | Attention allocation | 2 | Title and selected section are evident, but explanatory text occupies much of the viewport and competes with the two numeric controls. High. |
| context-upper.jpg | Layout | 3 | Two aligned inputs share a row and cards sit within a consistent content column; lower card continues below viewport. High. |
| context-upper.jpg | Visible navigation | 3 | Global sidebar, settings categories and highlighted Context compaction make location visible; some sidebar text is truncated. High. |
| context-upper.jpg | Visible focus/accessibility cues | 2 | Inputs have visible labels and the switch has a position; no focused input or focus ring is shown, and muted labels are small. Medium. |
| context-lower.jpg | Hierarchy | 3 | Retention and summary cards, labels and controls are grouped; collapsed explanations are visually subordinate. High. |
| context-lower.jpg | Readability/density | 2 | Small muted helper text is hard to scan; prompt text is brighter but its field continues below the viewport. High. |
| context-lower.jpg | Purposeful color | 3 | Neutral surface hierarchy and selected sidebar use color sparingly; control values remain legible without relying solely on color. Medium. |
| context-lower.jpg | Material consistency | 3 | Matching card corners, outlined dropdowns and text area fit the same visual vocabulary. High. |
| context-lower.jpg | Attention allocation | 3 | Primary selects and checkbox stand apart from optional explanations; lower text area draws attention through its brighter multiline copy. Medium. |
| context-lower.jpg | Layout | 3 | Controls span an aligned column with clear spacing; fixed footer obscures the continuation at this scroll position. High. |
| context-lower.jpg | Visible navigation | 3 | Selected settings item and sidebar remain visible; scrollbar shows position in longer content. High. |
| context-lower.jpg | Visible focus/accessibility cues | 2 | Checkbox, selected values and disclosure triangles give visible state cues, but no keyboard focus is shown. Medium. |
| context-explanation.jpg | Hierarchy | 3 | Expanded disclosure inserts supporting explanation under its label; card headings and controls retain order. High. |
| context-explanation.jpg | Readability/density | 2 | Expanded explanatory paragraph adds several lines of small low-emphasis text, increasing scan burden and pushing the summary further down. High. |
| context-explanation.jpg | Purposeful color | 3 | Restrained neutral palette distinguishes selected navigation and text/control surfaces; disclosure state also uses triangle direction. Medium. |
| context-explanation.jpg | Material consistency | 3 | The expanded block fits the same muted text, border and card language as the remaining settings. High. |
| context-explanation.jpg | Attention allocation | 2 | The opened explanation is discoverable, but its dense paragraph and adjacent helper text compete with controls; the next card is only partly visible. High. |
| context-explanation.jpg | Layout | 3 | Explanation flows between disclosure and checkbox without visible overlap; extra height reduces what fits above the footer. High. |
| context-explanation.jpg | Visible navigation | 3 | Persistent highlighted settings category and scrollbar provide location cues. High. |
| context-explanation.jpg | Visible focus/accessibility cues | 2 | Downward versus rightward triangles distinguish open and closed disclosures; visible labels and values help, but focus is not shown. Medium. |

## Specific checks to falsify or confirm concerns

- At the captured viewport and normal viewing distance, ask participants to find and explain the trigger, budget, and difference between host and agentic compaction using only the visible upper section. Record time and misreadings; test the small muted helper copy with representative vision and display settings.
- In the lower and expanded views, ask participants to locate retention mode, interpret what is counted, and find the summary instruction. Compare completion and errors with disclosure closed and open; verify the footer does not prevent reaching or reading the complete text when scrolling.
- Test whether users can identify their current settings category and distinguish the two truncated sidebar entries without relying on hidden text. Test keyboard navigation separately, including a visible focus indicator on each control and disclosure, and check screen-reader names and states.
- Measure rendered text and control contrast in the actual application and test zoom/reflow; screenshot appearance alone cannot establish WCAG conformance.

## Limits

Only one dark theme and synthetic local FakeModel fixture are visible. These stills do not establish compaction semantics, toggle consequences, retention, saving, persistence, keyboard operation, screen-reader behavior, WCAG compliance, or whole-product quality. No focused input is shown. Content outside a crop or below the viewport is not evidence of missing functionality. Requested model labels are assignment labels, not independently attested serving backends.

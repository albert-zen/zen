> Publication copy: only local paths, if present, are removed; scores and reasons are unchanged. Original SHA256: 8bb609ce576f898d7452c28bd2a7735814b24948d96e91ae90cb1bd27a5a941f.

# Independent native UI evidence review

## Method and limits

I inspected the five public-reference originals first, then each of the ten candidate originals. The references are publisher assets, not verified current live-product captures. Linear’s two 2024 redesign images are historical; the Vercel images are cropped. Sources and capture limitations are documented in the supplied manifest:

- [Linear Preferences](https://linear.app/docs/account-preferences)
- [Linear team and members settings](https://linear.app/changelog/2024-12-18-personalized-sidebar)
- [Vercel account settings](https://vercel.com/docs/accounts)

Scores are independent, not averages or overall scores: **0** unusable, **1** major shortcomings, **2** mixed, **3** solid, **4** exceptional. N/O means not observed. Columns: hierarchy (H), readability/density (R), color purpose (C), material consistency (M), attention (A), layout (L), visible navigation (N), visible keyboard/accessibility cues (K). Confidence reflects the visible evidence, not behavioral verification.

## Public references, scored separately

| Original | H | R | C | M | A | L | N | K | Confidence and visible reasons |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Linear Preferences | 4 | 3 | 3 | 4 | 3 | 4 | N/O | N/O | High for shown panel. Clear headings, descriptions and aligned controls; muted help text recedes. Navigation and focus are outside evidence. |
| Linear team settings | 3 | 3 | 3 | 4 | 3 | 3 | 3 | N/O | Medium. Grouped sidebar and consistent summary rows are clear; long sidebar and cropped lower workflow limit assessment. |
| Linear members | 3 | 3 | 3 | 3 | 3 | 3 | 4 | 3 | Medium. Active Members item and column structure are identifiable; purple search outline and caret are visible, but do not establish keyboard behavior. |
| Vercel Authentication | 3 | 3 | 3 | 3 | 3 | 3 | N/O | N/O | Medium for crop. Heading, explanation and grouped provider actions read clearly; branded buttons compete somewhat for attention. |
| Vercel Email | 3 | 3 | 4 | 3 | 3 | 3 | N/O | N/O | Medium for crop. Labels accompany colored status pills; red Delete distinguishes a destructive action. Open menu is visible but focus is not. |

## Candidate originals

| Original | H | R | C | M | A | L | N | K | Confidence and visible reasons |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 13 light account | 3 | 3 | 3 | 3 | 3 | 3 | 3 | N/O | High for shown state. Account heading, unconfigured status, next action and usage area are distinct; muted secondary text is less prominent. |
| 14 light general | 3 | 2 | 3 | 3 | 2 | 2 | 3 | N/O | High for visible upper page. Controls align, but long interaction guidance and the foreground-control section crowd the lower viewport; sticky footer obscures lower content. |
| 22 light appearance | 3 | 3 | 3 | 3 | 3 | 3 | 3 | N/O | High. Theme, presets, accents and contrast are grouped; selection has both checkmarks and outlines. Dense preset grid requires careful scanning. |
| 17 dark account | 3 | 2 | 3 | 3 | 3 | 3 | 3 | N/O | High. Structure and action are clear, but subdued descriptions and disabled Refresh have weak visual separation from dark surfaces. |
| 18 dark general | 3 | 2 | 3 | 3 | 2 | 2 | 3 | N/O | High for shown upper page. Same compact grouping and footer overlap as light; muted explanatory copy is harder to distinguish. Lower page not captured. |
| 16 dark appearance | 3 | 2 | 3 | 3 | 3 | 3 | 3 | N/O | High. Checkmarks and selected backgrounds distinguish choices; unselected preset cards and muted captions have subtle boundaries. |
| 21 dark preview | 2 | 2 | 3 | 3 | 2 | 2 | 3 | N/O | Medium. Two composers and side-chat context are visible, but raw wrapped result text dominates; bottom composer overlays conversation content. Static image does not prove draft or read-only behavior. |
| 23 light preview | 2 | 2 | 3 | 3 | 2 | 2 | 3 | N/O | Medium. Two local draft texts and snapshot explanation are visible; long wrapped result and overlapping composer reduce scanability. Restoration is not proven by the screenshot. |
| 08 light forward focus | 3 | 2 | 3 | 3 | 2 | 2 | 3 | 3 | Medium. Focus outline around “View sent message” is distinct; result blocks and sticky composer compete for vertical space. Only this visible focus cue is assessed. |
| 11 light source focus | 2 | 2 | 3 | 3 | 2 | 2 | 3 | 2 | Medium. A dark outline identifies the source label, but its boundary is visually tight and intersects nearby content. Two narrow panes amplify wrapping and bottom overlays. Only the shown cue is assessed. |

## Prioritized findings

1. **Protect reading space in split preview.** Long raw command results dominate narrow panes and wrap heavily; composers and “Back to live” controls cover or crowd content near the bottom. Reserve non-overlapping scroll space and consider a more compact, expandable result presentation.
2. **Clarify dense General content.** The interaction explanation and foreground-control section are visually crowded, and the fixed footer covers the bottom of the captured section. Preserve room for content above the footer and shorten or progressively disclose explanatory text.
3. **Strengthen secondary dark-theme legibility.** Account descriptions, General helper text, and unselected Appearance labels are subdued against nearby dark surfaces. Increase visual distinction while retaining hierarchy; this is a visual observation, not a measured contrast claim.
4. **Polish visible focus treatment.** The forward-message outline is readily identifiable. The source-label outline is tighter and visually interrupted by adjacent content; give it breathing room and test other controls separately. Neither screenshot establishes complete keyboard accessibility.
5. **Preserve strong state cues.** The selected Appearance options use checkmarks as well as color and borders, while Account shows a clear unconfigured state and a next action. Keep these redundant, task-oriented cues.

No interaction outcomes, full accessibility, WCAG compliance, lower General content, or numeric changes against earlier rounds can be established from these images.

> Publication copy: only local paths, if present, are removed; scores and reasons are unchanged. Original SHA256: d42c5e06ec55b5d103d968cd3a1706a6bb174b089afc049aa7aee06765a546a8.

## Independent visual review

Scale: 0 unusable, 1 major weakness, 2 mixed, 3 solid, 4 exceptional. N/O means not observed. Columns: H hierarchy, R readability, C color, M material/style, A attention, L layout/density, N navigation/context, F visible keyboard focus.

### Public references

| Reference | H | R | C | M | A | L | N | F |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex project thread | 3 | 2 | 3 | 3 | 3 | 3 | 3 | N/O |
| T3 details, before/after | 3 | 3 | 3 | 3 | 3 | 3 | 3 | N/O |
| T3 model picker, before/after | 3 | 3 | 3 | 3 | 3 | 3 | 3 | N/O |
| Linear preferences | 4 | 4 | 3 | 4 | 4 | 4 | 2 | N/O |
| Vercel emails | 4 | 4 | 4 | 4 | 4 | 4 | 2 | N/O |

Evidence:
- Codex: central project prompt and composer anchor the page; sidebar and footer are small at this published scale.
- T3 details: grouped rows, separators and color-coded change counts support scanning; the blue Merge button commands attention in the after view.
- T3 picker: search, provider rail and selection check organize the menu; the surrounding content is obscured by the overlay.
- Linear: large headings and aligned labels and controls form clear sections; the crop does not show broader navigation.
- Vercel: status badges, row actions and a clearly separated destructive menu item are easy to distinguish; broader account context is cropped.

### Candidate images

| Image | H | R | C | M | A | L | N | F |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 02 | 2 | 2 | 3 | 3 | 2 | 2 | 3 | N/O |
| 04 | 2 | 2 | 3 | 3 | 2 | 2 | 3 | N/O |
| 07 | 2 | 2 | 3 | 3 | 2 | 2 | 3 | 3 |
| 08 | 2 | 2 | 3 | 3 | 2 | 2 | 3 | 3 |
| 10 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | N/O |
| 11 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | N/O |
| 12 | 2 | 2 | 2 | 3 | 2 | 2 | 3 | N/O |
| 14 | 2 | 2 | 2 | 3 | 1 | 1 | 2 | N/O |
| 15 | 2 | 2 | 2 | 3 | 1 | 1 | 2 | 3 |

Evidence:
- **02:** Information panel identifies the agent, status and received messages. Long raw command output dominates the center; message summaries and source links are small and subdued.
- **04:** Child breadcrumb and empty information explanation establish context. Expanded tool output is dense, and content continues behind the composer.
- **07:** The second source row has a distinct outline. The similarly styled message summaries require close reading to tell A from B.
- **08:** Child context and outlined tool-result region are visible, but the large raw result competes with the source message; the composer overlaps lower content.
- **10:** Settings navigation and General heading are clear, with controls grouped in cards. The bottom card is partially visible above the fixed footer.
- **11:** Lower settings, including Browser, Native cross-device tools and Compact shell output, are visible; the scrollbar is near the bottom. Small helper text is dense. This is the same page at a different scroll position, not evidence that the lower controls are inaccessible.
- **12:** Dark palette preserves grouping and context, but gray secondary information and message excerpts recede noticeably.
- **14:** Information panel overlays much of the parent conversation while a companion pane occupies the right. The two composers and raw outputs compete for attention; narrow text columns wrap heavily.
- **15:** Same crowded split-pane composition, with a visible outline around a source row. The focus indicator is distinguishable, though surrounding message copy remains subdued.

### Priorities

1. Reduce competition from raw tool output: visually collapse or summarize it while preserving access to details.
2. Improve split-pane attention and legibility: avoid the information panel covering so much parent content, and preserve enough width for messages.
3. Strengthen secondary text and differentiate received-message excerpts, particularly in dark mode.
4. Keep focus indication as clear as the outlined source rows, and verify its behavior across controls in an interactive test.
5. Consider more prominent source and result labels so users can trace a message without parsing raw output.

### Limits

These are static visual observations, not proof that keyboard navigation, scrolling, or any interaction succeeds. The public references differ in task, scaling, cropping and age, so they support general quality comparisons rather than pixel-equivalent judgments. Candidate data is isolated synthetic QA at a native 1188×848 viewport; the split panes are not narrow OS windows.

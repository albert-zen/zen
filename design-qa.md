# ZenX welcome draft and Project switcher design QA

## Source visual truth

- `/var/folders/kn/qprvl_8n6vn88tcp8tv_h2ph0000gn/T/codex-clipboard-0995f127-24d2-4d6c-80f0-3341ad7dbe63.png`
  - 2560 × 1640 pixels. User-marked packaged ZenX welcome state: remove or replace the generic compose glyph, lower the welcome content, and verify horizontal centering.
- `/var/folders/kn/qprvl_8n6vn88tcp8tv_h2ph0000gn/T/codex-clipboard-36207038-e6bb-4761-96aa-bc6a043d7f46.png`
  - 830 × 598 pixels. Codex reference for a fixed search row, scrollable Project results, fixed bottom actions, and viewport containment.

## Implementation evidence

- `/Users/xbjt/work/agent-data/projects/zen/evidence/zenx-ui7-final-welcome.png`
  - 1199 × 768 pixels. Final packaged ZenX welcome state.
- `/Users/xbjt/work/agent-data/projects/zen/evidence/zenx-ui7-final-project-menu.png`
  - 1199 × 768 pixels. Final packaged ZenX Project menu state.
- `/Users/xbjt/work/agent-data/projects/zen/evidence/zenx-ui7-welcome-comparison.png`
  - 2398 × 802 pixels. The 2560 × 1640 user screenshot normalized to the 1199 × 768 implementation size and placed beside the final packaged capture.
- `/Users/xbjt/work/agent-data/projects/zen/evidence/zenx-ui7-project-menu-comparison.png`
  - 1040 × 424 pixels. Focused Codex-menu reference and final packaged ZenX menu in one comparison image.
- Packaged app: `/tmp/zenx-ui7-final-h4o1d9/ZenX.app`.

## Viewport and state

- Final Electron CSS viewport: 1280 × 820; macOS dark mode.
- Computer Use screenshots are 1199 × 768 pixels for that window. The user's 2560 × 1640 screenshot has the same aspect ratio and was downsampled to the implementation screenshot size for the welcome comparison.
- The Project menu was opened in the packaged app. Runtime geometry confirms the scroll clipping region is `top=44, bottom=638`, while the menu is `top=60.25, bottom=313.25`; it remains fully inside the visible messages region with a 16px top inset.

## Findings and fidelity surfaces

- Fonts and typography: ZenX keeps its established system typography and hierarchy. The central prompt remains one concise heading with the Project name as its only interactive emphasis.
- Spacing and layout rhythm: the generic compose glyph is removed. The heading now fills and centers within the available message region, moving it visibly down from the user-marked state. Its geometric center matches the right-side workspace center; the earlier apparent horizontal drift came from the Sidebar's visual weight and the glyph above the heading.
- Colors and visual tokens: all changed surfaces reuse existing ZenX border, surface, text, focus, and shadow tokens.
- Image and asset fidelity: the welcome state no longer adds a redundant icon or substitute asset. The existing production ZenX brand remains in the macOS Sidebar brand row.
- Copy and content: Project names, search, selected state, and `Add project` match ZenX product semantics. The Codex reference's projectless action is intentionally omitted because ZenX still requires a Project for first Send.
- Interaction and containment: search and bottom actions remain fixed while only Project results scroll. The menu is clamped against the actual `.messages` clipping region, not only the browser viewport, so the search row no longer disappears behind the titlebar.

## Comparison history

- Pass 1 found the Project list could exceed the visible region and the macOS brand occupied the traffic-light row.
- Pass 2 fixed internal Project scrolling, viewport placement, and the macOS-only second-row brand, but packaged evidence exposed that the menu could still cross the workspace's own clipping boundary.
- Pass 3 fixed placement against the `.messages` clipping rectangle. Packaged geometry and the final menu screenshot confirm the complete search row, scrollable results, and fixed action are visible.
- Pass 4 addressed the user's welcome-state polish: removed the generic compose glyph and centered the heading through the available message region. The normalized before/after comparison confirms the content moved down and remains horizontally centered.

## Verification evidence

- Project/titlebar UI tests: 37/37 passed.
- ZenX typecheck, repository format check, lint, and `git diff --check`: passed.
- Portable packaging passed with provider manifest digest `f4c4c70eee9be26166d804534126569e0dde22b18ac9d6e855b2d3eeabb8f0dd`.
- Packaged startup reached `Local service ready`; welcome and open-menu states were captured from the final package.

## Follow-up polish

- No P0/P1/P2 visual findings remain. Additional spacing or typography changes would be subjective iteration rather than fidelity blockers.

**final result: passed**

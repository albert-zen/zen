# Information experience acceptance: 452cd789

This is a screenshot evidence branch, not an additional product change or a merge target.

- PR: https://github.com/albert-zen/zen/pull/716
- Product head: 452cd789603a4de67c4b8b871a6a8f07a981b9df
- Product tree: bacf981b4987baa2371d5eb60f3e40925befcbf6
- Tested GitHub PR merge: 81d3fbad8a83c8136983db37711330fea33d3509 (head above + main 01b9282d).
- All displayed content is synthetic test data. No real user screenshots, profile, credentials, external model calls or private conversations are included.

## Component and entry evidence

[Workflow](https://github.com/albert-zen/zen/actions/runs/42040200866) passed all 74 focused tests, 7 content/control cases and 12 entry layout/pointer cases. Artifact 13420731595 SHA256: 7116f0cfc1098163058856873988d6e3333ba114257dd82c6eda19428cac490e.

These images use actual production components and CSS with synthetic in-memory ports and an outer preview scaffold. They are Chromium component evidence, not native OS evidence. All 20 content and 14 entry source hashes were checked against the final product source.

- 01-empty-light.png: empty cards and their unavailable/refresh placeholders are absent; the user's management and close controls remain.
- 06-desktop-light-toggle-on.png: actual mouse toggle, thumb within its track, no visible duplicate Enabled/Paused text.
- 07-narrow-dark-toggle-on.png: narrow dark layout and switch state.
- 05-populated-boards.png: real populated independent Board components remain visible.
- JSON files retain exact captured source hashes, case receipts and geometry for on/off mouse and touch states.

## Native full App evidence

[Workflow](https://github.com/albert-zen/zen/actions/runs/42040201081) passed both platforms.
- macOS artifact 13420348552: 34 cases / 104 steps, informationOsInput.status=passed, repeatedMaximizedMainToggle=true, repeatedSplitOverlayToggle=true, permissionChanges=false.
- Windows artifact 13420024108: 26 cases / 88 steps. Its boundary is Electron trusted DOM input; this is not Windows physical OS hit testing.
- macOS information entry was opened/closed twice in each mode using scoped CoreGraphics OS input, with DOM receipts after every action.
- The 35 recorded source/script hashes match the final source. Windows hashes match after its checkout's CRLF conversion.
- macos-17-0-os-split-information.png: icon belongs to the trailing main-conversation title row; its content is an overlay.
- macos-16-0-os-main-information.png: maximized main tab restores shared-row placement and a non-overlapping dock.
- The final images were opened and visually reviewed. Native artifact ZIP digests were verified.

## Boundary

The targeted work is accepted. The broader repository CI was still running when this evidence was prepared and is not claimed as a complete pass. PR remains draft; no merge or deployment is authorized.

# PR #451: context after-state evidence

Evidence-only branch. Do not merge this branch; source work remains in draft [PR #451](https://github.com/albert-zen/zen/pull/451).

This directory publishes **only 14 context-after PNGs**, each an unmodified Chrome screenshot of actual production components with synthetic facts. It does not publish before comparisons or Sidebar captures. No user data, Host connection, or native user screenshot is involved.

- Source head: `a79e716db977ab6e3691de3d13de6b0ad91ac972`.
- Source tree: `b5ff211095ae4f396952efd12fa157e439f9493e`.
- Captured GitHub PR merge ref: `afb1c1c7c82f37ab1c6b43cf33bd97783c4cd137`; its tree was verified identical to the source-head tree.
- Capture step succeeded in [CI run 39397338581](https://github.com/albert-zen/zen/actions/runs/39397338581). Full CI status is tracked in the source PR.
- [Capture source and assertions](https://github.com/albert-zen/zen/blob/a79e716db977ab6e3691de3d13de6b0ad91ac972/apps/zenx/scripts/capture-approved-ui-preview.mjs).

## Boundaries and observations

This is **desktop-input emulation in Linux Chrome**, not physical macOS/Windows hardware, keyboard input or native Electron window validation. Actual browser media queries report fine/hover/any-fine/any-hover true and coarse/none false. No product CSS or JavaScript media-query stub is used. Chinese fonts come from the official Ubuntu package repository.

The published after-state samples cover 390/900px widths, light/dark themes, above/below placement, pressed feedback, and reduced motion. The wide light example also includes two real animation samples:

- Hover scale: 1.12; pressed scale: 0.96.
- Target: unchanged 36×36px.
- Popup opacity at 30/150ms: 0.5/1, with identical popup rectangles.
- Hover-bridge crossing, focused Escape, stable usage facts, and no horizontal overflow pass.
- Reduced motion disables scale/animation without moving the target.

All published PNGs were visually inspected. Chinese labels render correctly. Below-position popovers intentionally cover synthetic fixture instructions, which are not application content. Independent representative inspection found no obvious clipping or overlap.

The production design is unchanged by capture work. These technical checks are not new user aesthetic approval or authorization to merge. Omitted comparisons remain unpublished here.

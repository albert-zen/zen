# ZenX UI/UX audit (2026-09-30)

Scope: renderer UI at `cb4b311` (integrated from `9a99c15`, including Room/Trigger storage at `cb4b311`). Findings combine source review, the supplied Rooms screenshot/AX evidence, and targeted UI/UX Pro Max searches. This report stays concise and records evidence for the implementation in this branch.

## Evidence and comparison

- Supplied ZenX Rooms screenshot/AX tree: the first viewport is consumed by long delivery/status history; every transcript row reads `Agent`/`agent`, so the human-versus-agent distinction is not scannable; Members/settings and composer controls have weak hierarchy.
- ZenX source: `apps/zenx/src/renderer/src/bundled-automation-ui.tsx` renders the entire operation list and labels transcript rows with raw `message.kind`; `styles.css` allows a vertically resizable Room textarea and caps status only after all rows are rendered.
- ZenX source: `ContextUsageIndicator` is absolutely positioned inside the scrollable `.bottom-zone`; this makes the popover vulnerable to clipping at the composer viewport edge.
- ZenX source: `.app-shell:has(.auxiliary-panel[data-open="true"]) #thread-browser-toggle { display: none; }`, which intentionally removes the only persistent side-panel toggle as soon as the panel opens and explains the reported flicker/disappearance.
- ZenX source: jade accent maps `--color-focus-ring` to bright green; the composer also adds that ring on every focus-within state. This is visually noisy for the Harbor/jade input state while keyboard focus still needs a visible neutral treatment.

Comparable public product evidence:

- [OpenAI Codex app announcement](https://openai.com/index/introducing-the-codex-app/) describes separate agent threads, project organization, and an in-app side panel for reviewing work. This supports persistent panel affordances and concise task hierarchy.
- [OpenAI Codex for every role and workflow](https://openai.com/index/codex-for-every-role-tool-workflow/) describes role-specific plugins and annotations; role/action labels should remain visible and meaningful in context.
- [Karma](https://karma.build/) presents a calm workspace for multiple coding agents; its public information architecture foregrounds workspace/task identity over long status prose.
- [Karma developer docs](https://karma.build/docs/) describes `agent ctx` as a compact briefing containing role, workspace, teammate roster and inbox, a useful model for concise role metadata.

UI/UX Pro Max searches used:

- `accessible message role labels` (`ux`): interactive chips need native button semantics, accessible names and visible focus; inputs need associated labels.
- `popover clipped viewport boundary` (`ux`): viewport-aware placement and mobile-safe viewport units are required; clipping is a layout defect.
- `icon button accessible label` (`icons`): use one consistent SVG icon family, hide decorative icons, and provide accessible names for icon-only actions.
- Design-system search for `AI workspace chat dashboard hierarchy compact status`: recommended Swiss/minimal dashboard direction, clear hierarchy, sparse decoration, high contrast and visible focus.

## High-priority findings

1. Rooms transcript role ambiguity (High): human and agent rows use the same raw `kind` treatment. Use explicit role chips (`You`, `Agent`, `System`) and member metadata so identity is legible without reading text.
2. Rooms status/history overload (High): long operation history and repeated explanatory copy consume the first viewport. Keep the latest three operations visible and collapse older entries behind a single disclosure.
3. Composer hierarchy (High): mention chips, textarea, helper copy, and Send action lack a clear grouping; textarea exposes a resize bar and is too tall by default. Use a compact fixed-height input with a smaller helper line.
4. Context popover clipping (High): absolute popover inside a scrollable bottom zone can be cropped. Place it in viewport coordinates with bounded width.
5. Side panel toggle disappearance (High): the toggle is hidden while open, causing reported flicker and removing the stable close/reopen affordance. Keep it visible and update its label/state.
6. Focus treatment (Medium): jade/Harbor bright green ring overwhelms the composer. Preserve keyboard visibility with a neutral border/ring while removing the green focus-within halo.
7. Tool/status vocabulary (Medium): `Running`/`Waiting` and generic terminal iconography remain in completed traces; use completion tense and status-aware icons where safe. This branch limits scope to presentation copy and avoids changing protocol semantics.
8. Model catalog/settings and print popup (Medium): need follow-up review with persisted model catalog fixtures and CUA screenshots; no speculative refactor included here.

## Implemented in this branch

- Room role chips, member role metadata, compact transcript cards and latest-three status history with older disclosure.
- Compact non-resizable Room composer and reduced redundant helper copy.
- Viewport-fixed context usage popover placement.
- Persistent side-panel toggle while open.
- Neutral composer focus treatment and jade focus ring fallback.
- Presentation vocabulary cleanup for completed tool rows where covered by existing projection helpers.

## Validation

- `npm run typecheck --workspace @zen/zenx` passed (Node and web TypeScript projects).
- `npx tsx --test test/host-profile.test.ts test/model-settings.test.ts test/tool-presentation.test.ts test/turn-projection.test.ts` passed: 42 tests, 0 failures, including hidden preset persistence and completed tool vocabulary.
- Remaining findings are the print-message popup/icon polish, full model-selector persistence review, and direct CUA screenshot comparison across light/dark themes.

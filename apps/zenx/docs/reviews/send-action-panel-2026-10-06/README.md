# Send action panel: design and verification

This is evidence for the focused send-control redesign. `apps/zenx/docs/ui-ux.md` remains the durable product authority. Send, queue, steer, replace and preference ownership remain in their existing callers.

## What the baseline showed

The current production `ThreadView` was rendered in native Electron with synthetic conversation data. At 1120×800, idle hover showed a flat Send row and a native preference selector; running hover showed five flat rows with no explanation of their execution differences. The primary button claimed `aria-haspopup="dialog"` even though clicking it submitted. Touch had no visible options control. The idle/running panels differed in content and height, and lacked a shared primary-action explanation.

Before source: main `c5855dc0f681177985915219fe912ec88fc278f4`. Reviewed implementation: `e484b9d830da990c902e8be3cc5ec96263c56bae` (production source identical to native capture source `9d164c3b9b2deb31c4cc49d6585cf908d081e94e`), on integrated main `838910493b41283171c4e095b1486b8b62df2fe7`. All after captures use the production components and theme CSS, with synthetic data and callbacks. They do not claim a live model/provider or protocol round trip.

## Design references and choice

1. [Fluent 2 Button](https://fluent2.microsoft.design/components/web/react/core/button/usage) is the closest structural analog: one dominant action and a separate disclosure for related actions. Its official split-button screenshot was captured and inspected. We keep ZenX’s existing circular submit action rather than copying Fluent’s rectangular shape. The primary action appears only once in the panel, above related alternatives; selecting a global preference is separated from submitting a message. A menu-only button would conceal the dominant action and would make ordinary sending less direct.
2. [W3C Tooltip pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/) distinguishes informational tooltips from a hover surface with focusable content. This panel contains actions and a preference field, so an interactive nonmodal dialog is appropriate. A tooltip cannot hold these controls. The W3C tooltip pattern itself is labeled work in progress; it is not used as a claim of full accessibility certification.
3. [Radix Popover](https://www.radix-ui.com/primitives/docs/components/popover) provides the repo’s existing portal, focus/dismissal and collision behavior. [Radix Hover Card](https://www.radix-ui.com/primitives/docs/components/hover-card) describes a sighted-user preview that is ignored by screen readers, so it is unsuitable as the only route to commands or settings. A pure ARIA menu is also a poor fit for this mixed command/preference surface; buttons and a combobox keep normal Tab navigation.
4. [WCAG content on hover or focus](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html) motivates a hoverable, dismissible and persistent surface. The panel has a real bridge across its eight-pixel offset, a short leave delay, explicit opening for keyboard/touch, Escape and outside dismissal, and closes when its turn/context is no longer current.
5. [Adobe’s split-button deprecation notice](https://github.com/adobe/spectrum-css/discussions/2531) rules out borrowing its legacy splitbutton component as a current recommendation. Its button-group direction and Fluent’s distinct disclosure both support keeping clear related hit targets without adding several permanent send/stop buttons.

## Interaction and visual result

- One stable 44×44 primary hit target; all sending intents share hover/focus treatment. Stop retains its semantic stop styling
- One adjacent options control, 28×44 for pointer and 44×44 at narrow/coarse sizes
- A compact primary command with consequence text; related options use existing icons, short descriptions and only real shortcut hints
- Default preference uses the existing shared themed Select, only in the panel footer
- Hover/focus does not steal focus; deliberate disclosure and arrow keys focus an enabled command. Escape returns to disclosure without reopening
- Sending and Stop availability remain independent. Failed saves retain current preference, show the error, and never submit the draft
- Turn transitions close stale controls and preserve both draft and orb position

## Validation

Final focused composer/state/theme/i18n tests: 97/97. Settings-notification race: 1/1. Independent review passed 88 component/state tests and six adversarial focus probes. Prettier, Ruff format/lint and diff checks passed. Root and ZenX TypeScript checks, brand, first-party preparation and production build passed. The review found a focus-loss issue on panel removal; it is fixed and regression-tested, including the nested Select portal and preserving outside/editor focus.

The documented `npm run check --workspace @zen/zenx` stopped at its TSX CLI launcher because this shell cannot create `/tmp/tsx-1000/*.pipe` (EPERM). The equivalent Node TSX-loader full-suite run reported two first-party packaging failures, then stopped producing results and was interrupted. Its aggregate is inconclusive; this report makes no clean full-suite claim.

The native matrix completed 36 scenarios with assertions passing; the compact record is [matrix.json](matrix.json). It exercises idle/running, all four modes, empty/pending/disabled/error/compact states, light/dark, Chinese, hover gap, 360×640 touch-like layout, 620×420 constrained height, keyboard, preference save/failure and turn transitions. The driver uses native Electron key names; an early driver run emitted an empty key for `ArrowDown`, then was corrected to the documented `Down`/`Return` names. That early harness failure is not presented as a product pass. Continued hover can display refreshed current actions after a turn transition; native assertions verify the current send/steer callback and expected turn ID. Deliberately opened keyboard panels close and restore owned focus. No extra dismissal policy was added solely to satisfy an overly strong test assumption.

The captures establish layout and renderer interactions. They do not establish physical touch behavior, manual screen-reader usability, full WCAG conformance, or live provider reliability.

## Representative native screenshots

### Idle hover, before and after (1120×800)

![Idle before](before-idle-hover.png)
![Idle after](after-idle-hover.png)

### Running hover, before and after (1120×800)

![Running before](before-running-hover.png)
![Running after](after-running-hover.png)

### Shared preference selector

![Themed preference selector](after-preference-menu.png)

### Narrow and constrained height

![360×640 narrow layout](after-narrow-running.png)
![620×420 inner scroll area](after-short-running.png)

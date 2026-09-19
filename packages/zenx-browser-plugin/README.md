# ZenX Browser

First-party Browser package distributed with ZenX and installed through the ordinary plugin profile.

Prefer `observe: true` on `browser_open`, `browser_navigate`, `browser_click`,
`browser_type`, `browser_select` and `browser_scroll`. These calls return a fresh
inspection, including new target IDs and a screenshot, with the action result.
This avoids a separate model call to inspect after every action. Omitting the
option preserves the summary-only response. If a follow-up inspection fails,
the result explicitly includes `actionCompleted: true` and `observationError`;
inspect again rather than repeating the completed action. Action failures still
fail normally and are never retried automatically.

Version 1.0.3 adds native `browser_select`, current non-password control state,
bounded select options, and contenteditable typing. `browser_scroll` requires an explicit `sessionId`, `tabId`,
latest `observationId`, direction (`up`, `down`, `left`, `right`), and integer
`pixels` from 1 to 2000. It scrolls the page viewport and consumes the observation;
inspect again before the next interaction. Nested scroll containers are not yet
supported. Electron and attached CDP observations now identify form fields from
`aria-labelledby` and associated HTML labels, with the same name checked again
before an action. This is a bounded name heuristic, not a complete accessibility
name implementation.

Playwright's ARIA targets can include offscreen controls that its native actions
scroll into view. Electron and attached CDP targets are limited to the viewport.
Independent page scrolling is available in all three providers.

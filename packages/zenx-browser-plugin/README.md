# ZenX Browser

First-party Browser package distributed with ZenX and installed through the ordinary plugin profile.

Version 1.0.2 adds `browser_scroll`: provide an explicit `sessionId`, `tabId`,
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

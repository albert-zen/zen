# PAW and IMZenX: focused desktop verification

Actual Linux Electron with an isolated synthetic profile and local mock model. No external bot credentials were supplied and no platform messages were sent. This is a focused walkthrough of the renamed assistant and IMZenX setup surfaces, not an all-page product audit.

## Observed behavior

- PAW navigation, creation title/default Room name, active/pause controls, and workspace heading use the new product name. Existing saved `Companion` Room and `Assistant` member names remain unchanged. The navigation retains the shared conversation-bubble icon.
- Opening the preset form or workspace does not itself run a model or install a heartbeat. Overview still distinguishes the working Thread from explicit Room communication.
- A synthetic `paw direct` message produced `Echo: paw direct` in the bound Thread. Returning to the Room left its last message at `thanks`: direct Thread conversation was not mirrored into the Room.
- IMZenX explains `/paws` and `/paw` as Room communication, while `/threads` and `/pick` address working Threads. Directory scope and current text-only/platform-feature limits are visible.
- The original mode-guidance card lacked spacing. The corrected card now uses consistent padding and separation in light/dark themes and at 598px width.
- The original form lost the unsaved `/tmp/paw` directory on navigation. After the fix, IMZenX → PAW Room → IMZenX and a theme change retain that exact draft. The connection was not saved or started.

## Evidence

- [PAW preset](paw-preset.png) and [PAW workspace](paw-workspace.png): captured at `9a87178`, unchanged in the final GUI candidate.
- [IMZenX light, with retained draft](imzenx-light.png), [dark](imzenx-dark.png), and [598px narrow](imzenx-narrow.png): captured at `a94ae8a`, after spacing and draft-retention fixes.
- [Final IMZenX quickstart](imzenx-quickstart.png): captured at `1391ffe78b2e64c5ab67a4569a13c2ad7cae0b29`. It includes both PAW commands and qualifies new-Thread behavior by the absence of a selected route.

These screenshots reflect the current GUI. Subsequent Python-only transport corrections, if included, require their own functional tests and do not become GUI evidence.

Historical comparison only: [previous IMZenX](before-imzenx.png) and [previous preset](before-preset.png), from the receipt branch's `551a19a` build. Keep these as links rather than inline current PR images.

## Limits

Desktop GUI checks do not prove live bot-platform delivery. Host/Python bridge and route isolation are covered separately by the implementation's SDK mocks and tests. Real external channels, native Windows/macOS, mobile GUI, and provider-side admission timing were not exercised here.

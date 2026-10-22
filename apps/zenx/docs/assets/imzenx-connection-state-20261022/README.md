# IMZenX channel connection status capture

These screenshots render the production `ImZenXPage`, translations, shared controls and stylesheet at code commit `9f44db5e3b9874944d2b9134978b0e57da9f3e0c`. `capture-source.json` records exact source and image hashes.

The visible fixture banner is intentional: connection states and command responses are **synthetic**. No Host, user profile, credential, real QQ login or bot message is used. These are browser UI acceptance screenshots, not native Electron or live QQ delivery acceptance.

- `qq-ready.jpg`: explicit QQ connected badge, neutral passed preparation, secondary Reconnect action; no initial Confirm connection.
- `qq-reconnecting.jpg`: reconnecting replaces the connected badge.
- `qq-failed.jpg`: explicit connection failure; automatic status polling observed.
- `qq-ready-dark-375.jpg`: dark 375px viewport; no horizontal overflow.

Reconnect opens the existing single-consumer consent dialog; Escape closes it and restores focus. SDK READY provenance, privacy bounds, stale observations and child lifecycle are covered separately by Python, private-pipe and DOM regression tests.

To reproduce: run `node apps/zenx/scripts/build-imzenx-status-preview.mjs <output-directory>`, serve the output on localhost and open `imzenx.html?state=ready&lang=zh-CN` (add `theme=dark` for dark mode). The local fixture blocks network connections by CSP.

# Message links · bounded UI evidence

These are **real Electron 43.2.0 candidate renderer + isolated ZenX Host IPC** captures, not a signed/daily installation. Each run used a separate temporary `HOME`/userData/Core journal/workspace, the local `fake` echo model, and synthetic fixture files; the QA capture shim changed `BrowserWindow.show()` to `setOpacity(0); showInactive()` so it did not take the user's foreground. Only the title's workspace path row was masked at the raster level; the mask is not a product UI element. No personal messages, credentials, or private paths were copied into this directory. Source capture code commit: `942b2098b03015e732b0f8c7b4b7724c90dbf028`; adding these images/docs afterwards is evidence-only and does not change the tested renderer.

| Image | Source head | Verified scenario / limit |
|---|---|---|
| [Literal `%` file](head-942b209-percent-file-panel-dark-wide-sanitized.png) | `942b209` | `report%25done.md` opens **report%done.md**, showing its unique content; right panel was initially closed. |
| [Literal `%20` file](head-942b209-file-Literal20-panel-dark-wide-sanitized.png) | `942b209` | `report%2520done.md` opens **report%20done.md**, distinct from the space-named file; panel already open. |
| [file URL](head-942b209-file-FileURL-panel-dark-wide-sanitized.png) | `942b209` | `file:///…/report%25done.md` selects the original percent file (actual absolute temp URL remains only in local uncommitted QA fixture). |
| [Space-named file](head-942b209-file-Space-panel-dark-wide-sanitized.png) | `942b209` | `report%20done.md` opens **report done.md**, not the `%20` file. |
| [Chinese + space](head-942b209-file-中文-panel-dark-wide-sanitized.png) | `942b209` | Encoded Unicode and space open the correct file. |
| [Browser tab and refused navigation](head-942b209-browser-panel-local-refusal-dark-wide-sanitized.png) | `942b209` | Existing file tabs persist; HTTP target opens a side Browser tab. `127.0.0.1:9` produces **ERR_UNSAFE_PORT**: route/safety-failure evidence, **not** successful webpage loading. No external website used. |
| [Historical QA file tab](head-44e9f70-original-file-panel-dark-wide-sanitized.png) | `44e9f70` (R1 head) | Independent QA's sanitized original `sample.txt` right-panel screenshot. **Historical evidence only; not a new-head percent-regression capture.** |

The new-head run also recorded actual rendered anchors for all six labels and the distinct file content in its local capture log; targeted production Markdown component + Host reader tests assert each corresponding exact file. This test does not cover native permissions in the daily signed app; translucent hidden-window mode can affect Screen Recording checks. Browser success navigation still requires a separate safe local server fixture if requested. Absolute paths outside cwd remain denied by the Host file reader.

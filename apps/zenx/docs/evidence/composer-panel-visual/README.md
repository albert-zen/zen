# Right panel and Composer: real development-Electron captures

These PNGs are from **Electron 43.2.0, real renderer + isolated Host with local fake model and synthetic QA text**, not an installed/signed daily-use ZenX. They are actual `webContents.capturePage()` pixels, not mockups. The window was transparent and `showInactive()` to avoid foreground takeover. Mac overlay scrollbars auto-hide: the screenshots **cannot** show every thumb pixel or prove cross-platform scrollbar painting. No personal content or credentials were supplied. For the R1 screenshots containing a Thread title, the synthetic absolute workspace path was replaced by a marked raster `[QA workspace path hidden]`; the obscured pixels are not product layout. R2 screenshots show a new Thread composer without path pixels. QA source/conditions: project artifact `inbox-dispatch-20260924/qa/{REPORT,SCREENSHOTS}.md`; R2 measurements recorded in this branch's report (capture generated from the same source/build as final head).

## BEFORE R2: actual R1 head `b6b0bfc63fb4621cdc4b4a2874905687250e2de0`

These are **not** `b494dfc` screenshots, nor screenshots of R2. R1 is the prior version whose scrollbar/indicator issues R1 review identified.

| Scenario                                         | Capture                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1280×820 Dark overflow, 16 synthetic lines       | [R1 wide overflow](screenshots/qa207-composer-overflow-dark-wide.png)                                                                       |
| 800×760 Dark overflow                            | [R1 medium overflow](screenshots/qa207-composer-overflow-dark-narrow.png)                                                                   |
| 1280×820 Dark closed toggle hover, `:hover=true` | [R1 closed hover](screenshots/qa207-side-toggle-hover-dark-wide-sanitized.png)                                                              |
| 1280×820 Dark panel opened via real click        | [R1 open](screenshots/qa207-side-open-dark-wide-sanitized.png)                                                                              |
| 1280×820 Light open panel close-button hover     | [R1 open hover](screenshots/qa207-side-close-hover-light-wide-sanitized.png)                                                                |
| Light Thread, 1280×820 and 800×760               | [R1 Light wide](screenshots/qa207-thread-light-wide-sanitized.png) · [R1 Light medium](screenshots/qa207-thread-light-narrow-sanitized.png) |

## AFTER R2: final head for this branch (see commit / PR)

Capture from actual build with the R2 CSS + textarea resizing changes. Electron size floor is 600×560, so attempted 600×320 was clamped to 600×560. 800px wide is **not** the `max-width:640px` CSS layout; 600px is.

| Scenario                                        | Capture                                                        |
| ----------------------------------------------- | -------------------------------------------------------------- |
| 1280×820 Dark empty composer                    | [R2 empty](screenshots/r2-empty-dark-wide.png)                 |
| 1280×820 Dark short draft, textarea focused     | [R2 short / focus](screenshots/r2-short-focused-dark-wide.png) |
| 1280×820 Dark overflow, 16 synthetic lines      | [R2 wide overflow](screenshots/r2-overflow-dark-wide.png)      |
| 600×560 Dark overflow, actual mobile breakpoint | [R2 mobile overflow](screenshots/r2-overflow-dark-mobile.png)  |
| 600×560 Dark short draft                        | [R2 mobile short](screenshots/r2-short-dark-mobile.png)        |

### Scrollport geometry / design criterion

A native textarea's scrollbar track spans its **scroll element**, not text padding. To avoid both rounded corners, require `scrollport.top - shell.top ≥ shell.borderTopLeftRadius` and `shell.bottom - scrollport.bottom ≥ shell.borderBottomRightRadius` for empty, short and overflowing drafts. R1 had `~9px` top clearance against a 22px radius (source/geometry inference, no visible thumb). R2 reserves a 22px top margin + 1px shell border, reduces textarea minimum/maximum height by 14px so the outer composer height stays unchanged, and keeps the bottom rail. Actual R2 Electron DOM geometry:

| View                 | Radius | Track top clearance | Track bottom clearance | Overflow / height                 | Shell height |
| -------------------- | -----: | ------------------: | ---------------------: | --------------------------------- | -----------: |
| 1280×820 empty/short |   22px |                23px |                   57px | hidden / 54px                     |        134px |
| 1280×820 16 lines    |   22px |                23px |                   57px | auto / 136px (`scrollHeight=342`) |        216px |
| 800×760 16 lines     |   22px |                23px |                   57px | auto / 136px                      |        216px |
| 600×560 16 lines     |   20px |                23px |                   57px | auto / 136px (`scrollHeight=390`) |        216px |
| 600×560 short        |   20px |                23px |                   57px | hidden / 54px                     |        134px |

After a synthetic fake Turn, actual `.context-usage-trigger` button measured 36×36px and `tabIndex=0`. Real keyboard Tab moved focus from textarea to the **actual** `Add images` button, measured 36×36px. In this transparent `showInactive()` window the button did **not** match `:focus-visible` although it was `document.activeElement`; do not claim the screenshot verifies the ring. CSS applies focus to the real `.context-usage-trigger` button (36×36px), not the unfocusable wrapper; that control only renders when a thread has context usage and was not present in the new-thread screenshots. Installed-app permissions, forced-colors, Windows scrollbar and active-window focus-paint remain outside this environment.

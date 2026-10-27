# Browser and Computer activity presentation

The production components were recompiled from source commit
`0091f1f24ae63124253a6a24ae154665521726de` using
`apps/zenx/test/fixtures/browser-computer-experience-visual.tsx`. All seven
scenarios were recaptured at that revision and compared pixel by pixel with
the committed PNGs; every image was identical, so the existing files were
retained. This includes the Browser and Computer muted-text token correction
in `styles.css`. The fixture mounts the
production `WorkspaceBrowserPanel`, `ComputerThreadPanel`, `PluginAccessReview`
and `foregroundActivityHtml` renderer with synthetic Host facts. PNGs are
1000 × 850 Chrome headless captures from an isolated synthetic browser profile.
No user profile, real window, native Browser view, Computer backend or foreground
input was connected. The fixture's surrounding headings, sample editor and
blank page area are context, not product UI.

| File                      | Synthetic facts shown                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `browser-working.png`     | Exact shared tab, one dispatched Agent action, Agent permission enabled.                                                         |
| `browser-human.png`       | Same tab with human control, no action in flight.                                                                                |
| `computer-background.png` | Exact “Example editor” window with one active `background-window` call and a live-observation status; no real frame.             |
| `foreground-active.png`   | Actual global-indicator HTML for one admitted click, Stop available and Escape registered in the synthetic view.                 |
| `foreground-stopping.png` | Same HTML with cancellation intent still displayed, Stop disabled while native settlement would be pending.                      |
| `environment-locked.png`  | Read-only Win32 readiness snapshot with `sessionState: locked`, `displayState: unknown`, and inactive app-suspension prevention. |
| `environment-unknown.png` | Same snapshot with `sessionState: unknown`; the UI does not report an active session.                                            |

These images verify rendered text, grouping, edge treatment and readable state
differences. They do not verify Host event delivery, paint-before-input admission,
physical Stop/Esc, native focus, multi-display behavior, lock detection, sleep,
or macOS helper/overlay behavior. Those require native acceptance evidence.

The capture build and isolated Chrome profiles are local temporary artifacts;
they are not part of this public evidence package.

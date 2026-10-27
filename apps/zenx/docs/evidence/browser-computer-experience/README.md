# Browser and Computer activity presentation

The production code is based on integration commit
`15db1ed65da79831ac719275d9279ec303670bdc` and rendered by the fixture
`test/fixtures/browser-computer-experience-visual.tsx` at this README's Git
revision. The five Browser/Computer/foreground images were captured at
`68aab53edc7c71a997486825e73308bca713ab98`; the locked/unknown images
were recaptured with the corrected idle-system-sleep text from this revision.
No production component structure changed between those captures. The fixture mounts the
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

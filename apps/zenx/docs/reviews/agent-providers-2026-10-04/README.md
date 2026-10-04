# Agent Providers: desktop walkthrough

Final source and narrow-navigation retest: `05bfb7014162825c142bc67b20fa34cc306f0cfa`. The preceding fixed GUI pass used `cda6e431d788d9d20620218a85705994f6c6814c`. Actual cloud Linux Electron, 1188×848 and 598×848, light/dark desktop themes and dark narrow layout. The preceding pass used `cf3048e8c80632048da5a3e1681e7f72def8db15`; its screenshots are diagnostic/history rather than current presentation.

## Result

Core offline provider flows pass. Global New thread and the welcome Composer overlap were found through real interaction and fixed in the current candidate. The narrow welcome-shell navigation issue was also fixed: the final 598px retest opens the sidebar from both the Zen welcome and Codex draft using the existing titlebar row. Closing the overlay preserves the unsent external draft and selected model/permission. No unresolved GUI blocker remained in these tested flows. The final menu and semantic-error-race fixes were owner-verified after the third independent review; this is not a claim of another independent review pass.

## Actual interaction coverage

- Settings → Agent Providers → nested Zen Models & providers works. Codex and OpenCode instances were created through their forms, using executable symlinks to the repository's offline fixtures. Explicit Load models returned one Codex model and two OpenCode models.
- Project-row New thread worked in the first pass. In the final pass, global New thread also opens from Settings. The central project chooser opens and Escape dismisses it without creating a session. The small project name at the right of the sidebar's New thread row is informational; it is not the project-picker control.
- The welcome Composer scopes models to the selected engine. OpenCode exposes Model One/Two, while Codex exposes its separate Test model. A new final-candidate session selected Model Two and retained it.
- Codex streamed text, completed a turn, and interrupted a later turn using Stop. Its draft survived navigation to Settings and back.
- OpenCode required an explicit supported full-filesystem choice before Send. The UI explains its lack of filesystem sandbox. Its synthetic native permission request was surfaced; one-shot Approve completed the first pass. In the final pass, Decline produced the fixture's permission-declined result with a normal seven-second duration. No command actually executed.
- New OpenCode work created a distinct native session entry. Selecting Codex and OpenCode entries displayed their separate histories and engine identities; the existing external session view does not offer an engine switch that could redirect it to Zen.
- After app restart, both native session locators and histories restored, including Codex's interrupted turn. The synthetic Zen Thread and PAW created during the first pass also remained listed after the final build restart.
- Changing an executable on an instance that already owns sessions was rejected, preserving the original instance identity. A separate new instance using `/missing` returned an executable ENOENT error with recovery guidance. Correcting the path and loading models recovered successfully. Errors retain a raw IPC prefix, but the actionable cause is visible.
- A normal Zen mock Thread sent and received an Echo response. PAW creation offered the Zen Thread and excluded the external sessions. Sending a PAW Room message reached Delivered/Read. This is synthetic regression coverage, not migration validation of an existing user's profile.
- Final light/dark welcome controls and 598px Zen/OpenCode controls fit without overlap; provider menus remain inside the viewport. Native window actions remain separate from the content row.

## Evidence

- [New Thread, light](new-thread-light.png) and [dark](new-thread-dark.png): corrected global entry and nonoverlapping footer, captured at `cda6e4`.
- [OpenCode native approval](opencode-approval.png) and [declined outcome](opencode-declined.png): scoped Model Two and real fixture interaction, captured at `cda6e4`.
- [Narrow welcome](narrow-welcome.png), [opened sidebar](narrow-sidebar.png), and [retained Codex draft](narrow-codex-draft.png): final `05bfb7` retest at 598px.

Historical comparison only: [before-fix footer overlap](before-footer-overlap.png), captured at `cf3048e`. Keep this as a historical link, not a current inline PR image.

The first OpenCode fixture used a hardcoded start time with a current completion time, producing an absurd duration. The fixture was corrected; existing old fixture history was not rewritten. Current OpenCode captures use a newly created session and normal timestamps.

## Limits

All model/native peers were offline fixtures, with an isolated profile and no external account credentials. No real Codex/OpenCode authentication, model spend, tool execution, native Windows/macOS, or mobile UI was tested. Host race/error cases such as model-catalog failure during Stop and unsupported interaction persistence were not fault-injected through this GUI pass; their automated coverage belongs in the implementation's test report. PAW compatibility remains Zen-only in this feature: external native sessions are not PAW binding candidates. No claim is made that every product page was audited or that native provider permission configurations were proven by screenshots alone.

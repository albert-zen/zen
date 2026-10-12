# PR #206 · bounded screenshot evidence

These three **sanitized** screenshots were produced by engineering QA from **old head `75a0c36b0ee51449badde734d5e40e0e511611d6`**, Electron 43.2.0 isolated dev Host/fake model, dark wide 1280×820 (Retina 2×); they are **not** screenshots of the subsequent R1 wait-group fix. The QA synthetic workspace path/title was deliberately masked; not a signed installed build or a remote provider. Source and checksums: `agent-data/projects/zen/artifacts/inbox-dispatch-20260924/qa/SCREENSHOTS.md`.

- [Shell pending](qa206-75a0c36-shell-pending-dark-wide.png): `!shell sleep 3`, started call.
- [Shell terminal](qa206-75a0c36-shell-terminal-dark-wide.png): same call completed.
- [Yielded shell task receipt](qa206-75a0c36-shell-yielded-dark-wide.png): `!shell sleep 17` yielded a task running receipt after 10s; original tool call is not still running.

R1 changed the wait receipt's grouped/expanded wording. A new-head wait screenshot must be captured and identified separately; these old-head images do not demonstrate that change. No personal messages, paths or credentials are included in the visible pixels outside the intentionally covered synthetic QA title.

## R1 fix: new-head component screenshot evidence

The following are **real Electron 43.2.0 Chromium captures of the actual `ThreadView`, `turn-projection`, `tool-presentation`, `theme.css`, and `styles.css` built from production source at `ebce0a9110082c1c52f4ffc75625bdb4a7c9cdae`**, with an explicitly **synthetic protocol `Thread` prop**: public reasoning followed by a completed `wait` call carrying `application/vnd.zen.tool-task+json` and `{status:"running",task_id:"qa-task"}`. This is a **component harness**, **not the complete ZenX app or a live Host/journal/provider session**. The actual native live/journal parity is separately exercised in `thread-view-state.test.ts`; these images prove the renderer pixels and fold/expand interaction only. QA entry was bundled with esbuild from the fixed source in an isolated temporary directory; Electron window used `showInactive`, reported `isFocused=false`, and its isolated `/tmp/zen-status206-*` userData directory was deleted after capture. No daily-use ZenX or personal content/credentials were accessed. Captures checked DOM heading/row and `aria-expanded`, then inspected PNG pixels; an earlier hidden-window capture that produced blank images was discarded, not submitted.

- [Dark wide, group folded](qa206-ebce0a9-wait-collapsed-dark-wide.png): 1000×720 CSS pixels, `Reasoning · Waiting wait`, `aria-expanded=false`; SHA-256 `4c329fa45c9691f6ccc385e71ab86879cd4293b5eaef244d99431e32c734b534`.
- [Dark wide, group expanded](qa206-ebce0a9-wait-expanded-dark-wide.png): same fixture after click, row label `Waiting`, `aria-expanded=true`; SHA-256 `48a5286abd7d8e15d7fa853022080271b5b49e8561d449657a360d9029b2f589`.
- [Light narrow, group expanded](qa206-ebce0a9-wait-expanded-light-narrow.png): 780×680 CSS pixels after appearance switch; row still `Waiting`; SHA-256 `6ee5d0ffb7bac12a021cf268093a64f6534af84743106656494c595e5386f887`.

These are not signed-app screenshots or proof of a real queued background task; all task identifiers and content are synthetic. Production HTML outside `ThreadView` (sidebar, Host bridge) was not used in this harness. The three older `75a0c36` screenshots above instead show a full isolated ZenX app/fake Host shell flow, but do not assert the R1 fix.

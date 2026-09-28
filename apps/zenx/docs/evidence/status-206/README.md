# PR #206 · bounded screenshot evidence

These three **sanitized** screenshots were produced by engineering QA from **old head `75a0c36b0ee51449badde734d5e40e0e511611d6`**, Electron 43.2.0 isolated dev Host/fake model, dark wide 1280×820 (Retina 2×); they are **not** screenshots of the subsequent R1 wait-group fix. The QA synthetic workspace path/title was deliberately masked; not a signed installed build or a remote provider. Source and checksums: `agent-data/projects/zen/artifacts/inbox-dispatch-20260924/qa/SCREENSHOTS.md`.

- [Shell pending](qa206-75a0c36-shell-pending-dark-wide.png): `!shell sleep 3`, started call.
- [Shell terminal](qa206-75a0c36-shell-terminal-dark-wide.png): same call completed.
- [Yielded shell task receipt](qa206-75a0c36-shell-yielded-dark-wide.png): `!shell sleep 17` yielded a task running receipt after 10s; original tool call is not still running.

R1 changed the wait receipt's grouped/expanded wording. A new-head wait screenshot must be captured and identified separately; these old-head images do not demonstrate that change. No personal messages, paths or credentials are included in the visible pixels outside the intentionally covered synthetic QA title.

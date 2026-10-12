# Trigger UI visual evidence

Captured on this branch with the **actual React `TriggersPage`/`TriggersPanel` components** in an isolated hidden Electron window (macOS, light/dark theme from `theme.css`), at 1080×760 / 520×780 / 480×730 points; no daily ZenX or Host was opened. The fixture SDK returns synthetic, non-sensitive definitions and one synthetic failed history row. This is **component layout evidence only**, not a claim of live plugin installation or scheduler delivery. See `apps/zenx/test/trigger-public-entry.test.ts` for separate isolated Host/public-tool delivery evidence.

- `global.png`: global automation list + failed run.
- `edit.png`: editing recurring timer with a preserved target.
- `rail.png`: current-Thread scoped right panel.
- `small.png`: minimum/narrow global viewport.

Generated using Electron `BrowserWindow.capturePage()` against the component bundle with an in-memory SDK; do not present synthetic failure message as an actual Host fault.

# macOS file editor diagnostic

This synthetic diagnostic runs in the existing macOS provider CI job, using the
actual file-sidebar components, CJK fixtures, and a fresh temporary Electron profile.
It accompanies the confirmed packaged-CSP scrolling fix; document-end navigation
is a separate known failure and is not claimed fixed by that change.

Build with `node apps/zenx/scripts/build-file-sidebar-preview.mjs "$OUTPUT"`.
From `apps/zenx` on the disposable macOS CI runner:

- Required scrolling/security contract: `npx --no-install electron scripts/capture-file-sidebar-electron.cjs "$OUTPUT" --scope=scroll-security`.
- Separate, still-failing document-end investigation: same command with `--scope=end-navigation`.
- Omit scope or use `--scope=all` to retain every assertion. Unknown/extra scope arguments fail closed.

Each run writes `electron-<scope>-measurements.json` with its exact scope and
whether navigation assertions were included. CI explicitly names its scroll-security
step/artifact; a green scrolling result never means document-end navigation passed.
No failing navigation assertion is removed or rewritten as passed. The navigation
entry retains cold/no-wheel, after-wheel, EOF geometry and Find-mode controls.

The actual macOS Electron runtime creates and focuses its own BrowserWindow with
production-equivalent hidden-titlebar, opaque-backdrop and sandbox settings.
The fixture deliberately excludes the production Host and preload. Its real
sidebar uses memory-only scoped APIs. Native Electron `sendInputEvent` exercises
256px/384px tree-open editors with discrete and precise wheel events before and
after content focus. The all/end-navigation entry additionally checks the macOS
Meta+ArrowDown document-end binding. No
scrollTop assignment, DOM click, CSS override or CDP fallback can fake a pass.
Titlebar readiness and hit-test checks precede pointer input.

The scope-specific measurements JSON records versions, source and driver hashes, focus,
computed outlines/borders, hit stacks, delivered wheel events and scroll metrics.
Before/focused/scrolled/end PNGs are captured only from the owned renderer with
`capturePage`, not the desktop. Failure keeps measurements and a failure PNG.
The temporary profile is not deleted while Chromium is alive; the disposable
runner cleans it up after process teardown. A 90-second driver watchdog and
3-minute CI step bound the process. No user computer, private screenshot/file,
AX input, permission prompt, system setting change or paid API is used.

This is Electron input acceptance, not physical trackpad/keyboard acceptance.
Actual installed
build/version, input device/mode, zoom and OS settings may still differ. Do not claim every input mode or the separate document-end issue is accepted.

The CI screen is 1024×768. The owned diagnostic window explicitly enables
Electron's macOS `enableLargerThanScreen` option so its asserted 1400px desktop
viewport is not clamped into the product's <=1099px full-width layout (whose
outer splitter is intentionally hidden). This changes only this temporary
window, never the system display resolution. Input and capture remain Electron
owned-surface operations, not physical input to offscreen desktop coordinates.

## Production policy reproduction and regression

The permissive preview's `style-src 'unsafe-inline'` concealed a real packaged
policy difference. In macOS run 40298352578, the exact production `style-src
'self'` twin blocked CodeMirror's runtime style element. The scroller grew to
34761px (clientHeight equaled scrollHeight) and native wheel deltaY=720 left
scrollTop at zero, while the same permissive component scrolled 0→720→1440.
This is evidence for the production policy/style failure, not a trackpad issue.

The regression now loads the strict twin through the same compiled main-process
file handler used by the packaged renderer. Only the exact known entry response
gets a fresh random style nonce; all three CodeMirror editors use it. Tests also
exercise source scrolling and composer character input, navigation nonce renewal,
and rejection of style elements with no nonce or a wrong nonce. Expected negative
probe violations are recorded separately; nonce values are never recorded.
Other CSP directives, including script-src, are unchanged. The original permissive
fixture remains available as a comparison, but is not production-CSP acceptance.

## Separate known document-end failure

Before nonce production changes, head `1628c637` / run `40297891089` (test-merge
source `6c0fd4b3`, artifact `12639590336`) already failed all four Markdown
Meta+ArrowDown cases after successful wheels. After nonce, run `40303859922`
(artifact `12641424552`) reproduces the same failure with selection at document
length but a viewport near the start. This proves that Markdown failure is not
introduced by the nonce fix. Source-editor navigation was first measured later;
its pre-fix baseline has not been established. This investigation remains open,
owned by the file-editor diagnostic task, independently of scrolling/security acceptance.

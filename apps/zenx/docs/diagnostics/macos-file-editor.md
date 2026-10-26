# macOS file editor diagnostic

This test-only diagnostic runs in the existing macOS provider CI job. It loads the
same real file-sidebar component fixture as the Linux browser checks, using only
synthetic CJK files and a fresh temporary Electron profile. No production change
is proposed and passing this diagnostic does not claim the reported scrolling or
yellow-outline problem is fixed.

Build with `node apps/zenx/scripts/build-file-sidebar-preview.mjs "$OUTPUT"`.
On the disposable macOS CI runner, from `apps/zenx`, run
`npx --no-install electron scripts/capture-file-sidebar-electron.cjs "$OUTPUT"`.

The actual macOS Electron runtime creates and focuses its own BrowserWindow with
production-equivalent hidden-titlebar, opaque-backdrop and sandbox settings.
The fixture deliberately excludes the production Host and preload. Its real
sidebar uses memory-only scoped APIs. Native Electron `sendInputEvent` exercises
256px/384px tree-open editors with discrete and precise wheel events before and
after content focus, then the macOS Meta+ArrowDown document-end binding. No
scrollTop assignment, DOM click, CSS override or CDP fallback can fake a pass.
Titlebar readiness and hit-test checks precede pointer input.

`electron-measurements.json` records versions, source and driver hashes, focus,
computed outlines/borders, hit stacks, delivered wheel events and scroll metrics.
Before/focused/scrolled/end PNGs are captured only from the owned renderer with
`capturePage`, not the desktop. Failure keeps measurements and a failure PNG.
The temporary profile is not deleted while Chromium is alive; the disposable
runner cleans it up after process teardown. A 90-second driver watchdog and
3-minute CI step bound the process. No user computer, private screenshot/file,
AX input, permission prompt, system setting change or paid API is used.

This is Electron input acceptance, not physical trackpad/keyboard acceptance.
A synthetic macOS pass remains a negative reproduction result; actual installed
build/version, input device/mode, zoom and OS settings may still differ. Do not
close the user's bug solely on that basis.

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

# Pending tray and send-panel component QA

This source-only package builds actual production `ThreadView`,
`ComposerSendControl`, pending components and their unchanged imported styles.
Synthetic canonical facts contain two steer and three queued inputs. Fixture-only
header controls, fixed clock, initial focus and local callback simulation are not
production behavior. No real Host, model, network or durable operation is used.
The package never captures screenshots or launches an app while building.

## Prepare a new output

Use the repository's already installed development dependencies. No package,
browser or Electron download is performed. Output must not already exist, so a
rebuild cannot overwrite earlier captures or profiles.

```sh
REPO="$(pwd -P)"
TOOLS="$REPO/docs/ui-quality/scripts/pending-readability"
QA_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/zenx-pending-readability.XXXXXX")"
OUTPUT="$QA_PARENT/build"
node "$TOOLS/rebuild.mjs" "$REPO" "$OUTPUT"
node "$TOOLS/launch.cjs" --check "$REPO" "$OUTPUT"
```

The builder reuses the Vite self-contained fixture pattern from
`apps/zenx/scripts/build-fork-feedback-preview.mjs`. It imports the selected
repository through an alias instead of modifying or copying production files.
All three generated HTML files are self-contained; the narrow wrappers embed
the identical component bundle in `srcdoc`. `manifest.json` hashes the production
sources, fixture sources and built HTML, and records six JSDOM EN/ZH functional
cases. Those cases verify the five inputs, menu choices, footer focus and Escape
return, not native geometry or scrollbar pixels.

The read-only `--check` verifies the successful build manifest, repository
identity and generated artifact hashes. It does not start Electron, verify the
current checkout equals the original bundle, or claim visual acceptance. Rebuild
to a new output when reviewing newer production source.

## Native launch

```sh
# Use an already installed native executable, not a download shim.
ELECTRON=/absolute/path/to/installed/electron
bash "$TOOLS/launch.sh" "$REPO" "$OUTPUT" "$ELECTRON" desktop pending en light
```

The launcher takes viewport, scenario, language and theme after the three paths.
It creates only an isolated profile under this output and blocks HTTP/WebSocket
requests from the default session. This is not an OS firewall. Node and Electron
must already be available in the caller's environment. It does not change any
production app preference or use a user's profile.

Viewport modes:

- `desktop`: `component.html` fills the actual native content viewport.
- `narrow`: `narrow.html` embeds the same bundle in a real **390×680 CSS-pixel
  iframe**. This is component viewport testing, not full-app mobile support.
- `zoom200`: `component.html` with native Electron zoom factor 2. Actual CSS
  dimensions are measured, not inferred from requested window bounds.
- `narrow-zoom200`: `narrow-zoom200.html` uses a 390×300 CSS-pixel iframe at
  native zoom factor 2. This is an optional short-height stress case; it was
  **not run** in the November 9 native checkpoint.

No CSS zoom, transforms or screenshot manipulation implement native zoom.
Requested outer size is 1188×848, but the window manager can override it.
`*-native-measurements.json` records actual bounds, CSS viewport, zoom factor,
tray dimensions, menu/body bounds, scroll offsets and focused control.

Scenarios:

- `pending`: interrupted turn and empty Composer. No initial focus, scroll or
  menu driver. Capture the resting thumb before interacting.
- `send`: running turn, a non-empty draft, default Next turn. The fixture
  focuses the production orb and dispatches its existing Arrow Up path.
- `footer`: running scene, then programmatic focus on the real footer Select.
- `manual`: running scene with no initial menu/focus driver.

`send` and `footer` are deterministic setup, not proof of trusted native
keyboard input. Use native input after setup, or start with `manual`, and record
the actual sequence. Direct HTML accepts
`?scenario=send&lang=zh-CN&theme=dark`; direct opening does not set native zoom.

## Native inspection

1. Capture `desktop pending` untouched, then wheel to the third queued row.
   Verify the native thumb and all three rows' controls in one tray scroll.
2. Open the running panel with native keyboard input. Check all five choices,
   full explanations and only the actual Enter/modifier-Enter shortcuts.
3. Tab to the footer Select, change its value, and verify the fixture reports
   a preference change without a send callback. Escape returns focus to the orb.
4. Repeat at 390px with Chinese/dark appearance. Check actual iframe metrics
   and menu containment rather than treating this as a narrow app-window test.
5. Use native 200% zoom, focus the footer, then Shift+Tab back to the first
   alternative. Verify focus brings each control into the bounded menu body.

The fixture's header buttons are conveniences, not product controls. Send,
stop and continue only report callbacks. Queue edit/cancel/reorder/promotion and
recall append synthetic in-memory facts. Reload restores the five inputs.
`window.__pendingReadability` exposes readiness and measurements; inside narrow
wrappers it belongs to the iframe's `contentWindow`.

Keep generated HTML, logs, node_modules, profiles and raw captures outside the
repository. Only this source package and reviewed evidence metadata belong in
the checkpoint. See `../../checkpoints/fourth-presentation-validation.md` for the
recorded run and its limits; a fresh rebuild is not that historical bundle.

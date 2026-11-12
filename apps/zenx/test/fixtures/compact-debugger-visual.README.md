# Compact debugger visual fixture

This renders the production App, component tree and every stylesheet imported by
`main.tsx`. The Host bridge, conversation, captures, attachment descriptors,
provider/model names and workspace files are synthetic. It makes no provider or
Host requests; capture controls only mutate this page's ephemeral fixture state.
This is browser renderer evidence, not a native Electron/Host capture test.

Serve this fixture with the existing Vite tooling and open
`compact-debugger-visual.html`. Open the Thread actions menu, enable Debug mode,
then select Actual requests and a request. The first request is complete, the
second is redacted with attachment metadata, and the third has all three integrity
flags: model-input projection, truncation and redaction. The bridge log is available
as `window.compactDebugFixture.commands`; `body` is the exact synthetic raw string.

Query options: `capture=off`, `lang=zh-CN`, `long=1`, `theme=dark`, and
`platform=darwin`. Capture defaults on only in this fixture to make repeatable
screenshots; production remains opt-in. Enabling fixture capture seeds synthetic
rows instead of contacting a provider.

Inspect 390×600, 390×844, 768×600 and 1280×800 viewports, 200% browser zoom,
and a wide window with the production Workspace open so the actual debugger
container is at most 720px. Keep the same payload and viewport for a baseline
comparison. Measure `.model-debug-panel`, `.model-debug-detail-scroll`, and the
visible intersection of `.model-debug-tree` / `.model-debug-payload` with the
detail scrolling rectangle. Only the request list and the detail region should
own vertical scrolling; exact Raw code may own horizontal overflow.

Exercise request selection, Back, search and list scroll preservation, keyboard
focus, Tree/Raw, all sections, capture privacy disclosure, all integrity details,
clear/disable, exit and reopening. Mode/tab/navigation operations must not add a
`setEnabled` command. Capture continues when debug is closed; disabling clears
its synthetic rows, as the real Host contract requires.

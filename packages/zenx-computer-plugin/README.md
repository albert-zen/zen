# ZenX Computer

First-party Computer package distributed with ZenX and installed through the ordinary plugin profile.

On Windows (WinApp CLI) and the bundled macOS provider, start with
`computer_list_windows({})`. It returns up to 32 open windows with their running
application name and an exact `target` that can be passed directly to
`computer_inspect`, `computer_screenshot`, and subsequent semantic actions. It
does not activate windows or enumerate installed applications. Use `query` to
match an application name, PID, or window title when `truncated` is true. Query
matching is case insensitive and happens before the result limit.

Titles are preserved exactly, including empty titles and titles longer than 256
characters; targeted operations accept titles up to 4096 characters. Re-list after a window closes or is renamed. Identical titles within
one Windows process remain ambiguous and explicitly fail; do not guess a target.
Discovery supplies targets, not control selectors: inspect the selected window
before acting.

The bundled macOS discovery uses its existing Accessibility helper and requires
Accessibility permission and the Swift compiler. The Peekaboo variant currently
does not advertise window discovery; its existing targeted tools are unchanged.
Windows discovery is verified through WinApp CLI 0.3.1; macOS requires an actual
Mac for live verification.

## Observation pages and diffs

Bundled macOS 1.0.2, Peekaboo 1.0.1 and WinApp 1.1.2 add optional `cursor`,
`baseObservationId` and `full` to `computer_inspect`. Update the installed
Computer package in Plugin settings to expose the new schema.

The first reply still contains at most 32 controls. `nextCursor` reads another
page of the same immutable capture using the same exact target, observation
ID and capture time. It does not recapture or renew action authority. Paging
reaches the candidates previously hidden by the public 32-control selection;
it cannot recover anything omitted by native traversal:

- macOS: at most 1,024 visited nodes, depth 24, then 120 retained candidates
- WinApp: depth 8, enabled/on-screen selectable UIA content, up to 512 candidates
- Peekaboo: up to 128 candidates; native completeness can remain unknown

Inspect `coverage.scope`, `sourceComplete`, `reasons` and `items.hasMore`.
Native incompleteness remains explicit after the final page. `full` means a
self-contained bounded view; it does not mean a complete accessibility tree.
Screenshots and foreground scrolling are separate operations, not complete
text/tree retrieval substitutes. Control search/subtree queries are not added.

Pass `baseObservationId` only while retaining that first-page baseline and its
applied diffs. A smaller matching diff contains `controlChanges` with `added`,
`updated`, `removedFromView` and optional complete `order`. Apply those changes,
then replace every retained `control.selector.observationId` with
`observation.actionObservationId`. All actions must use that current frame.
Discard old continuation pages on each fresh observation/diff and follow its
new cursor for tails. Omit the base or use `full: true` after context compaction
or lost context. Missing/expired bases and scope changes produce a full reset.

Stable Computer references mean unique exact-fingerprint presentation-entry
continuity, never proof of the same native object across captures. Fresh raw
selectors remain private and are revalidated at action time; ambiguous entries
receive fresh references. Observations/cursors/actions are bound to the trusted
thread and exact target. Native actions consume the whole observation,
foreground input invalidates cached captures, and stale/foreign cursors fail.

Host capture limits are five minutes, 64 scopes, 2 MiB per capture and 16 MiB
per presentation store. Pages are byte-aware (normally 32 KiB, hard ceiling
128 KiB); host-budget omissions remain visible in coverage.

Discovery originally shipped in the Windows 1.1.1 and bundled macOS 1.0.1 packages. Existing
profiles keep their installed manifest until the user updates Computer in the
plugin manager (or uninstalls and reinstalls it). A bundled update selects the
current App Resources package for the selected provider, even when the previous
version's tarball is no longer present; the ordinary profile transaction owns
the replacement and preserves plugin data.

## Windows background capture boundary (1.1.3)

Windows UIA discovery, inspection and semantic actions still use the pinned
WinApp CLI. Screenshots use a fixed app-bundled PrintWindow helper launched via
the system Windows PowerShell. WinApp 0.3.1's screenshot command can restore or
activate windows on fallback, so it is not used by the background capture tool.

The helper contains no window activation, restore or global input calls. It
accepts an exact HWND/PID/title, rechecks identity and physical-pixel geometry,
and returns a bounded PNG to the Host; only the Host writes the expiring artifact.
Minimized, hidden, cloaked, protected, blank or unrendered client regions fail
without takeover. A genuinely black client can be rejected as unverified.
Potential sentinel-colored pixels are checked against a differently initialized
second capture under the same timeout. Only those ambiguous positions must keep
their color; unrelated animation is allowed. If they change, capture fails as
unverified. The first frame is returned intact, with no cross-frame compositing. This
supports PrintWindow-renderable windows, not arbitrary GPU surfaces or a
separate desktop session. If system policy blocks PowerShell/Add-Type, capture
reports the failure; UIA operations remain available. Update Computer in Plugin
settings to receive the revised capture description and capability declaration.

## Windows semantic focus boundary (1.1.5)

WinApp 0.3.1 `set-value` and direct CUIAutomation8 `Invoke` were observed
activating a background WinForms window.
Its CUIAutomation8 client leaves `IUIAutomation2.AutoSetFocus` at its default;
Microsoft documents that this setting can focus controls before `SetValue` and
`Invoke`. Targeted UIA and no global input are not proof of focus isolation.

This revision conservatively requires the existing, explicit Foreground computer
control setting for both WinApp `computer_set_value` and `computer_press`, before resolving or
consuming its observation. Revocation prevents subsequent dispatch and requests cancellation of launched work;
termination requests remain pending until the child process and its pipes close.
It cannot undo a UIA operation already delivered to an application.
It never enables the setting, restores old focus, or substitutes global input.
This is a temporary safety boundary, not a completed background-text-input fix.
Both activating mutation paths stay gated while a verified background transport is developed.

The native smoke includes fixture-only direct CUIAutomation8 `SetValue` and
`Invoke` comparisons with default AutoSetFocus versus FALSE, with independent
continuous focus/pointer samples, provider identity and complete Unicode checks.
No experimental client is exposed as a production background-safe path. A green
screenshot epoch does not certify semantic actions or other apps/providers.

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

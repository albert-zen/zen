# ZenX GNOME App Shot extension

This is an adapted, inert source bundle from T3 Code commit
`337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17`. `upstream.json` records the
GitHub-verified source blobs. `LICENSE` contains the full upstream MIT license.
Keep it with distributions and installed copies. The five runtime files in
`bundle.json` match upstream's file set. Only ZenX names, description and UUID
are changed in the runtime bundle, along with repository formatting and omission
of the upstream product URL from metadata; GNOME's screenshot, authorization, feedback
and session-lifecycle logic remain upstream's implementation.

## Explicit user-managed setup

No code here installs, updates, enables or disables an extension, changes GNOME
settings, or toggles global user extensions. Merely packaging these files does
not grant capture access.

1. Use a **GNOME 45–51 Wayland** host session, outside Flatpak/Snap. Review these
   extension sources. Enabling this extension authorizes capture of the focused
   application, its title, application ID, process ID and window geometry by a
   same-session process owning one of the two allowed ZenX D-Bus names. These
   names prevent accidental/cross-client use; they are **not executable identity
   authentication** against another process running as the same user.
2. Deliberately install the five `bundle.json` runtime files **and `LICENSE`**
   into `$XDG_DATA_HOME/gnome-shell/extensions/app-shot@zenx.local/` (normally
   `~/.local/share/gnome-shell/extensions/app-shot@zenx.local/`). Use a regular
   directory, not a symlink. Preserve/back up any existing installation before
   replacing it, and do not overwrite a newer version blindly.
3. Save work, sign out of GNOME and sign back in. Restarting ZenX is not enough
   for GNOME Wayland to discover a newly installed extension or load an update.
4. In GNOME Extensions, enable **ZenX App Shots**. If user extensions are
   globally disabled, the user must decide whether to turn that setting on;
   ZenX must not enable other extensions as a side effect.
5. Check capability from ZenX. If unavailable, inspect the extension's status
   and errors in GNOME Extensions, the installed/bundled versions, and whether
   sign-out/sign-in is still required. An older extension requires a deliberate
   update; a newer installed version must not be downgraded automatically.
6. To revoke, disable this extension in GNOME Extensions. A capture finishing
   after the session locks or the extension is disabled will not deliver pixels.

A ready capability probe means the version-2 service is present, **not** that
capture was attempted or that an unlocked, non-greeter window currently exists.
The extension checks session availability before authorization, before taking
pixels and after the asynchronous capture.

## Host-only backend API

`apps/zenx/src/main/app-shot-gnome.ts` exports:

- `isGnomeAppShotSession(env?)`: host Wayland/GNOME/sandbox eligibility.
- `checkGnomeAppShotSupport(options?, dependencies?)`: reads service ownership
  and interface `Version`. Returns `ready`, `unsupported-session`,
  `extension-unavailable`, or `incompatible-version`. It never captures or claims
  a name. Denial, malformed data and transport failure reject rather than
  masquerading as missing capability.
- `captureGnomeActiveAppShot(options?, dependencies?)`: an explicit capture,
  returning private bounded PNG bytes, width, height and, when supplied and
  structurally valid, compositor window metadata. No AX read, model delivery,
  attachment persistence, foreground activation, flash or animation occurs.
  Omitted metadata yields pixels only; never infer a window from later focus.
- `gnomeAppShotClientName(development?)` and fixed UUID/service/path constants.

`options` are main-process-owned: `development`, `env`, `signal`, `excludedPids`.
Do not expose these or dependency injection to a renderer. Use a fresh abort
signal fenced to the host capture owner; cancel if the originating composer or
capture owner changes. A compositor-supplied PID matching the main PID or an
excluded PID is rejected. Missing metadata or PID 0 cannot establish self-window
identity and remains pixel-only; do not claim unconditional self-window exclusion
or use unknown identity for accessibility enrichment.
Existing host integration must persist attachments only after its own owner
checks. A denial/cancellation/failure must not fall through to another backend.

The production and development claims are respectively
`io.github.albert_zen.ZenX.GnomeCapture` and
`io.github.albert_zen.ZenX.Development.GnomeCapture`, deliberately distinct from
the Niri shortcut action bus. Claim and capture share a fresh connection;
`DO_NOT_QUEUE` and primary ownership are required. Capture targets the exact
service owner whose interface version was checked. The connection closes on
success, failure, cancellation, clean EOF or a 15-second overall deadline.
Native image calls are synchronous and cannot be interrupted by the timer; a
monotonic elapsed-time check rejects their result if they overrun that deadline.
As with upstream, an already dispatched compositor request cannot be undone;
late pixels are discarded after cancellation, not persisted.

PNG input is capped at 32 MiB and 100 million pixels before native decode;
returned images fit 2560×1600 and 20 MiB. Output is copied into caller-owned
memory. No filesystem screenshot path is accepted, created, read or removed.

The extension retains upstream's feedback methods for parity, but this client
only calls `Capture`, never `CaptureWithFeedback`, `Activate` or `Animate`.
The feedback methods retain upstream sender/session ownership checks.

## Evidence limits

Targeted tests inject the D-Bus/native-image boundaries and exercise the actual
pure `CaptureService` module, including allowlist denial and session races.
They do not open a session bus, install an extension, touch GNOME settings,
capture user pixels or claim that GJS/real GNOME compositor integration was
validated. A GNOME 45–51 Wayland smoke test remains required at integration time,
with explicit user authorization for installation/enablement and capture.

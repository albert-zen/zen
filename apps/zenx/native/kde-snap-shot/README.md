# ZenX KDE App Shot helper

A dedicated, one-shot native executable adapted from [T3 Code at 337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/native/kde-snap-shot). `UPSTREAM.json` records the connected-GitHub-verified input files and blob hashes. `LICENSE.upstream` is the exact upstream MIT license.

KWin grants ScreenShot2 access to a **specific installed executable** identified by a desktop entry. A generic Node D-Bus client, an Electron process, or merely shipping this source/binary cannot substitute for that identity. ZenX never installs, updates, copies, registers, or repairs this helper automatically.

## Runtime boundary

Only two commands are exposed:

- `check` returns `{"protocolVersion":1,"ready":true,"feedbackAvailable":false}` after an authorization probe using an invalid window ID and `/dev/null`. The probe cannot produce a screenshot and does not load a KWin script.
- `capture <private-directory>` returns `{"protocolVersion":1,"window":null|Window}` and creates a new `capture.png` with mode `0600` inside the host's unpredictable `0700` scratch directory. The host reads at most 32 MiB, validates PNG dimensions, bounds output to 2560 × 1600 and 20 MiB, and removes its scratch directory on success, failure, timeout, or cancellation.

`Window` retains upstream `id`, `title`, `appName`, `appIdentifier`, `processId`, `bounds`, and `clientBounds`. An identity is returned only after the same window is rechecked, including PID, app identity/name, frame and client geometry, and title (allowing only a leading CLI spinner). Missing scripting or a changed window yields pixels without identity, never guessed metadata or text. The host rejects its own or explicitly excluded PIDs only when identity is present; a pixels-only result cannot prove self-window exclusion. Callers must not treat it as verified external-window identity. Denial has no alternate capture fallback.

KDE lock protection is inherited from the compositor, as in [pinned T3's capture path](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/native/kde-snap-shot/src/main.rs#L284-L303), not an independent helper pre/post query. Official [KWin v6.4.3 ScreenShotEffect::isActive](https://github.com/KDE/kwin/blob/v6.4.3/src/plugins/screenshot/screenshot.cpp#L415-L419) checks `!effects->isScreenLocked()`. Its [watcher](https://github.com/KDE/kwin/blob/v6.4.3/src/screenlockerwatcher.cpp#L51-L79) observes GetActive/ActiveChanged, while [GetActive](https://github.com/KDE/kscreenlocker/blob/v6.4.3/interface.cpp#L113-L116) excludes AcquiringLock. A user-requested capture could therefore overlap a lock transition without an independently established atomic barrier. This is a source-derived residual race, not a reproduced leak or measured probability. It does not disable KDE or prove ordinary explicit capture unsafe; the result remains a local draft and is never automatically sent. No live locked/unlocked/racing-session acceptance or equivalent behavior across all Plasma implementations is claimed.

KWin scripts use the per-operation helper connection, authenticate callback sender ownership, and unload after each completed or failed evaluation. As in upstream, an externally killed process or a compositor crash can prevent the final unload attempt; host deadlines are not a promise that KDE acknowledged cleanup. Validate this case on a real Plasma session before native acceptance.

The upstream `feedback.rs`, `feedback.qml`, `feedbackGeometry.js`, and `activate.js` are retained for provenance but are **not linked or invoked by this capture-only executable**. The host API exposes no activation or feedback method. No shortcut or persistent KWin script is installed.

## Manual authorization prerequisites

These are documentation for a deliberate user/admin setup, not actions performed by the app or build script:

1. Build the dedicated executable for the intended Linux CPU architecture. Place it at the exact absolute path `$XDG_DATA_HOME/zenx/kde-capture/zenx-kde-snap-shot` (default `$HOME/.local/share/zenx/kde-capture/zenx-kde-snap-shot`). The executable and its directories must be user-owned, real files/directories, and not group/world writable. Set the owner executable bit. No symlink or PATH-discovered helper is accepted.
2. Manually place a matching desktop entry at `$XDG_DATA_HOME/applications/io.github.albert_zen.ZenX.KdeCapture.desktop`. The inert `.desktop.in` file in this directory documents its required fields. Replace the placeholder with that exact absolute executable path; shell variables are not expanded in `Exec`. Keep `X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2` exactly as written, without an XDG-style trailing semicolon. Keep `X-ZenX-Capture-Helper=true` to identify the deliberate ZenX entry.
3. Desktop Entry `Exec` values have two escaping layers. Surround the path with double quotes; escape backslashes, double quotes, dollar signs and backticks for Exec, then escape backslashes again for the Desktop Entry layer. Double literal percent signs as `%%`. The client validates this exact representation, including paths containing spaces. The entry must be a user-owned, non-symlink regular file without group/world write access.
4. KDE's service cache must see the entry in the **same user, XDG search paths and locale/session environment as Plasma**. A user/admin may refresh that cache with the appropriate Plasma tools (upstream uses `kbuildsycoca6 --noincremental`, including a same-session refresh). This is an authorization-affecting manual action. ZenX does not run it, invoke `systemd-run`, change desktop settings, or request permissions on the user's behalf.
5. Only after deliberate registration should a read-only `check` succeed. `NoAuthorized` or an incompatible protocol remains an explicit failure; the app does not reinstall or silently migrate anything. The single fixed ZenX namespace is shared across development and packaged builds for now; there is no separately installed development authorization entry.

The host's `dataHome`, environment, excluded PIDs, and native-image test seam are main-process inputs, never renderer values. Installation is a trust decision about this dedicated executable; the regular-file checks do not sandbox an intentionally replaced executable owned by the same user.

## Build and CI

Requires an official Rust toolchain, a C linker, and access to crates.io (or its already-populated Cargo cache). The lockfile is pinned. Full synthetic transport tests additionally require `dbus-daemon`, `mktemp`, and permission to create a private Unix socket. They launch their own bus and do not use the user's session bus.

From the repository root:

```sh
node apps/zenx/scripts/build-app-shot-kde-helper.mjs
```

The script runs locked native tests and a release build, then prints the artifact path, SHA-256 and version. It never stages into a user data directory, registers a desktop entry, starts the helper against a real desktop, or changes OS configuration. `CARGO_TARGET_DIR` can select a private build directory. `--build-only` explicitly skips tests and reports `fullTestsRun:false`; use it only when the test-stage blocker is reported separately.

Suggested CI job: an ordinary Linux runner with Rust stable and its distribution-provided `dbus-daemon` runs the command above, plus `node --import tsx --test apps/zenx/test/app-shot-kde.test.ts`. Archive the release executable, this README, `UPSTREAM.json`, and `LICENSE.upstream` as inert artifacts. Shipping does not authorize capture.

## Remaining native acceptance

A real KDE/Plasma session is still required to verify deliberate registration, pre-setup denial, invalid-window `check` without capture, precise foreground pixels and fractional scaling, old API rejection, spinner tolerance versus changed-window identity loss, script cleanup on failure, cancellation and compositor restart, multi-monitor negative coordinates, session lock behavior, PNG permissions, package architecture/ABI compatibility, and setup persistence across application upgrades. Synthetic fixtures are not evidence of these desktop results. Activation and capture feedback are intentionally not part of this phase.

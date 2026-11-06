# ZenX native Hyprland App Shot core

Native core adapted from T3 Code at
[`337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17`](https://github.com/pingdotgg/t3code/tree/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/native/hyprland-snap-shot).
`upstream.json` records the exact Git blob IDs fetched through the connected GitHub API;
all ten upstream native files were byte-verified against those IDs before adaptation.
Both protocol XML files remain byte-identical.

## Scope and guarantees

The helper uses native Hyprland command sockets and real Wayland mapping/export protocols,
not `hyprctl`, `grim`, a screen crop, title matching, or a truncated 32-bit window address.
Capture requires `hyprland_toplevel_mapping_manager_v1` v1,
`hyprland_toplevel_export_manager_v1` v2, `zwlr_foreign_toplevel_manager_v1`, and `wl_shm`.

The capture order is lock check, active window identity, full 64-bit address to Wayland handle
mapping, shared-memory export without cursor, lock check, then identity/geometry revalidation.
Unknown lock replies fail closed. A newly locked session discards the output file.
Changed/closed windows retain image pixels only, with no metadata for accessibility correlation.
T3's narrowly defined CLI title-spinner normalization is preserved; general whitespace or title
changes invalidate metadata. The native helper excludes host-supplied ZenX PIDs before export.

SHM buffer bounds, channel ordering, alpha unpremultiplication, row padding, Y inversion,
static-window damage bypass and bounded PNG compression are retained. Native SHM allocations
are bounded to 128 MiB; PNG files to 32 MiB. The host validates file type, link count, PNG header,
pixel dimensions and native decoder results before producing a maximum 2560×1600, 20 MiB review.
Each capture uses a private 0700 temporary directory. Cancellation kills and waits for the
helper before cleanup; no alternate backend is tried after capture rejection.

The host-private `app-shot-hyprland.ts` exposes:

- `isHyprlandSession(env)` and `hyprlandAppShotHelperPath(options)`.
- `getHyprlandAppShotState(options)`: read-only version/registry probes; `ready`,
  `unsupported-session`, `not-installed`, `update-required`, or `error`.
- `captureHyprlandActiveAppShot(options)`: explicit capture returning bounded PNG pixels,
  width/height and optional original window metadata.

Host-only `dataHome`, environment, runner, decoder and PID exclusions must never become renderer
parameters. The fixed path is `$XDG_DATA_HOME/zenx/hyprland-capture/zenx-hyprland-snap-shot`,
using `~/.local/share` when XDG_DATA_HOME is unset. It does not search PATH. The helper and its
two dedicated parent directories must be owned by the running user, not symlinks, and not
group/world writable. The executable must have user execute permission. Flatpak, Snap and
Electron sandboxed processes are rejected. Missing/outdated helpers require manual setup;
there is no runtime install, upgrade, permission grant, config edit, or shortcut registration.

## Explicit developer build and manual user setup

Prerequisites: Linux, an existing Rust toolchain supporting edition 2024 and the locked crate
versions (validated with Rust 1.99.1), access to the official crates.io registry. Smithay's
default features are disabled; no xkbcommon development package is required for this core.
Do not run the capture command on a user's desktop as a build/smoke test.

From the repository root:

```sh
cargo test --locked --manifest-path apps/zenx/native/hyprland-app-shot/Cargo.toml
node apps/zenx/scripts/build-app-shot-hyprland.mjs
```

The explicit build stages the release executable, MIT notice, separate BSD-3-Clause protocol
notices, both XML definitions, README, provenance and SHA-256 manifest under
`apps/zenx/native/hyprland-app-shot/target/zenx-hyprland-dist/`. `CARGO_TARGET_DIR` and `--out`
can choose other **build output** directories. Neither command installs anything into the user's
desktop configuration. Packaging must retain the complete staged distribution, not only the binary.

The following is a manual instruction for the user, **not an app runtime action**. After reviewing
the build, the user may create the fixed directory and copy the staged distribution into it:

```sh
destination="${XDG_DATA_HOME:-$HOME/.local/share}/zenx/hyprland-capture"
install -d -m 700 "$(dirname "$destination")" "$destination"
cp -R apps/zenx/native/hyprland-app-shot/target/zenx-hyprland-dist/. "$destination/"
chmod 700 "$destination/zenx-hyprland-snap-shot"
```

The user must review existing paths first and avoid replacing symlink directories. Updating the
helper is the same explicit manual operation. The app never runs these commands or grants
Hyprland's capture permission. An explicit capture may show compositor permission UI.

## Explicit shortcut integration

At the pinned revision, T3 uses GlobalShortcuts through `xdg-desktop-portal-hyprland`, not a
Niri-style session-bus capture endpoint. See
[`DesktopSnapShot.ts` lines 1254–1296](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot/DesktopSnapShot.ts#L1254-L1296) and
[`PortalCaptureShortcut.ts` lines 394–420](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot/PortalCaptureShortcut.ts#L394-L420).
ZenX now connects an explicitly enabled, owner-fenced portal session, a fixed
`capture-window` action ID, and `BindShortcuts` without `preferred_trigger`. The user supplies:

```text
bind = CTRL SHIFT, 2, global, io.github.albert_zen.ZenX:capture-window
```

Lua configuration uses `hl.bind("CTRL + SHIFT + 2", hl.dsp.global("io.github.albert_zen.ZenX:capture-window"))`.
Development uses `io.github.albert_zen.ZenX.Development`. No code in this port edits those files.

A returned action is not proof that keys are bound. T3's managed-Hyprland branch keeps
`shortcutRegistered=false` and sets `shortcutActionRegistered=Boolean(matchingAction)` even
without `trigger_description`; verified `Activated` accepts either flag after portal sender,
path, interface, signature, session and action checks. It disables ConfigureShortcuts/retry
and tells users to edit their own config. See
[`PortalCaptureShortcut.ts` lines 245–251 and 315–326](https://github.com/pingdotgg/t3code/blob/337c5858c33bc7f8f6dfd391a2c279fa0f7e4d17/apps/desktop/src/snapShot/PortalCaptureShortcut.ts#L245-L326).
The helper alone does not establish a usable global capture flow: the desktop portal must register the action and the user must install their own binding.

## Remaining native acceptance and deliberate parity gaps

Synthetic tests cover real FD/SHM transport, exact 64-bit matching, protocol requirements,
read-only capability checks, denial, oversized buffers, lock ordering, metadata drift and
PNG pixel conversion. They do not prove a live Hyprland compositor, capture permission UI,
mixed-DPI placement, GPU driver behavior, packaged execution or real AT-SPI correlation.

Upstream activation/focus dispatch and visual flash/animation are not exposed or compiled by
this core port. `upstream-reference/feedback.rs` and `upstream-reference/ipc.rs` preserve the
verified MIT source for later parity work, but are not connected Rust modules. The host always
reports `feedbackAvailable=false`. Main capture routing, Composer controls and inert Linux package staging integrate this core.
No installer, persistent shortcut preference or compositor configuration writer is provided.

Minimal Linux CI validation is the locked `cargo test` command above, followed by the build-only
staging script and `target/release/zenx-hyprland-snap-shot version`. The version command never
connects to a compositor. Host tests run with
`node --import tsx --test apps/zenx/test/app-shot-hyprland.test.ts`. On restricted executors this
avoids the unrelated `tsx` CLI watch-server socket; the test itself needs no listening socket.

## Distribution licenses

`LICENSE.t3code`: MIT, Copyright (c) 2026 T3 Tools Inc.

`LICENSE.hyprland-protocols`: the complete, separate BSD-3-Clause notices for
`hyprland-toplevel-export-v1.xml` (Copyright © 2022 Vaxry) and
`hyprland-toplevel-mapping-v1.xml` (Copyright © 2025 WhySoBad).
The original notices also remain embedded in each XML. Binary distributions must include both
license files, not relabel the XML as MIT. Locked third-party crates retain their own licenses.

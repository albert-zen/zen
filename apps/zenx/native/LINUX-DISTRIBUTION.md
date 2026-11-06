# Linux App Shot native distribution

This is an **inert build artifact**, not an installation. The full Linux application
ships this directory beside `resources/app`, outside app/ASAR. No helper in this
directory is a runtime candidate. The files have no executable mode when staged.
ZenX never installs, upgrades, registers or repairs helpers, changes desktop
configuration, refreshes KDE's service cache, or grants OS capture permissions.

## Deliberate manual setup

First read `kde/README.md` or `hyprland/README.md`, review the licenses and verify
`manifest.json` against the release you intended to obtain. SHA-256 checks detect
corruption, not authenticity. Keep all notices and manual setup instructions with
any copied binary, including `RUST-COPYRIGHT-library.html` and the helper's
`THIRD-PARTY-NOTICES.txt`. The latter is generated from the locked Cargo dependency
set and includes crate licenses and embedded Wayland protocol copyrights. Upstream
T3 MIT and both Hyprland XML BSD-3-Clause notices remain separate and unmodified.

Only a deliberate user/admin operation may place a helper at its fixed path:

- KDE: `$XDG_DATA_HOME/zenx/kde-capture/zenx-kde-snap-shot`.
- Hyprland: `$XDG_DATA_HOME/zenx/hyprland-capture/zenx-hyprland-snap-shot`.

When XDG_DATA_HOME is unset, use `$HOME/.local/share`. Review existing directories
before copying. The helper and dedicated directories must be real, user-owned and
not group/world writable. Grant the owner executable permission manually. Keep
all distributed notices alongside the installation. The app rejects symlinks and
never searches PATH or executes this bundled resource directly.

KDE also requires the specific desktop entry described in its README. The bundled
`.desktop.in` is an inert example, not an installed desktop entry. Hyprland capture
requires supported compositor protocols and any compositor-controlled permission.
Neither shipping a binary nor passing a synthetic test grants either capability.

## Reproducible build input and package boundary

From the repository root, with an **existing official Rust toolchain**, C linker,
Cargo registry access/cache and distribution-provided `dbus-daemon`:

```sh
node apps/zenx/scripts/build-app-shot-linux.mjs --out /absolute/fresh/build-directory
```

This runs both native suites (including KDE's private mock D-Bus and Hyprland's
real socketpair/FD/SHM fixtures), then `cargo build --release --locked` for each
pinned Cargo.lock. It does not run either helper on a real user desktop. Cargo may
fetch locked crates from the official registry; no toolchain or system package is
automatically installed. The build requires the matching toolchain's
`share/doc/rust/COPYRIGHT-library.html` so standard-library notices cannot silently
be omitted. `--build-only` records `fullTestsRun:false`; that diagnostic output is
not accepted for a full portable package.

A full Linux package builds this distribution by default. To use a separately
built, reviewed artifact, set `ZENX_APP_SHOT_LINUX_DIST` to its extracted directory.
The packager validates an exact fixed file set, bounded non-symlink regular files,
checksums, ELF architecture and conservative glibc symbol evidence before copying.
The manifest's `sourceSha256` must match a deterministic digest of the current
checkout's fixed native source/test inputs, Cargo manifests and locks, compiled
protocol XML, and distributed guides/notices. The builder also requires this
digest to stay unchanged across tests and compilation. This detects stale reuse,
not a malicious artifact or signature forgery. It fails if the artifact is
missing, modified, stale, incomplete or incompatible.
Smoke and non-Linux packages skip preparation and staging before filesystem access.
No runtime code reads this environment variable or resolves helpers from it.

## Architecture and compatibility limits

The native helper release target is **Linux x64 only**, `x86_64-unknown-linux-gnu`.
arm64 helpers are not built, packaged or claimed. The existing Linux arm64 app
packaging path is preserved: automatic helper preparation/staging skips without filesystem
access or invoking Rust, and the package receipt reports `unsupported-architecture`.
Other backends remain available according to their existing requirements. An
explicit unsupported-architecture helper build or prebuilt artifact input is an
error rather than a silent success. Dedicated CI builds and tests on Ubuntu 22.04 x64.
Portable staging requires glibc symbol versions no newer than 2.35, including weak
symbol references. A release built on a newer distro may need newer glibc and is
rejected rather than described as portable. The manifest records the actual Rust
version, target and conservative glibc requirements, plus hashes of both lockfiles
and every distributed payload. It does not certify other Linux distributions,
compositor versions, graphics drivers or native desktop acceptance.

Real KDE/Hyprland authorization, foreground pixels, scaling, feedback, session lock,
AT-SPI correlation and upgrade behavior remain the separate acceptance steps in
the helper READMEs. CI has no compositor and does not claim those results.

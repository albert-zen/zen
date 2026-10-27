# Ordinary portable artifact validation

`apps/zenx/scripts/prepare-portable-delivery.mjs` wraps the existing portable
packager. It does not create a release, updater, installer or alternate product
build. Run it on the **native build target** with installed locked dependencies:

```sh
node --import tsx apps/zenx/scripts/prepare-portable-delivery.mjs --output <new-directory>
# Windows also requires the same existing downstream directory and provenance:
# --downstream <same-run-directory> --downstream-sha256 <provenance-sha256>
```

The clean Git commit/tree and exact npm/provider/IMZen locks are bound to the
whole `ZenX-<platform>-<arch>` package. The target is checked against its actual
PE/Mach-O/ELF executable header, not a browser/user-agent or filename assumption.
A sorted no-follow manifest covers every file's SHA-256/size, directory, relative
symlink target and POSIX mode (where meaningful). Links escaping the package,
known private-data/SDK/key paths, unsafe plugin archive member paths and injected
LaunchServices observers fail preparation. Public SDK fixture helpers and the
app's existing opt-in diagnostic entrypoints remain ordinary supported code;
they are not removed or enabled in a different binary variant.

The full package is archived with the runner's existing `tar`, extracted into a
new owned temporary directory, matched against the manifest and launched from
that extraction. The existing application diagnostic/public ZAS interfaces run
against isolated new Electron `userData` and Zen core roots, with only the fake
provider and synthetic work. No app bytes are patched, no real API is used and
no live profile is read. Normal app shutdown precedes a second complete manifest
check; the original directory and archive digest are checked again. macOS also
verifies the extracted signature with existing `codesign`; ad-hoc signature
verification is **not** notarization or preserved user Accessibility permission.
Windows signing is explicitly unverified, not silently called trusted.

`portable-manifest.json` carries source, target, provider digest and every file
entry. `portable-validation.json` binds the archive SHA-256 and file-manifest
digest to the actual synthetic checks, shutdown, signing status and publication
gate. A failed preparation does not emit a successful receipt. Profile paths,
tokens, chats, raw Trace and runtime logs are not uploaded. Existing broader
native capability/renderer/recovery CI remains required; this smoke is not a
replacement for it or for acceptance of the eventual user OS/architecture.

## Publication is deliberately blocked

CI currently retains **only those two JSON evidence files**, not the binary
archive or profile. The exact bundled browser is Chrome for Testing, despite
older provider wording calling it Chromium. Its [maintainer clarification][cft]
points to [Chrome terms][chrome-terms]; no applicable permission to redistribute
the full pinned macOS/Windows bundle has been established. Public download and
open-source repository licensing do not by themselves establish that permission.
The generated archive stays on the ephemeral CI runner. Do not enable a broad
artifact-path glob, switch destinations, remove the browser or replace the
provider to evade this gate. Root must resolve the precise permission and final
publication decision; retaining notices is necessary but is not that permission.

[cft]: https://github.com/GoogleChromeLabs/chrome-for-testing/issues/21
[chrome-terms]: https://www.google.com/chrome/terms/

This is cloud distribution preparation only. No local executor, computer
metadata discovery, user installation, migration or real-profile launch is
allowed by a successful cloud receipt. The final artifact must contain the
final accepted source, include its target-specific acceptance, and satisfy
`docs/itemlist-trace-local-delivery-gate.md` before any separate local handoff.

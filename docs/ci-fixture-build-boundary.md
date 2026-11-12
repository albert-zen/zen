# Fixture compilation and product resources

`npm --workspace apps/zenx run build:fixtures` keeps first-party plugin preparation
(including the Plugin SDK), then invokes the existing `build:prepared` compiler.
It produces the same main, preload and renderer bundle entry points. It does not
run `prepare:rtk`. This is an explicit fixture entry point, not a replacement for
the default product build or a claim of product resource acceptance.

## Consumer audit

The following existing consumers now use the fixture lifecycle:

- `smoke:providers`: `src/main/provider-smoke.ts` creates an isolated Electron
  app, calls provider-catalog directly and uses PATH discovery for the installed
  Playwright CLI. It does not start the product Host or Settings RTK path.
- `smoke:workspace-browser`: `src/main/workspace-browser-smoke.ts` exercises
  `createElectronWorkspaceBrowser` and a synthetic HTTP fixture directly.
- `smoke:workspace-browser-persistence`: its launcher runs the dedicated
  `out/main/workspace-browser-persistence-smoke.js` entry in fresh private
  profiles. It does not start the product Host or use shell output filtering.
- `file-end-navigation.yml`: its existing production component build and
  `capture-file-sidebar-electron.cjs` consume `out/main/renderer-file-protocol`
  plus self-contained sidebar fixture HTML. The real native navigation, wheel,
  layout, CSP and screenshot assertions and their timeouts are unchanged.

The main macOS Playwright lane invokes `smoke:providers`, whose build also
supplies subsequent Workspace browser and native file-protocol bundle entries.
A transient RTK archive failure no longer blocks these unrelated contracts.
Electron itself remains necessary for the native Electron fixtures; Playwright
and its browser remain necessary for the provider fixture. This change does not
remove those downloads or claim to resolve their cold-download 504 failures.

## Unchanged boundaries

- Default `build` and `dev` still prepare first-party plugins and RTK first.
- `smoke:real` and `smoke:unit-capabilities` retain the full default build.
- `package:portable`, packaged capability/provider smoke and launch-path
  acceptance still call `packageZenX`. It independently prepares first-party
  plugin tarballs and SHA256-verified RTK in private staging, includes the
  verified RTK resource and retains binary admission checks.
- Full App information-board and user-question workflows retain their existing
  root Host and complete ZenX builds. They are not reduced in this proposal.
- Existing app-shot jobs and background-shell preview already use explicit SDK
  preparation plus `build:prepared`; component preview scripts compile through
  Vite directly. They do not need another migration here.
- Aggregate `check` / `check:observed`, all lane selection, native assertions,
  timeouts and required-result gates stay unchanged.

No default lifecycle hook is removed, no fallback ignores a failed product
resource check, and no RTK checksum failure is retried as a successful build.
The fixture output can be an input to packaging only through the packaging
entry point, which retains independent resource preparation and validation.

## Validation and limits

The regression runs actual npm lifecycle dispatch in a synthetic package whose
RTK leaf always fails: the fixture command prepares plugins then compiles, while
ordinary build/dev stop at the failing RTK leaf before compilation. Source
contracts also guard the audited consumers and packaging's independent RTK path.
A local Linux bundle build checks the actual compiler and generated outputs; it
is not a macOS native or packaged-product acceptance result. No hosted wall-clock
saving is claimed. The immediate benefit is a narrower failure boundary on
macOS arm64, where RTK preparation can otherwise fetch an unrelated archive.

## Separate bounded GET retry evaluation

A future transport-only retry can be limited to 502/503/504 responses before a
partial archive file is opened: cancel the response body, restart at the original
approved URL, allow at most two additional attempts with short backoff, and keep
the existing shared absolute deadline and AbortController. Digest, redirect,
permission, size, truncated-body and binary verification errors must not retry.
Do not retry an entire npm install, build, native fixture or product smoke. No
retry is added by this build-boundary change.

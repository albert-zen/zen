# Test entry points

The repository has several independent verification boundaries. A focused command
is useful feedback, but does not replace the matching aggregate or platform smoke.

| Scope                           | Command                                                                      | What it prepares and checks                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Core, protocol, CLI, SDK, IMZen | `npm run check`                                                              | Formatting, Python lint, compiled TypeScript tests, Python tests, and IMZenX synchronization       |
| Node-only part of the root gate | `npm run test:node`                                                          | Builds the SDK and root TypeScript once, then runs SDK, IMZenX plugin, and Core/protocol/CLI tests |
| Root type diagnostics only      | `npm run typecheck`                                                          | SDK and root `tsc --noEmit`; useful without running tests                                          |
| ZenX                            | `npm run check --workspace @zen/zenx`                                        | Brand assets, first-party packages, Node/web type checks, all ZenX tests, and renderer/main build  |
| Standalone ZenX tests           | `npm test --workspace @zen/zenx`                                             | Prepares first-party packages before running the complete ZenX test directory                      |
| Standalone public SDK           | `npm test --workspace @zenx/plugin-sdk`                                      | Builds the SDK before testing its public API and external-package flow                             |
| Mobile                          | `npm --prefix apps/mobile test` and `npm --prefix apps/mobile run typecheck` | Mobile unit/contract tests and Expo TypeScript checks; install that app's own lockfile first       |
| Mobile/Host boundary            | `npm --prefix apps/mobile run test:host`                                     | Real TLS Host integration; also needs root dependencies                                            |

## Build once within an aggregate

The root Node test entry point always runs `npm run build`, which invokes `tsc`
with the same SDK and root configurations as `typecheck`. This is a type-checking
emit, not a transpile-only build. Therefore `check` does not run the identical
no-emit pass immediately before compiling those projects again. The standalone
`typecheck` command remains available.

Scripts named `*:prepared` require the immediately preceding preparation step in
the same checkout. They are internal composition points, not substitutes for the
standalone commands on a fresh checkout:

- SDK `test:prepared` requires SDK `build`.
- ZenX `typecheck:prepared` requires the SDK build (also performed by
  `prepare:first-party-plugins`).
- ZenX `test:prepared` requires `prepare:first-party-plugins`.
- ZenX `build:prepared` bypasses `prebuild`; callers must arrange the resources
  their build or package requires.

The ZenX aggregate prepares first-party packages once, then type-checks, tests,
and builds. The packaging test inspects all of those fresh tarballs, including
their npm file lists and provider variants, rather than compiling and packing
them again. The separate clean-source packaging test still proves that direct
packaging prepares the SDK without preexisting outputs. Portable packaging is separately self-contained: it creates an
isolated build snapshot and prepares plugin/provider resources. Its Windows
Project smoke must not build a discarded shared `apps/zenx/out` first.

## Preserve meaningful layers

Do not replace real package, process, browser, TLS, or operating-system checks
with mocks merely because unit tests cover similar names. They observe different
contracts. CI intentionally retains the real Playwright adapter, Windows attached
browser, WinApp, portable-package publication, Project lifecycle, and Android
Host/APK jobs, alongside the root and ZenX aggregates.

For large limits, test boundary arithmetic and admission against the actual
production helper with real boundary values, then use a small DOM fixture for
production controls and interaction wiring. Rendering a thousand full editors is
not necessary to prove a thousand-entry admission limit. Keep accessible names,
disabled-state assertions, stale-state guards, and representative full-view flows.

For cancellation and commit-fence tests, synchronize with the phase under test.
Do not start a short readiness deadline before unrelated package-manager work, or
use an SDK request deadline to stand in for a Catalog failure. Retain real process
and installer paths, reject early mutation failure, and release/abort/join every
fixture operation before deleting its temporary directory.

## CI download and build caches

Android caches npm data using both lockfiles and Gradle data using the mobile
lockfile plus Expo app configuration, then uses Gradle's build cache. The native
packaging jobs cache only digest-addressed provider downloads, keyed by operating
system, architecture, and provider lock. Archive integrity is checked again on
use; application builds, staging directories, profiles, and publication outputs
are never shared through that cache.

These caches change repeated setup cost, not the nine platform and integration
gates. Report cold-cache and warm-cache CI measurements separately.

## Evidence when changing these gates

Record the tested commit, command, exit status, selected/pass/skip counts, and wall
time. Compare equivalent commands and disclose cold versus warm caches. A local
Linux pass cannot stand in for a Windows or macOS smoke, and a single faster run
is not a promised CI speedup. Do not remove assertions or introduce retries,
blanket timeout increases, or broad heap increases to make a failing baseline
appear green.

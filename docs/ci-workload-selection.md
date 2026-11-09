# Documentation-only CI workload selection

The first activated selection rule removes heavy work for proven documentation-only
pull requests. It does not classify product code into partial test suites yet.
The existing shadow impact report remains advisory, not authorization to skip.

## What actually changes

For a qualifying PR, Core/IMZen, ZenX aggregate, three UI capture shards, macOS
capability/provider, Windows adapter/packaged/browser and Android jobs do not
install native dependencies, build packages, run tests or launch browser fixtures.
Their original job names and UI matrix remain emitted, with explicit omission
receipts. Keeping these tiny jobs costs runner startup time, but avoids missing
required-check names. The existing ZenX compatibility gate still requires both
lanes to finish successfully.

The selector runs on the checked-out integration commit and verifies the pinned
base/head range using the existing complete NUL-delimited, rename-disabled diff.
Both paths of a rename and deleted files are therefore included. Only README.md,
docs/**/\*.md and apps/zenx/docs/**/*.md are eligible; dot paths, AGENTS.md at any
depth, assets, JSON fixtures, MDX, executable files, symlinks and gitlinks are not.
Every changed entry present at either endpoint must be an ordinary 100644 blob.
The actual checkout must match the event identity and have the head's tree.
An empty diff, missing object, invalid SHA, oversized/unavailable diff, unknown
path, changed file mode, or newer integration tree keeps full CI.

Main pushes and manual workflow_dispatch always run full work. Manual dispatch
was added to CI and Fast feedback. No workflow-level path skip was added.

## Gates and failure behavior

- On documentation-only PRs, selection validates repository formatting after
  npm ci --ignore-scripts. Fast feedback still checks formatting but avoids SDK
  compilation and both typechecks.
- Missing/failed selection or absent/non-true output runs full work. Every
  original heavy job also has an always-executed assertion of successful
  selection, so a broken planner cannot turn an existing required check green
  even if its full fallback tests pass.
- The final always-executed CI coverage decision checks an explicit complete
  dependency set and rejects failure, cancellation, skipped or missing jobs.
- Full-work steps retain their original commands, environments, conditions,
  timeouts and evidence. Original always()/failure() uploads stay active when
  full work runs. The Android no-op receipt does not use its absent apps/mobile
  directory, and Windows receipts explicitly use bash.
- No branch protection or repository rules are changed. A read on 2026-11-07
  reported main unprotected with no required contexts. The implementation
  nevertheless preserves old named checks instead of relying on a newly added
  required context being configured.

## Cost evidence and measurement boundary

At main 52b94cb059a4ad78d11b43c74a93f7518c10c0e1, CI run
https://github.com/albert-zen/zen/actions/runs/42255880187 consumed 5,191 summed
job seconds (86.5 runner-minutes, unweighted by OS billing). This includes one
failed Windows browser and one cancelled macOS provider job, not an all-green
performance baseline. ZenX aggregate was 904 seconds; the three UI shards
consumed 363 + 304 + 338 = 1,005 seconds; Windows packaged consumed 780 seconds.
Fast feedback run 42255880093 added 136 seconds.

An earlier successful split-CI run 42198339999 consumed 4,162 summed job seconds
(69.4 runner-minutes). Its UI was not yet sharded, so it is a historical reference,
not an identical workload comparison.

For qualifying docs changes the 11 heavy runner executions now omit their heavy
steps. They still allocate runners for named receipts; selection, formatting,
two gates and Fast feedback have nonzero cost. The figures above quantify work
currently avoided in representative full runs, not a measured docs-only savings
claim. A real hosted docs-only run is needed to report its actual runner minutes,
queue delay and exact emitted check names. Main remains deliberately full and
non-doc PRs add a small selector/gate overhead.

## Next dependency-map stage

Prioritize isolation of Android-only and renderer-only changes, but do not enable
those candidates using directory names alone. First map root lockfiles/config,
plugin SDK and first-party packaging, Core/native protocol, renderer shared CSS,
preview builders/fixtures and each platform's package inputs to dependent jobs.
Unknown/transitive changes remain full. Record each proposed mapping against
actual changed-file sets and outcomes, add mutation/rename/delete regression
fixtures, then activate one proven lane at a time while retaining stable gates.
This first patch intentionally makes no partial-code coverage claim.

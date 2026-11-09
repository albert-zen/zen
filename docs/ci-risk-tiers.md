# PR risk checks and full acceptance

Every pull request, whether draft or ready, receives Fast feedback static checks
and a selected-risk CI run. `opened`, `synchronize`, `reopened` and
`ready_for_review` are explicit triggers. Becoming ready does not request the
complete aggregate. Main pushes and manual dispatch run the original full CI.
Use manual full CI for release/pre-release validation; this change does not
create a new recurring schedule or alter repository merge permissions.

This is an explicit coverage policy, not a claim that a small test list proves
the complete dependency closure. The complete ZenX aggregate is deliberately
moved off ordinary PR updates. There is no frozen repository fingerprint.

## PR policy

All non-document PRs run the static/type/format checks in Fast feedback plus the
explicit unit baseline in `scripts/ci-risk-selection.mjs`. Changed existing
unit files are added without a test-name filter. Domain-specific unit files are
added to that baseline. The selected lists are deduplicated and retained with
the exact plan digest, checkout SHA, run ID, run attempt and process exit status.

- Ordinary documentation-only changes retain formatting and named omission
  receipts, as before.
- `apps/mobile/**` selects the existing Android TLS Host integration, typechecks,
  tests, Expo generation and debug APK job. No desktop aggregate is required.
- Renderer source selects all three existing synthetic UI shards.
- The explicit browser/Chrome/Playwright source, script and unit filename
  families within ZenX select Windows attached-user-browser and macOS real
  Playwright jobs. An unmatched directory/file cannot borrow this small set.
- Windows native families select Windows computer and packaged-provider work.
  macOS launch/accessibility families select packaged capability on macOS.
  Shared computer/app-shot/shell families retain all five platform jobs.
- Desktop packaging, staging, preparation, provider resources and plugin package
  changes retain UI and all five platform jobs.
- Root manifests/lock/config, Core, CLI, IMZen, root test changes and unknown
  paths conservatively select Core/CLI/IMZen, Android, UI and every platform job.
  Cross-domain changes take the union. This still omits the full 700-file ZenX
  aggregate on PRs; it is all-risk PR acceptance, not full acceptance.
- New, deleted and renamed unit tests select all PR risk lanes. Deleted files
  are not silently ignored. Existing declared baseline files must still exist
  or the quick runner fails and the policy must be updated explicitly.

The selectors use complete pinned, rename-disabled NUL-delimited Git diffs;
check endpoint ordinary modes and exact integration checkout identity; and fall
back to every PR risk lane if evidence is absent, nonordinary or inconsistent.
The unchanged shadow classifier is advisory only. No old import graph or stale
manifest can authorize omission after main evolves.

## Gates and current-run evidence

Every heavy job retains its successful-selection assertion and original work
commands, timeouts and failure evidence. A lane can omit only for its exact
versioned omission token paired with the matching PR tier. Missing, unknown or
contradictory outputs cannot produce a green coverage decision. Non-PR events
force all work regardless of omission outputs.

The existing ZenX compatibility and complete CI coverage gates remain. Coverage
also validates the whole tier/output schema and reports whether this run was
PR selected-risk or full. Existing check names remain for compatibility, but their summaries explicitly
state PR selected-risk versus full scope; neither a quick green result nor an
omission receipt is presented as complete acceptance. Fast feedback is not used as evidence that
native jobs or the full aggregate ran.

Quick units recompute the same immutable plan and require its digest to match
the selection job. The digest binds run/attempt as well as source identities.
Receipts have unique SHA/run/attempt artifact names. A prior successful run for
the same SHA cannot substitute for the current run's dependencies or unit plan.

## Costs and limitations

This removes the ten-minute-class full aggregate from normal PR updates and
omits unrelated platform work for recognized code domains. Relevant native
checks can still dominate the critical path, and unknown/shared changes retain
a broad risk combination. Existing specialized feature workflows keep their
own positive path triggers; this patch does not claim to eliminate all other
workflow work. Static/type feedback remains a separate required signal.

The first local checkpoint is not hosted performance evidence. Actual runner
minutes, queue time and wall-clock reduction must be measured on the resulting
workflow. All original full aggregate stages (brand, plugin preparation,
typecheck, full observed test glob and build) remain in the full command on
main/manual. No product tests, native acceptance steps or platform timeouts were
removed from that full tier.

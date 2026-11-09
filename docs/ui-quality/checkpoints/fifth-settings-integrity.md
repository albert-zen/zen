# Fifth implementation: settings draft integrity

This checkpoint fixes reproducible settings data loss and invalid-input recovery.
It is not a redesign of Host configuration authority or an additional persistent
state system. Product rules remain in `apps/zenx/docs/ui-ux.md`.

## Source identity

- Final UI code: `1ebcb0501f0e5f3d8886b6e8288921adff78fb68`.
- Final UI tree: `99cb2445f718585ae5faeba25068a00acd4e1124`.
- Verified remote code commit:
  https://github.com/albert-zen/zen/commit/d8c4c5467aec0d9f2292bc6b2303a78e4336bc21
  has the same exact tree. Git metadata differs; code equivalence is verified by
  tree, file modes and blob hashes, not by calling the two commit IDs identical.
- Earlier saved slices: `0b166ecd` and `901e135d`. Each has its own remote readback
  and recoverable bundle/patch. Later changes did not replace those records.
- Final isolated combination with main and #748: `bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`,
  tree `746ff97626902500d8ae5f73cba6d706a4da9910`. It is not merged into the UI branch.
- Main remained `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`; #748 remained open/draft
  at `0d6a106614db9135b66b4d6fd443f1e664b57d36` when rechecked for this integration.

## Problems and changes

1. **An independent provider save discarded unsaved General settings.** The
   actual native app retained a queue-mode draft across section navigation but
   lost it after saving a local FakeModel provider's display name. Provider
   success and committed-error refreshes now preserve actual local differences
   over the returned Host settings, including edits made while a request waits.
2. **Saved authority and a draft could diverge during delayed responses.** The
   saved profile and draft now update atomically in renderer-local state. Newer
   observed revisions cannot be replaced by an older activation/provider result.
   Untouched Host fields are adopted; edited fields are retained. Provider
   identities/revision remain authoritative, and removed model references are
   not resurrected. Account, application-status checks/retries and Safe restart
   use the same independent-readback path.
3. **Apply needs its own submitted baseline.** Successful Apply reconciles against
   the submitted draft, retaining later edits without overwriting a newer Host
   result. A transient set records fields explicitly edited during that Apply,
   so changing a value back to the old saved value is not mistaken for no edit.
   The set is cleared after success and failure; it is neither persisted nor
   transmitted. Untouched submitted values still yield to newer Host authority.
4. **A dirty draft could Apply while Maximum tool rounds showed invalid input.**
   Raw invalid text now blocks Apply and survives section hiding and unrelated
   Host updates. An error also explains the blocked action from other sections.
5. **Real native typing exposed a second recovery problem.** An unfinished minus
   and a truly cleared number both expose the value `''`. React's deduplicated
   change event left the error/Apply lock after clearing the minus. The final
   tiny correction uses the same single parser on every input event. It does not
   add a second parser or interpret invalid text as Unlimited. The regression's
   simulated validity explicitly remains a unit-test shim, not native evidence.

The production scope is `SettingsView.tsx`, plus interaction regressions and one
product-rule clarification. No production protocol, scheduler or persistent
domain changed. QA did not sign in, connect an external provider, or change the
user's credentials or permissions. Disposable native hosts created their normal
ephemeral local IPC authentication; those token files are excluded from artifacts.

## Verification

- Final UI code: **147/147** focused settings/model/provider tests, final Node and
  web type checks, formatting and whitespace checks passed.
- Final combination: **244/244** focused settings/scroll/sidebar tests plus the
  bounded **8/8** real-App cases passed. Both typechecks and the prepared build
  passed. The 14 protected #748 non-CSS files and its 36-line fullscreen CSS
  change remained intact. See `settings-input-integration-final.md` for exact
  commands, source/build fingerprints and bundle/patch recovery verification.
- Independent Terra findings were fixed through deferred-response and input
  regressions rather than inferred from appearance. Reviews retain their exact
  inspected source identities and distinguish static inspection from execution.
  See `../reviews/settings-draft-integrity-terra.md` and
  `../reviews/settings-draft-followup-terra.md`.
- The earlier complete App attempt and isolated 5,000-history limits remain as
  documented in `large-history-isolated-verification.md`. These focused results
  do not turn that into an aggregate or CI pass. Remote status/workflow queries
  returned no reported runs.

## Native evidence and its boundaries

The earlier combined build `4893830a2139e074e9091d5d5a22651bb9e03032` completed a
fresh, actual Linux Electron settings journey using only isolated FakeModel data:

- Queue and max12 drafts survived a provider display-name save. Stored fields
  remained revision1 / soft / explicit=false / no maximum until Apply, then
  changed to revision2 / queue / explicit=true / max12.
- Account to Models, invalid provider summary, section retention, Cancel followed
  by Enter reopening the saved model, and Chinese/English switching were observed.
- Invalid 0 and an unfinished minus blocked Apply. Directly clearing the minus
  exposed the recovery defect and was retained as failure evidence rather than
  counted as successful recovery.

The final combined build `bebe9276` then completed a fresh native recheck:

- Actual `-` and `1e` typing each showed an error and blocked Apply. Directly
  clearing either recovered valid Unlimited and enabled Apply without an
  intermediate valid value. Correcting `-` to 18 also recovered, and Apply
  persisted Queue, explicit provenance and maximum 18.
- While new chunks continued arriving, Reading checkpoint 28 held for
  16.773 seconds. Switching threads and collapsing the sidebar retained it.
  Back to live resumed following; Stop returned the composer to idle and the
  local model interruption/turn-aborted assertions agreed with the visible
  stopped state. The screen showed “Progress kept,” but no post-stop content
  retention or restart-recovery test was performed. See `stop-evidence-scope.md`.
- Terra independently inspected the final six numeric-input images, hashes,
  persistence assertion and execution record. Its scoped Linux Electron
  bad-input concern is closed; it did not itself operate the native app.

See `settings-native-validation.md` and `settings-native-manifest.json` for the
35 original screenshots and exact stage/action identities. Three capture files
preserve confirmed earlier failures. The two final clear-to-Unlimited JPEGs are
byte-identical end states; the distinct action sequences depend on the native
execution record, not those stills alone. File counts are not counts of unique
states or passes. Earlier captures are not relabelled as the later binary.

No actual sign-in, provider connection, credential change, security toggle or
real-user profile was used. No cross-platform, screen-reader, measured WCAG or
full-application acceptance is implied.

## Final independent visual review

The final Sol review inspected all 35 originals before the operator narrative,
verified their identity and used the same ten-dimensional rubric without an
overall score. The scoped scores, in rubric order, are **3, 4, 4, 3, 3, 3, 3, 4,
3, 3 out of 4**. Each is limited to its explicitly observed state set; these are
not whole-app ratings and are not directly comparable with earlier broader
frozen reviews. See `../reviews/final-settings-visuals-sol.md` for each positive,
negative, confidence, image ID and falsifiable next check.

No P1/P2 problem was demonstrated in the final numeric and short live-reading
states. Earlier provider captures retain P3 closed-caption truncation and
provider-only “Settings saved” wording while other settings are dirty. The
review also notes minor singular/plural Models naming. These observations are
not relabelled as fresh final-build provider failures, nor declared fixed.

## Remaining work

The scoped queue/source audit found no confirmed functional defect and retained
two optional P3 ideas: full-name visual disclosure on archived Subagents and
reorder hover labels. Existing accessible names, source tooltips and focus are
not falsely reported as absent. See `../reviews/queue-source-affordances-sol.md`.
Those suggestions were not implemented or counted as resolved here.

The new official Codex interface reference is historical published evidence, not
an authenticated competitor audit; it does not rewrite any frozen review score.
The earlier black-frame diagnostic, unresolved reference-name ambiguity,
full-suite memory limit and other explicit coverage gaps remain open.

# Delivery integrity review

Reviewed frozen uncommitted UI slice against `a7c36125a85f48c0d84b9783e1038893a05b2ff2`; source, tests, authority docs, and portable fixture were inspected. No production files were modified by this reviewer. This is an independent pre-fix snapshot, not a review of subsequent edits.

## Findings

### P2: A successful full delivery check can discard exact canonical acceptance

`apps/zenx/src/renderer/src/App.tsx:2381–2406` chooses the cached projection whenever the same epoch's cache watermark is greater than or equal to the full recovery watermark. It then reconciles only that projection's `canonicalItems` and returns `checked`. Ordinary navigation fills this cache from `resume-window` (`App.tsx:1396–1397`), while a check requests full `resume`. The native recovery service uses `readThreadHistory` for windowed and `readThread` for full recovery (`src/protocol/native/recovery.ts:79–81`); the default history window is 20 turns (`src/thread-history-window.ts:30`) and `projectNativeThread` stores that partial item list as `canonicalItems` (`apps/zenx/src/renderer/src/thread-view-state.ts:658`).

**Reproduction (no app or side effects):** use `selectThreadHistoryWindow` on 21 synthetic user-message items, each with a distinct turn, and an unconfirmed pending presentation whose `clientId` matches only the first item's ID. Set both window cache and full recovery to the same epoch and watermark, then evaluate the App branch and call `reconcileCanonicalAdmission`. Actual output: `windowContainsExact=false, fullContainsExact=true, remainingUsingCurrent=1, remainingUsingFull=0`. This occurs, for example, if an uncertain send's acceptance is missed while the connection is interrupted and that acceptance ages out of the latest 20-turn window before the user checks. Even though the full read explicitly contains the exact accepted identity, the row stays and newly says “Check completed. Delivery is still unconfirmed.” The wording is conservative about absence but fails to honor positive exact evidence and can encourage unnecessary retry. The underlying cache choice predates this slice; the explicit completed-result assertion is new.

Consider preserving the newer rendered projection while independently reconciling exact canonical evidence from the usable full read, subject to the existing thread and epoch fences. Include events projected from the recovery where relevant, and add a test for equal and newer watermarks, plus changed-epoch/stale-owner guards. Do not infer rejection from absence.

### P3: QA README overstates the tool-effect isolation of the fixture

`docs/ui-quality/scripts/live-native/live-qa-controls.mjs:43–48` passes every non-QA command to production `FakeModel.stream`, which recognizes `!shell` and `!tool` and emits tool calls (`src/model.ts:1034–1085`). The native host creates its ordinary tool environment (`apps/zenx/src/main/app-server-host.ts:626–646`). `README.md:66–67` categorically says there are no model tool effects. A non-executing synthetic reproduction installed the fixture and asked FakeModel to stream `!shell echo synthetic`; the result was `{"type":"tool_call", ..., "name":"shell", "arguments":{"command":"echo synthetic"}}`. This demonstrates an emitted tool request, not that a command ran. The seeded threads use read-only sandbox and always-approve settings, and the README correctly notes that the network block is not an OS firewall. Those safeguards make this lower severity, but fake-provider validation is not itself a no-tool guarantee.

Consider a fixture-local text-only fallback and explicit rejection of command forms, with tests for ordinary and multipart typed input, and state that other user-driven changes and OS-level containment are outside its guarantee.

## Other review notes

- Per-row feedback is scoped to the keyed client ID, keyed admission status, and keyed thread view. A ref fences same-frame activation; cleanup retires late component feedback. `unavailable` and exceptions remain distinct, and successful copy says delivery remains unconfirmed or that an admitted row awaits projection. Recovery/dismiss controls remain separately authorized; checks do not send.
- Existing same-epoch watermark choice prevents a stale recovery from replacing a newer canonical projection, and the changed-epoch check rejects an incompatible intervening cache. I found no demonstrated cross-thread selection takeover in the inspected paths. The missing full-history evidence case above is distinct from stale projection replacement.
- Pending scrollbar changes are color-only and target the shared bounded tray; forced-colors is restored. The send menu uses a constrained flex/scroll body and narrow-width layout. I did not launch a desktop or visually verify a platform's native scrollbar or extremely constrained viewport. Static CSS tests do not establish visual or accessibility acceptance.
- Fixture checks isolate the seeded root/repository and enforce fake provider profile at launch; creation refuses an existing root. This is not a claim that a modified profile, plugins, other process, or shell is OS-network-confined.

## Checks

- `node --import tsx --test apps/zenx/test/pending-send-check.test.ts apps/zenx/test/pending-tray.test.ts apps/zenx/test/composer-send-readability.test.mjs`: **23 passed, 0 failed** (log `/tmp/review-delivery-focused.log`).
- `node --import tsx --test --test-name-pattern='delivery check reports usable' apps/zenx/test/app-project-picker-interaction.test.ts`: **1 passed, 0 failed** (`/tmp/review-delivery-app-focused.log`).
- A broader combined run (`/tmp/review-delivery-tests.log`) recorded **136 passing tests and one failed test-file process**; the App test file crashed after a large historical-render test with V8 `Ineffective mark-compacts near heap limit` at roughly 2 GB. It is not a full pass. These tests did not cover the equal-watermark full-history case above.
- Minimal deterministic helper reproduction and FakeModel tool-call reproduction passed as described above. No command from the latter was executed.
- No desktop launch, real user data, commit, push, or full aggregate `npm run check` performed.

## Independent re-review after fixes

Both findings are **resolved within the reviewed scope**. The production patch preserves the existing projected-cache selection and epoch/thread guards, while feeding the full read to the existing exact-pending-identity helper separately before normal projected reconciliation. It does not concatenate ordered snapshots, does not use absence as rejection, does not issue a send, and preserves newer drafts and the newer rendered projection. Preserving a recovered draft and legacy failed submission is acceptable here: it avoids erasing user text, and an explicit unchanged retry retains the existing client ID. The fixture now has a text-only local fallback and rejects shell/tool command forms, including typed multipart inputs, before output; its documentation describes the actual scope and limitations. No new blocker found in this bounded rereview. Native visual acceptance remains outside this review.

Independent bounded reruns on the patched files:

- `node --import tsx --test --test-name-pattern='delivery check (uses full exact receipt|reports usable)' apps/zenx/test/app-project-picker-interaction.test.ts`: **3/3 passed**, including same- and newer-watermark cases and unavailable/throw/late canonical behavior (`/tmp/delivery-rereview-app.log`).
- `node --test docs/ui-quality/scripts/live-native/live-qa-controls.test.mjs`: **12/12 passed** (`/tmp/delivery-rereview-qa.log`).
- No large App suite rerun, desktop launch, production edit, commit, or push.

SHA-256 of final inspected sources and directly relevant tests (captured after bounded reruns):

```text
24c6dd569c4bed05c8a9d99d4cca17f4e1282d7ca989785be6f543e1376f78ca  apps/zenx/src/renderer/src/App.tsx
12029d3de5740daa97c121adf8f76b5b1dd1db13cdbce261d13b61c7363d39db  apps/zenx/src/renderer/src/composer-state.ts
7b840faf88e5ec16d33d93c9f8b3918fda03d02b884e878b477178d853073494  apps/zenx/src/renderer/src/PendingSendRows.tsx
4b4d86f975466e56419e203a074afaeec01405ce2c689bd519ab7309bd64ca5a  apps/zenx/src/renderer/src/ThreadView.tsx
7ebf25135317403431c026c934d58a6d74fe57a7413e20916c42882e7e4b8e29  apps/zenx/src/renderer/src/ComposerSendControl.css
0f726a271a5cad5f27ddb223448eb7a594ee2453e22bc70cedbbed2813db988f  apps/zenx/src/renderer/src/queued-messages.css
e7dab053ca6143202413d22d091fb8f5742ae7742a7871cfa0483893a727e67d  apps/zenx/src/renderer/src/i18n/shell.ts
d187c02a9f8b8457ff382a22a2c8b13fbff96f525e096219849fbd5f49776ddd  apps/zenx/test/app-project-picker-interaction.test.ts
1bfdfd8fe1364c027675cbc22eed84139a8c7ec5041ecf0d03f7803721019915  apps/zenx/test/pending-send-check.test.ts
0041878e66a3950f39d2b71f594bdfb71025adddea14c9f7176aeaf3b8c385c8  apps/zenx/test/pending-tray.test.ts
32a4e81f6404a4e752df77cf26c17dc09b9f0dc376b0cc3fa7b2b2312dfe1176  apps/zenx/test/composer-send-readability.test.mjs
2c54d9f91ca67e38282a5368e2861d2becd8e4ef2e48efcfe607a10510e94230  docs/ui-quality/scripts/live-native/live-qa-controls.mjs
34914cf474bf1b5418db520eee213d902bc41a5a2302d9357c13a6b36da9966d  docs/ui-quality/scripts/live-native/live-qa-controls.test.mjs
11f5621a89c7fc0d611530ae04a7c737184e4a3390df036f73d5d049153c305a  docs/ui-quality/scripts/live-native/live-qa-preload.mjs
bfaa17d81fa9fbc1240876f573364c3ae58f63da9eae7f736e192a2e57a5f863  docs/ui-quality/scripts/live-native/launch-live-native.cjs
dd6a1425bea880f325587ffd3f9a27ef6f03e847212b1cc7d03bd12bc1e1b09f  docs/ui-quality/scripts/live-native/launch-live-native.sh
8fe2bdf10c8653d7fc7c9526ff44f918e7def34af9bece965478a0931cdfae20  docs/ui-quality/scripts/live-native/seed-live-native-journeys.mts
442b513f71369644a9fef7d55c2c7c517992996f63c9ae93d12ae58ced8ac105  docs/ui-quality/scripts/live-native/README.md

```

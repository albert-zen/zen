# Room information timing verification

Verified 2026-11-09 against the UI-quality candidate based on `5ebb6e83`.

## Finding and narrow fix

Two test synchronization assumptions were demonstrated, rather than dismissing the failures as flaky:

1. The original combined run passed 133/134. The Room test expected `Synthetic timer` after a fixed 30 ms setup sleep, but the DOM contained only the transcript, attention and toolbar. `information.read()` had not finished its filesystem-backed native layout read. An 80 ms synthetic read delay reproduced the exact failure.
2. After fixing initial setup, another combined run passed 133/134. The retained-edit test still showed `Saving the retained edit` after its fixed 50 ms post-release sleep. An 80 ms delay on its third synthetic native update reproduced that exact failure.

Only test synchronization changed. A bounded helper polls at 10 ms intervals for up to 2 seconds. Initial setup waits for a widget under the exact current owner's panel. Releasing the held update waits for the panel's busy state to clear. Missing results still fail explicitly. Original timer/member/privacy, no-repeat-write, durable-store, and initial-empty/error-gating assertions remain unchanged. Other focus, read gates and reopen checks remain intact.

No production code was changed for this investigation. Source comparison found the fixed sleeps already present before the first UI slice. The first-slice panel changes concerned the heading and receipt-gated empty guidance, not native asynchronous reads or writes. The initial blank-without-empty-guidance state is intentional until a current receipt arrives.

## Outcomes

- Original isolated Room test: **1/1 passed**.
- Original exact combined rerun: **134/134 passed**, exit 0, 88.609 seconds. The original failure was not deterministic at normal timing.
- Forced 80 ms initial read with original setup: **0/1 passed**, expected failure matching the original DOM.
- Bounded initial setup with delayed read: **2/2 passed**, including the existing initial-empty/error-gating test.
- Entire information-panel file after initial setup fix: **11/11 passed**.
- Combined run after only initial setup fix: **133/134 passed**, exit 1, 58.471 seconds. Retained-edit post-release wait failed as described above.
- Forced 80 ms third update before post-release fix: **0/1 passed**, expected matching retained-edit failure.
- Both 80 ms delays together after both fixes: **11/11 passed** across the entire information-panel file.
- Final exact combined run: **134/134 passed**, exit 0, 88.796 seconds; no failures, skips or cancellations.
- Test-file Prettier and targeted `git diff --check`: **passed**.

## Exact test commands

From the repository root, with no test-concurrency override:

```sh
node --import tsx --test --test-name-pattern='actual Room layout' apps/zenx/test/editable-information-panel.test.ts
node --import tsx --test apps/zenx/test/editable-information-panel.test.ts
node --import tsx --test apps/zenx/test/thread-fork-boundary.test.ts apps/zenx/test/thread-fork-boundary-view.test.ts apps/zenx/test/thread-history-pages.test.ts apps/zenx/test/settings-interaction.test.ts apps/zenx/test/editable-information-panel.test.ts
node node_modules/prettier/bin/prettier.cjs --check apps/zenx/test/editable-information-panel.test.ts
git diff --check -- apps/zenx/test/editable-information-panel.test.ts
```

Controlled probes ran temporary sibling copies of the test file to retain all real imports. The synthetic API inserted `await new Promise((resolve) => setTimeout(resolve, 80))` after incrementing the first read counter, or before `service.update` when `updates.length === 3`. The first failing read probe delayed every read, but failed on the first read before later reads occurred. Passing read probes delayed only initial read to isolate setup. These temporary files were removed. No production delay was added.

Raw evidence retained with the verification artifacts: `tests-second-slice.log`, `room-initial-isolated.log`, `room-investigation-combined-before.log`, `room-native-delay-before.log`, `room-native-delay-after.log`, `room-information-fixed-file.log`, `room-investigation-combined-after.log`, `room-update-delay-before.log`, `room-read-and-update-delays-after.log`, and `room-investigation-combined-final.log`.

The initial tsx CLI invocation failed before tests because its Unix IPC pipe was unavailable in the sandbox. All actual runs used `node --import tsx`, matching the existing test convention. This investigation did not operate the native UI, edit production files, commit or push.

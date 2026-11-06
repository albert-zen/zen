# Joint Windows startup acceptance: #722 and #726

These unmodified native Electron screenshots come from a disposable copy of the real portable package on a GitHub-hosted Windows runner. All conversation content, provider settings, workspace paths and failure text are newly generated synthetic fixture data. No user computer, personal workspace, credentials or remote model service was used.

## Exact source

- Head: `fb5566e81b8fbd95f3a4f674a63e445c86cba9ee`
- Tree: `6df55febccfa6f6196b20314619eef203c621769`
- CI merge checkout: `281e14ab9d4105406c2288acef600d553d706567`, no changed files versus head.
- [CI run](https://github.com/albert-zen/zen/actions/runs/42213507056): all 10 jobs passed. Both auxiliary acceptance workflows passed. ZenX aggregate: 6296 passed, 59 skipped, 0 failed.
- [Windows packaged job](https://github.com/albert-zen/zen/actions/runs/42213507056/job/127877693186)
- [Original artifact](https://github.com/albert-zen/zen/actions/runs/42213507056/artifacts/13500089765), ZIP SHA256 `452e83d70fe94050c239ce58ae58cbf79b457728367555453f559ab703c73982`.
- Conversation PNG SHA256: `4f8122f0f9faac4cd097ec3817f49c447ec84821a574cb6c8912240ca8ef67ca`.
- Failure PNG SHA256: `014aafc3af0a26abf5b7dba75bf7ef9ac7018f7e0d4459639914448fca7be351`.

## Observed results

Both native startup scenarios passed. Ordinary sidebar-read and Shell-list preload requests returned their expected synthetic owner data. The prior trusted-sidebar and background-command errors are absent from the accepted conversation frame. Actual owned main-frame guard inputs used `RUNNER~1` and expected `RUNNER%7E1` URLs; encoding differed and decoded native paths matched. This directly exercised #726's encoding-equivalence path in Windows Electron.

The Windows environment regression reproduced the old reset as `legacy-null-reset-present=True`, then verified absent, empty and nonempty restoration and inheritance by a child Node process. Explicit removal lets the renderer guard use its actual expected file URL. Production trust checks were not weakened.

First visible window: success **534.5 ms**, synthetic failure **501.2 ms**. Successful milestones from process start: Host **11.356 s**, shell frame **11.714 s**, sidebar **11.852 s**, first conversation **12.128 s**. These include an intentional **3.050 s** bootstrap gate, not uninstrumented startup benchmarks.

The original window was retained and restored. Success observed a different prior foreground HWND; failure's before/after foreground HWND was already the same, so it does not prove a new focus transition. Cleanup and finalization error arrays were empty. The expected synthetic bootstrap failure remained literal text. Earlier failed runs remain failed evidence.

## Limits

One hosted Windows sample, Electron 43.2.0 and a fake provider. This does not establish installed-release acceptance, signing behavior, all-machine performance, large-history percentiles or real provider/network latency. Success stderr still contains a separate `Workspace is not configured` settings error from `markWorkspaceUsed` for the synthetic thread outside configured projects; it is not a trusted-document rejection or a visible application error. Keep #167 open for its remaining installed-release and performance work. No previous unknown-outcome macOS action was replayed.

## Native conversation

![Synthetic persisted conversation without the previous trusted-sidebar or background-command errors](conversation-ready.png)

## Native failure

![Synthetic bootstrap failure shown literally in the original native window](failure-loaded.png)

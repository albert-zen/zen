# Information board acceptance — synthetic only

Product: `897ab97e1bd83fc4f959eb8b47c398b83cb92a10` (tree `dd12bcb99390e771fe3a9de8df3739a375831f1c`). Native capture source: GitHub PR merge `5c744149140318a776c1be63650f11886e61e6ea`, same product tree.

[Full production App workflow](https://github.com/albert-zen/zen/actions/runs/41426944128): Windows and macOS each passed 14 layout/interaction cases plus the actual trigger editor capture. Private disposable fake-provider profiles were removed after normal owned App/Host exit. No user screenshot, conversation, environment credentials, or device is included. Original PNG bytes are identified in manifest.json.

Verified: wide dock; narrow overlay; workspace auto-close and manual reopen; internally maximized main Tab; resource Tab auto-close; light/dark active controls; open overlay↔dock resize; Escape/focus; same Composer node/draft; thread ownership; trigger names/enabled/paused/exact edit; lineage; native background command.

The 920px available-width / 340px card rule is our product decision, not a claimed Codex source constant. Exact native 920px geometry: chat 556px, input 490px, card 340px. At 919px: overlay, chat 919px. No horizontal overflow.

Performance regression: real App onNotification with fresh summary RPC arrays, 30 native text/reasoning deltas. Before the fix: +60 summary reads, +30 project reads, +30 plugin catalog clones. After: +0/+0/+0, with visible streamed text and canonical input/answer, turn boundaries, names, settings, and archive updates still refreshing. Separate 4,000-summary/long-text test preserves latest navigation and live trigger/Shell updates.

Retained non-passing evidence: the first native scripts were green but pixel review exposed a Windows titlebar overlap; revised header measurement and hit testing fixed it. Oversized local 5,000-turn aggregate tests exceeded the executor's default heap; those failures are retained and are not described as passing. Focused combined tests passed (43 + 7). Full CI run 41426944036 stopped at node typecheck with TS2322 in two synthetic summary mutation fixtures; seven other CI jobs passed. A two-condition test-only narrowing correction passed both local main/renderer typechecks and its three focused tests. No product/runtime code changed. Final full CI must still pass separately before merge.

The user explicitly authorized the PR description and these synthetic screenshots. Full CI status remains separately gated; this evidence does not by itself authorize a merge.

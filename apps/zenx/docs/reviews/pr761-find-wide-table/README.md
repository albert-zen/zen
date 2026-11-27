# Wide Markdown table search: synthetic desktop comparison

Two unmodified Linux Chromium 131.0.6778.0 PNGs, 1280 × 900 CSS px, DPR 1, zh-CN, light appearance. Same production ThreadView test fixture with two independent synthetic 30-column Markdown tables and no Host, provider, user history or data. Policy: offline and single fixture route only. T3 Code's prior author-recorded comparable behavior was [#39295](https://github.com/pingdotgg/t3code/pull/39295), in a user bubble rather than an assistant response; not a new T3 run and not scored against these different view states.

In both Zen builds use a horizontal mouse wheel to move the second table 113 CSS px, then open in-conversation Find with Ctrl+F and enter 仅此命中. Both report 1 / 1 and retain input focus. Before, the matched table stays at scrollLeft 0 and the Range begins at x=2264.875 (outside the visible table's x=240…1040); after, only that table moves to scrollLeft 1279 and the highlighted Range x=985.875…1024.875 is visible. Changing the query to 左端标记 returns the targeted table to scrollLeft 0. The second table remains at 113 throughout. The result for the left query rendered identically on both builds. No browser console errors or requests beyond the fixture. Not packaged macOS/Windows acceptance.

- Before: ecda9ce44b1d886c71e3ce99b6b26c53cf6e77c5; HTML SHA-256 3be7f459624aac9a1565eca9612bcc91cab4f0358e78ba8bd00db14944421eb9.
- After: 3163e537043d8d13d0a193a8210307227724fab1, same product source as #761 97dbc734; HTML SHA-256 29c72e681ef9a046d47e8f7f8906fa14519b0339ea0edfc3290fadbdbbdf784e.
- Same synthetic fixture SHA-256: c23e538d7fc448ea27d18aa898477af8557bf4e55eda7359add7b66f4b55894c.
- before.png SHA-256: 70296ad9764b8c129ee1e9c687ec7f62ffa79b453ee7841f7a1062887c317d81
- after.png SHA-256: ab35c1a60023efd3b92f192190dbed3e2e05d851fb2f5f672c96201b7597fb89

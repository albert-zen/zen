# Select-label scope diagnostic: 7eaf40fd

These are actual packaged macOS application captures from synthetic fixtures,
not component previews or first-pixel measurements. They correspond to source
`7eaf40fd3f9f989926f3dd7879ae8b7513d036a2`, tree
`096991d08754350193e3a42158de08241132174e`.

The screenshots contain only disposable CI workspace paths, synthetic messages,
fixture IDs and the offline demo provider. No user conversation, personal
configuration, credential or raw trace is included.

## Captures

1. [Dock, after canonical admission](01-dock-after-canonical.png): 1280 x 677,
   first Enter sample after it has completed. This is not the pending row's
   first visible frame.
2. [Narrow Information preparation](02-narrow-information-before-timing.png):
   1120 x 677. Actual popover presentation is verified before timed sends;
   Information is then closed before timing. Send uses trusted native clicks.
3. [Paused reader at 390 pixels](03-paused-reader-390.png): 390 x 600, after
   native wheel input and responsive checks. Composer and Back to live remain
   reachable. This is not an open Select/Combobox option geometry test.

## Fixed-source run and limits

[Native run 41637947417](https://github.com/albert-zen/zen/actions/runs/41637947417)
uses diagnostic `9707190f8f8bed4b306dad8b18655e92f9e5bc2c`, fixed baseline
`b72962a068d9ffcd7a01989aa66f12f2cde80761`, and candidate `7eaf40fd...`.
Each source has 5000 synthetic completed turns / 10000 historical messages,
three real native sends per layout, and first-send-only tracing. Source order
is baseline then candidate for dock Enter, reversed for narrow click.

| First-trace count                | Baseline | Candidate |
| -------------------------------- | -------: | --------: |
| Dock Enter Style elements        |     5062 |        30 |
| Dock Enter invalidation events   |    10129 |        67 |
| Narrow click Style elements      |     5071 |        39 |
| Narrow click invalidation events |    10152 |        90 |

The targeted historical SPAN invalidation removal repeats, but whole-send
latency is not accepted. All twelve strict later-frame feedback/clear checks
fail 200 ms. Narrow first pending DOM is 473.1 ms candidate versus 472.3 ms
baseline; candidate strict later-frame feedback still takes 1535–2172 ms.
Changing high host load and three samples per case do not establish robust
latency improvement. Later rAF and native intersection are not compositor
presentation or physical scanout telemetry.

All four cases pass source/package and driver identity checks, real pending
ResizeObserver growth, native IntersectionObserver/later-frame ownership,
panel closure/editor focus, paused-reader resize, responsive gap/overflow,
and independently reopened storage with 5003 user messages and no compaction.
The ZIP digest is
`407275a7131404f764715749506a2d6eac14d9c4ebd44d7f4ee0ce137f47610c`.

[CI 41636472656](https://github.com/albert-zen/zen/actions/runs/41636472656)
passes 8/8 jobs for this checkpoint. ZenX has 5481 tests: 5425 pass, 56 skip,
zero fail. Four specialized UI regression workflows also pass.

These fixed-source results do not validate later main commits. This evidence
does not resolve the ordinary Send bubble-delay issue, establish active
selection/media edge cases, or establish actual open-option browser geometry.

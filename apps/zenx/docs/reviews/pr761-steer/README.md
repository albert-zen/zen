# ZenX pending Steer outer frame: original synthetic comparison

Two unmodified Chromium 131.0.6778.0 Linux captures at 1100 × 900 CSS px, DPR 1, light appearance, zh-CN, identical fixture, one short synthetic message with a generated 480 × 300 image, no network or Host/provider. Both normal and pending thumbnails decoded and were hit-test visible. These are production ThreadView renders in an isolated browser, not Mac/Windows native acceptance. No UI source is changed by this archive.

| Source | Tray left/right/width | Composer left/right/width | Pending image and text right |
| --- | --- | --- | --- |
| Base b3565098 | 129 / 981 / 852 | 130 / 970 / 840 | 970 |
| Candidate 3163e53 | 150 / 950 / 800 | 150 / 950 / 800 | 934 |

Candidate outer frame matches both Composer edges. The interior rail ends at 934 = left 150 + border 1 + client width 783. The normal transcript image ends at 950; this is not a claim that both images use the same rail. Both pending thumbnails measured 120 × 90. At 961 px light the candidate still aligns the outer frames; below the 961 px breakpoint (960 light) the pre-existing layout uses the transcript inner edge: candidate outer 857, Composer 840 (base 852 and 840). No horizontal page overflow in these renders. The 1100 px dark geometry matched the corresponding light case, but only light provided a same-view pair with both image hit-tests valid.

- Same fixture SHA-256: d60bffc1f729fae84e71d24f411a4df0717a226d82ab0789228abdd167b98cd0.
- Base bundle SHA-256: fd69c64f2542aa0dca3cff2712b7c0853901e4112e2daa583f48e77561689254.
- Candidate bundle SHA-256: dbf56cc9c409ef09069c3e3dca826b45d1fd3dc0bef1433d1c3db2cc04751dac.
- Candidate production sources and product lockfile match #761 candidate 97dbc734. Linux stock Noto CJK fallback; no rerun of GitHub CI.
- main-light.png SHA-256: 8d81ad535d0a9770c3b13b47aa9213380f525ef49ba5d755bc3aa00470324ea6
- candidate-light.png SHA-256: 5892558b6a1a451cf2ed48ff5eff7af1b28ce1a9ab7476b7b46d16899039469f

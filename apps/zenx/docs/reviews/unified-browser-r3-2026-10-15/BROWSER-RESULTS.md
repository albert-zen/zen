# PR431 R3 production renderer composition QA

Source4ba841dbf11538b0ee45b6a31f080fe716e905c7 / tree1ee809ef80003acc5035d03bdd80412c8dfdb2e0. Cloud Chrome, 2026-10-15. Static Vite bundle imports real AuxiliaryPanel/WorkspaceBrowserPanel/styles. Synthetic notifications and inert placeholder, no real browser connection/session/login/form evidence.

- Unified strip shows ordinary shared pages and external read-only peer. Active ordinary page gets browser-agent-chrome 1.8s animation on address chrome; Finish removes activity status and animation becomes none while same page address/placeholder remains.
- Established presentation/follow session, manually chose Reference, requested next presentation: Reference remains selected; Follow Agent visible. Enter Follow restores Project draft. Follow button removal leaves body/document focus (not retained focus claimed).
- External tab is observer-only, native connection unavailable explicitly disclosed. Close external then Refresh external targets causes new snapshot; external remains absent. No claim that external automatic presentation/follow is implemented.
- 390px iframe light/dark Chinese: active, unknown, permission switch keyboard, external, manual-away/Follow. Unknown state static, warning retained after Space permission off, focused switch shown. Document/body width and scrollWidth390, no page-level horizontal overflow. Tabstrip intentionally scrolls; full accessible title retained.
- Integrated #425 blank component same source: light background rgb255,255,255 -> Enter Switch appearance -> dark rgb0,0,0,1132x606 unchanged. These are renderer fallback surfaces, not new native WebContents captures. Existing blank fixture base href resolves assets at /apps/assets; byte-identical bundle assets copied there. Production source and generated HTML unmodified.
- Placeholder sentence 'verified separately' is fixture explanatory text, not proof of native test success. Native CI must be inspected independently.

Screenshots01 active wide,02 finished,03 manual away,04 external wide,05 external dismissed,06 unknown dark,07 keyboard paused unknown,08 external dark390,09 active light390,10 Follow light390,11 blank white,12 blank black.

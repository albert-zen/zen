# Third implementation slice

Source: `9ac08c5792e375d1b6cdbe27c5960176e5eccf5a`.

Independent Astra complex-state review inspected all 13 original production
component captures. Its one actionable P2 was pending Fork feedback: only a faint
disabled 13px spinner was visible; the longer status existed in tooltip/accessible
text. The implementation adds compact localized visible text and locally readable
spinner treatment, including a reduced-motion fallback. Existing disabled guard,
source identity, repeated-click ownership, success/failure/retry and navigation
authority remain unchanged.

TDD observed four failing assertions before implementation. Afterward 42 targeted
and actual App Fork lifecycle tests passed; node/renderer typechecks, formatting,
diff checks and prepared production build passed. Twelve additional deterministic
preview cases covered pending/failure/success × English/Chinese × light/dark.

Five native component-fixture captures verify English pending→failure→explicit
retry→success and Chinese dark pending. Actual screenshot bounds are1180×812.
The requested compact launcher size was not applied by the desktop, so the
manifest explicitly makes no narrow-window claim. No real Host Fork operation is
claimed by these fixture images; genuine canonical Fork/source navigation was
verified separately in the earlier native app run.

The main+#748+UI integration has398 focused passing tests, successful build and
typechecks, plus nine native streaming/reading-position captures. That integrated
source predates only this pending-label slice; it is not falsely described as a
validation of later commits.

The later independent native dynamic-state review identifies additional work:
readability of the running-send panel, pending tray overflow discoverability, and
truthful settled feedback after delivery checks. Scoped presentation/feedback
work is separate. Persisting unresolved recovery copies across app restart would
change the documented renderer-only retention contract and needs a separately
defined state/storage design, not an incidental styling patch.

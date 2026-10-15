# PR386 composed model + per-thread visibility

Capture source: 5d4a94273d2a357f7c27dbb72c75f5a485f5a4aa / tree e67db37cdd3f9d25f10499395e10fd3b1917305c. Cloud Chrome, 2026-10-15. Production App, real SettingsService, isolated synthetic profile, synthetic threads/model catalog and create bridge.

## Actual checks
- Initial real profile visible IDs empty; pins design-child + ordinary. Old global visibility localStorage values deliberately true. A/B/grandchild remained hidden; ordinary pin shown.
- Selected Synthetic B / Reasoning (fixture-b), effort high. Space on A switch entered observed 250ms aria-busy/aria-disabled state while retaining native focus, then Shown with same active switch. B/grandchild remained Hidden, parent thread/Subagents selected, parent composer draft unchanged.
- A appeared in pinned section. Reopened model popup after settings update: B/high retained. One New side chat invocation recorded exact encoded fixture-b/reasoning-demo and high, parentThreadId thread-1, mode side-chat. Synthetic bridge only; no native creation or atomic backend claim.
- Switched back to Subagents, Space hid A. A absent from sidebar, ordinary pin retained, profile pins still design-child/ordinary. Conversation tab and parent draft unchanged through toggles.
- Fresh responsive fixture: real production App first at1148, then visible wrapper390px button changes iframe CSS width. At390 dark, B first Space injected one failure after250ms, error wrapped without clipping, activeElement remained B. Second Space succeeded, error cleared, same focused switch; A/grandchild remained Hidden. Document/body clientWidth and scrollWidth all390.
- Reloaded independent wide App: B visible in project, A hidden, ordinary pinned. Real profile visible IDs [test-child], pin IDs [design-child,ordinary], same server pid551. This run tested reload and disk persistence; no service/browser process restart claimed for this new composed source.

## Limitations / follow-up
- Original narrow.html starts with forced zenx.sidebar-collapsed=true; first-page pointer Open sidebar did not expose sidebar. Follow-up external responsive entry without narrow parameter, before selecting a Thread: keyboard Enter successfully opened sidebar; pointer activation did not keep it open. Existing handler/Sidebar logic unchanged from prior main according to source comparison. This narrow startup pointer limitation is disclosed separately. Narrow switch evidence uses external responsive.html visible controls, no production changes or DOM state injection.
- Native touch/coarse pointer not exercised. Keyboard and390 CSS viewport exercised. This composition run does not re-claim older screenshot source or previous service-restart QA.
- Model popup overlays tree switches, so paired03 (all switches + sidebar) and04 (retained model/effort + sidebar) document coexistence.
- All screenshots are synthetic; selected publication pending root visual approval.

Images:01 default/model;02 busy focus;03 A shown/pin/focus;04 model retained;05 A hidden/tabs/draft;06 narrow error;07 retry success;08 reload persistence.

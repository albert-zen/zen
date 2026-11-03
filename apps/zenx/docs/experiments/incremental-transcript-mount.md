# Incremental history mount experiment: not for merge

This work branch tests reducing native renderer work by mounting a recent suffix
of the existing complete transcript projection. It is not production
virtualization, not a substitute for T3's LegendList viewport, and not a claim
that ordinary Send latency is fixed. Current product rules remain in ui-ux.md.

The first checkpoint mounts the most recent 100 display rows. Load earlier
adds a prior batch without replacing already-mounted nodes, preserving the
measured leading anchor. The renderer-only reading cache remembers the extent
per exact Thread. A known explicit message-target request expands the suffix to
include that target before the existing navigation effect runs. Full canonical
history, model input and Host storage are unchanged. New arrivals do not evict
selected, focused or otherwise already-mounted nodes.

## Deliberate gaps: do not silently ship this behavior

- Manual Load earlier changes ordinary history access. Natural upward scrolling,
  a full-range scrollbar and fast distant navigation are not equivalent yet.
- Native browser find cannot reach unmounted history. T3 supplies data-backed
  find; equivalent find/materialization is required before production use.
- Existing synchronous inline quote-source and queued-editor reveal callbacks
  also assume mounted DOM. These need an explicit reveal contract, not retries
  or a silent failure.
- Loading all history grows DOM again. This is not a permanently bounded list.
- No full CI, native Send timing or exact-version screenshot acceptance is
  claimed for this checkpoint. Existing 5000-row all-DOM tests are retained,
  not deleted or weakened to disguise this experimental contract change.

The parallel reference audit pins official T3 Code to
`cefb544af3c98224874419198c0359b652ca3c94`. Its list uses LegendList 3.3.5
plus web-specific position/DOM-order/layout corrections. A faithful adapter
must use the library's own sole scroll node, keep ZenX follow ownership, and
add selection/focus/target pins and whole-data find before it is a candidate
for production. No dependency has been installed for this experiment.

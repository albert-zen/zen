# Process styling review fixture

This fixture mounts the production `Sidebar`, `ThreadView`, `ActivityText` and CSS.
All content is synthetic. It has no Host connection; host actions reject. Its
controls change only local fixture data. Original trace and turn folding controls
remain available, including raw command disclosure.

Build a self-contained offline document:

```
node apps/zenx/scripts/build-process-style-preview.mjs /tmp/process-style-preview
node apps/zenx/scripts/check-process-style-preview.mjs /tmp/process-style-preview/process-style-frame.html
```

Open `process-style-preview.html`. The "完成当前这一轮" control completes the
currently mounted turn without changing the turn ID or remounting `ThreadView`.
A 420px iframe provides a real narrow CSS viewport. Select light/dark themes and
thinking, waiting, executing, parallel, approval, stopping, stopped, failed,
recovery or completed scenes. Recovery uses existing canonical fixture events.
The existing aggregate tool glyph mapping is intentionally retained; a group
containing a shell call can keep its terminal glyph while its current activity
label says thinking. The shared sweep and 6px content spacing, not that semantic
mapping or any execution architecture, take inspiration from T3 Code.

CI uses the runner's existing Chrome. The ephemeral Ubuntu runner installs only
`fonts-noto-cjk` from its official package repository for legible Chinese
screenshots; no browser download or production dependency is added:

```
node apps/zenx/scripts/capture-process-style-preview.mjs /tmp/process-style-preview
```

The artifact includes the offline HTML, four full scene captures, two captured
animation phases for thinking, reduced-motion captures, same-turn completed
captures, measurements and browser stderr. Assertions fail if metadata moves
from its top position, a total appears inside history, the group icon/text gap
is not 6px, narrow document overflow occurs, reduced motion leaves the sweep
visible, or the renderer throws. A DOM-only smoke pass is not visual evidence.
Screenshots remain synthetic fixture evidence, not a live-Host product session.

# ZenX central Project switcher design QA

**Source visual truth**

- `/var/folders/kn/qprvl_8n6vn88tcp8tv_h2ph0000gn/T/codex-clipboard-9682f21f-cbaf-4bef-8726-5a7507b8be04.png`
- 1638 × 1037 pixels, dark macOS desktop state, New chat draft with the central Project menu open.

**Implementation evidence**

- `/Users/xbjt/work/agent-data/projects/zen/evidence/zenx-ui7-packaged-start.png`
- 1199 × 768 pixels, dark macOS desktop state, packaged ZenX startup screen.
- Packaged app: `/private/tmp/ZenX-ui7.app` from branch `codex/zenx-draft-project-switcher`.

**Viewport and normalization**

- The source and implementation have different window dimensions and do not show the same interaction state.
- No density normalization or side-by-side fidelity judgment was performed because the packaged implementation could not be advanced to the open-menu state through the available desktop-control channel.

**State and interaction evidence**

- Component tests exercise the central trigger, automatic search focus, text filtering, Arrow-key transfer into the result list, selected-state semantics, Escape/Tab/outside dismissal, Project switching, and Add Project draft preservation.
- The packaged application starts successfully from the short path and reaches `Local service ready` with the real Project list.
- Computer Use could read and capture the window, but its native action channel closed on both semantic and coordinate clicks before New thread could be opened. No message was sent and no Thread was created during QA.

**Full-view comparison evidence**

- Blocked: the source is the open central Project menu while the captured implementation is the pre-draft startup screen. Treating these as a visual comparison would be misleading.

**Focused region comparison evidence**

- Blocked for the same reason; there is no implementation capture of the central prompt/menu region.

**Findings**

- [P1] Missing rendered open-menu comparison evidence.
  Location: New-thread empty state, central Project switcher.
  Evidence: source shows the open searchable menu; available implementation capture does not.
  Impact: typography, popup anchoring, spacing, and overflow cannot be signed off visually from the actual packaged screen.
  Fix: open New thread in the packaged app, click the underlined Project name, capture the window at the same state, and compare the central region against the source.

**Comparison history**

- Pass 1: blocked before comparison because the Computer Use click channel closed; no visual findings were inferred from code or separate-state screenshots.

**Implementation checklist**

- Capture the packaged open-menu state.
- Compare full view and a focused central-menu crop against the source.
- Fix any P0/P1/P2 typography, anchoring, spacing, color, icon, copy, focus, or overflow mismatch and repeat the capture.

**Follow-up polish**

- None recorded until the required same-state comparison is available.

**final result: blocked**

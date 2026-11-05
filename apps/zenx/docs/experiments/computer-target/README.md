# Alternative A: explicit target per input call

**Decision draft, not production-wired.** Related issue: [#484](https://github.com/albert-zen/zen/issues/484).

## Contract and executable slice

Each call supplies an expected target echoed from discovery `(pid, processStartedAt, windowId)`
and an action. Click and scroll carry explicit global-desktop point coordinates;
scroll carries integer pixel distance. The adapter reads the exact window and
foreground identity immediately before attempting a single dispatch. Mismatches,
invalid points and cancellation before dispatch refuse. Failed posting reports
unknown effect and never retries. Successful posting still leaves UI effect
unverified.

`explicit-target.ts` is an executable contract prototype. Its tests demonstrate
focus/app/window/process mismatch rejection, negative coordinates, explicit
scroll location, cancellation, unknown outcomes and the remaining global-input
race. The native port is deliberately unimplemented; fake posting is not a
working macOS backend.

## Why choose A

- No retained observation-token registry or new expiration lifecycle.
- Small, inspectable per-call contract; existing window inventory can grow exact
  identity fields without creating a second session authority.
- Appropriate when callers already possess reliable global desktop coordinates.

## Costs and missing guarantees

- Callers must provide correct global coordinates. A resized window screenshot is
  not sufficient by itself; an explicit geometry read/transform is still needed.
- A window moving after a screenshot but before the call can cause an in-window
  wrong-control click even when the target identity remains correct.
- Requires a breaking/new tool contract: existing unbound input must not remain
  silently available as if guarded. New tool names versus a package-version
  migration is a separate integration choice. Unsupported providers must not
  silently ignore the new target.
- Native delivery race remains; this draft is **not a complete fail-closed fix**.

## Compare with alternative B

B binds target and geometry to one owner-scoped short-lived screenshot token and
maps screenshot pixels itself. That removes caller transform errors and rejects
known geometry changes, but introduces bounded transient storage, expiration and
one-shot-consumption behavior. A is simpler; B provides a stronger observation-to-
action contract. Neither proves application acceptance or atomic OS isolation.

The prototype introduces no production abstraction. If selected for integration,
the architecture entry should say: “Foreground input binds each operation to an
explicit OS target identity and reports observed mismatch or uncertain dispatch
without activation, retry, or a new durable execution authority.”

## Shared acceptance gate before any production wiring

These prototypes model partial safety improvements, not complete misdelivery prevention.
They have no production effect until an independently validated native adapter is wired.

These prototypes do not close #484. They never call native APIs or access a real
app. No new permission, tool name, package version or durable state is registered.
There is no production import. Tests exercise contract logic with synthetic
identity and geometry, not native acceptance. Do not merge as a product fix.

A native implementation must obtain exact process start identity and CGWindow
identity from trusted OS observations, resolve the focused AX window without
ambiguous same-title matches, and recheck at the dispatch boundary. Model-supplied target fields are expected-target assertions, not authority.
The OS observation independently verifies them; names alone cannot establish identity.
Missing verified identity fails closed. A process-start identity detects PID reuse,
but same-process window-ID reuse is not detected here: no window-incarnation
generation is modeled, and native integration must address or disclose that limit.

Preflight rejection is useful but **not atomic recipient isolation**: another
application or user can change focus between checking and global event delivery.
Option A includes a test that deliberately demonstrates this residual race. A
later adapter cannot claim full wrong-recipient protection merely by passing
these tests. Direct-to-process posting, safe release after partial input,
application event acceptance, cursor hit testing, overlay occlusion and changing
window geometry all need native experiments. Unsupported targets must refuse,
not activate an arbitrary window, silently fall back globally or retry input.

The native fixture should own a test window, independently log input receipts,
expose a button/input/two scroll panes and switch focus to a second owned guard
window. Exercise app changes, sibling-window changes, process replacement,
geometry changes, Retina/secondary-display offsets, overlay visibility and
cancellation after down. The guard window must record no unintended input.
Success is bounded fixture evidence, not WeCom verification.

OCR remains out of scope. A future vision result must identify its screenshot,
coordinate space, confidence and source; it must never impersonate an AX action
reference. Sparse accessibility coverage is not an empty-screen assertion.

## Public references

- [Apple CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent)
  and [process-directed posting](<https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:)>):
  candidate API surfaces, not evidence of arbitrary-app reliability.
- [OpenAI computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use):
  action/observation loop and coordinate mapping, not private Codex internals.
- [Anthropic computer-use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool):
  explicit image and scroll-location contracts.
- [Playwright mouse](https://playwright.dev/docs/api/class-mouse):
  explicit coordinate units and dispatch versus completed scrolling.

## Identical synthetic scenario comparison

Both drafts use process 42, process-start identity `fixture`, window 7, desktop
bounds `(-1200,100,1000,800)`, a 500×400 screenshot and image point `(250,200)`.
A's caller computes global point `(-700,500)`; B computes it from its retained
capture. Native posting is a recording double in both drafts.

| Scenario                                           | A: explicit target                                                      | B: capture binding                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| Same target and geometry                           | Posts once at (-700,500); UI effect unverified                          | Same point and receipt                                |
| Focus switches to PID 99                           | Refuses before posting                                                  | Refuses before posting                                |
| Sibling window 8 gains focus                       | Refuses before posting                                                  | Refuses before posting                                |
| PID 42 is reused by a new process                  | Start-identity mismatch refuses                                         | Same refusal                                          |
| Window moves to x=-1100, old point still inside    | Posts old global point; cannot infer stale screenshot                   | Refuses changed bounds, requires recapture            |
| Another owner presents the same capture token      | No token exists; upstream Host authorization is the only owner boundary | Foreign token refused without consuming owner's token |
| 30 seconds elapse without identity/geometry change | No expiry contract; explicit call can proceed                           | Experimental token expires, recapture required        |
| Post throws after possible native delivery         | Unknown effect; one attempt, no retry                                   | Same, and token cannot be reused                      |
| OS changes focus after last check                  | Residual global-post race; not atomically protected                     | Same residual race despite capture binding            |

Neither draft bypasses existing Host consent, per-tool approval or shared-desktop
ownership. Prototype owner strings come from trusted fixtures; production owner identity
must come from authenticated invocation, never a model argument. Expected target
fields may be model arguments echoed from discovery, but are only assertions to
compare against independently observed OS facts, not permission or authority.

### Proposed model-facing calls and receipts (illustrative, not registered tools)

A:

```json
{
  "target": { "pid": 42, "processStartedAt": "fixture", "windowId": 7 },
  "action": {
    "kind": "click",
    "point": { "x": -700, "y": 500 },
    "button": "left"
  }
}
```

B first returns screenshot metadata with an opaque `captureId`, actual image
width/height and explicit coordinate-space label. The owner is Host-injected,
never a model argument. An action references that returned ID:

```json
{
  "captureId": "<returned opaque id>",
  "action": {
    "kind": "click",
    "imagePoint": { "x": 250, "y": 200 },
    "button": "left"
  }
}
```

Normal receipt in both runnable prototypes:

```json
{ "dispatch": "posted", "applicationEffect": "unverified" }
```

Refusal examples are explicit errors before posting: `target changed; no input
dispatched` (both), `window moved or resized; recapture before input` (B).
After a posting error both report `input may have dispatched; outcome unknown;
do not retry automatically`; no success or rollback is inferred. These are
prototype errors, not a new canonical Core result type.

### Migration choices requiring a decision

1. New guarded tool names can avoid silently inheriting legacy tool approvals,
   but require deciding when unbound old tools stop being advertised/executable.
2. A manifest-version replacement can preserve names but must fail old calls
   that omit required target/capture fields, update installed profiles atomically
   and reject incompatible backends rather than ignore arguments.
3. B additionally needs capture disposal on package retirement, owner expiration
   and observation replacement. Reuse the existing provider observation ownership
   where possible rather than add an independent durable registry.

These drafts deliberately do not choose a migration, modify an installed profile,
retain old unsafe tools under a new safety claim or implement native posting.

## Transform and cancellation limits

The synthetic mapping test is affine 2:1 scaling with a negative desktop origin,
not real mixed-DPI or display-migration acceptance. A native capture adapter must
verify coherent full-window pixels and bounds and either correctly account for
cropping, rotation and nonuniform display transforms or refuse those captures.
Cancellation before/while observing is covered; cancellation during native posting
is not modeled and cannot be described as rollback or safe release.

## Approval and UI focus integration gate

Read-only source tracing on main found these distinct paths:

- `src/main/index.ts` forwards approval request/resolution by IPC, and renderer
  `App.tsx` updates approval state. Those callbacks do not call native window
  `show`/`focus` or renderer `window.focus`.
- `ApprovalRequestCard` shows its detailed dialog only when the user opens it.
  Shared Dialog handles DOM focus within that explicitly opened surface.
- `ThreadView.respondToApproval` restores the Composer's DOM focus after the
  exact request succeeds, provided that request/thread still owns focus. That is
  a deliberate editor interaction contract, not proof of OS-level focus theft.
- Native main-window activation paths are startup `ready-to-show`, creating a
  window on app activation when none exists, and second-instance restore/focus.
  The foreground activity overlay separately uses non-activating `showInactive`.

A user clicking approval in ZenX can nevertheless leave ZenX as the foreground
application. The subsequent current global-input tool has no intended target to
revalidate. This is a credible integration hazard, **not a reproduced explanation
of the reported incident**. Neither DOM focus nor source tracing alone proves
which app actually received a native event in that task.

Production wiring must observe/revalidate the target **after approval and any UI
interaction**, not only when creating a request. A mismatch must not be repaired
by silently activating an app or repeatedly resubmitting input. A usable explicit
handoff/refocus/re-observation path must be designed with existing approval scope:
a once-approved call that fails on ZenX focus must not trap the user in a loop
where each new approval steals focus again. Persisted capability approvals may
avoid repeated dialogs, but are not target identity or permission to reactivate.
These drafts do not choose that UX, change Composer focus behavior, add an
approval state machine or claim that a target guard alone resolves this loop.

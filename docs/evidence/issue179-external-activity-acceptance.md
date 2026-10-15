# External connected activity acceptance

## Clean composition

The independent acceptance worktree merges reviewed activity head
`c59082b8edfd5cd8baea797924269096b99415ae` (R2) with main
`c1831e72671abfba59faf1e774079f78e07e78e1` using Git's normal three-way merge.
The conflict-free merge is `d9a33c51d45f25063be18549e689fe4ed3a46464`, tree
`3d4cec77cb351cd5e18ec1dff4f4d5709c8cea0b`.
Both parents and reviewed #431 baseline `4ba841dbf11538b0ee45b6a31f080fe716e905c7`
are ancestors. The acceptance additions do not change production activity logic.
The #431 screenshot worktree and existing unified visual fixture stay untouched.
A clean merge is source composition evidence, not combined runtime acceptance.

## Real CI-owned browser / Host segment

The existing Windows attached user-browser CI job runs `user-browser-smoke.ts`
against its existing owned Chromium fixture through normal provider selection
and `connectUserBrowserCdp`. The new `smokeConnectedActivity` call reuses that
provider. It opens one new CI fixture page through BrowserBackendRegistry under
that Registry's own mapped provider session, observes its qualified target through the real catalog-only BrowserLiveObservationIpcBridge,
and invokes inspection through the registry. It asserts started/completed with
matching Thread, operation, sequence, session epoch and target identity, and
that the catalog grants no frames. Cleanup explicitly closes that Host session
(detaches the agent-created page, without closing the actual Chrome tab). It does
not borrow the already-owned account tab from the caller's windows-smoke session.
The call runs after the caller's input tests so the new target cannot change their
listing/ownership assumptions. The caller compares actual Chrome active
target and Windows foreground HWND before/after. No new browser/CDP launch path,
profile replacement, or interaction with a user's current browser is added.

The sink passed to the bridge is instrumented. This proves the native provider
and Host projection up to the bridge output, not Electron IPC/preload delivery,
DOM selection, or a full native renderer end-to-end loop. The helper's unit test
uses a fake backend and is only a helper regression. Native execution remains
pending the normal CI job; local unit success is not native success.

## Production renderer segment

`browser-external-activity.test.ts` and `browser-activity-order.test.ts` use the
real registry, separate real catalog/frame bridges, and production AuxiliaryPanel
in JSDOM. The connected backend and Electron renderer transport are instrumented.
They cover exact target identity, frame ownership, auto-display, manual opt-out,
Follow, stale generations, late operations and shared Workspace/external order.
They do not prove native Chromium pixels, OS focus or Electron IPC delivery.

## Synthetic screenshot handoff

Use `apps/zenx/test/fixtures/browser-external-activity-visual.html` via the same
fixture server/capture method as #431, after #431 captures finish. This separate
entrypoint renders production AuxiliaryPanel and peer panels with real styles.
The API adapter, operation events and page content are explicitly synthetic;
it does not instantiate the Host registry or Electron IPC bridge. Keep the
visible SYNTHETIC RENDERER PREVIEW label in every capture.

Suggested states (both light/dark, wide and narrow where useful):

1. Start with Workspace selected; click “Start synthetic external activity”.
   Confirm the ordinary External reference tab becomes selected and shows activity.
2. Click “Finish synthetic external activity”; confirm activity settles.
3. Start external activity, manually select Workspace, start external again:
   selection stays with the user; click the production Follow control to resume.
4. Click “Fail synthetic external activity”; capture the production warning.
5. Close/collapse the panel and start activity: preserve opt-out; Follow restores.

These screenshots establish visual states only. They are not real connected-page
captures, native execution, or proof of the Host-to-renderer transport. The two
instrumented segments above must not be described together as full native E2E.

## R3 ownership correction

The first acceptance helper incorrectly tried to list the caller-owned account
from a new Host session. A real UserBrowserCdpBackend with an instrumented CDP
client reproduced the ownership exclusion. The retained real-provider regression
asserts this exclusion; the helper unit fixture now models per-session ownership,
requires a newly opened Host-owned target, rejects foreign inspection and checks
explicit detach while preserving the caller's target. Production provider guards
and R2 activity logic are unchanged. This smoke covers an agent-created external
fixture target, not reuse of a target owned by a different session.

# Issue 179: unified Browser acceptance

## Renderer fixture (synthetic, not native evidence)

`apps/zenx/test/fixtures/browser-unified-visual.html` imports the production
AuxiliaryPanel, WorkspaceBrowserPanel, BrowserThreadPanel and styles. Serve with
Vite from `apps/zenx`; open `/test/fixtures/browser-unified-visual.html`.
Parameters: `theme=light|dark`, `lang=en|zh-CN`, `size=narrow`, and
`state=working|idle|unknown|external`. The labelled placeholder is synthetic;
it cannot establish WebContents identity, login persistence or native mounting.
`window.previewPresent()` exercises a synthetic presentation notification;
`window.previewActivity(false)` clears activity while retaining the page.
Screenshots must retain the synthetic label. No screenshots have been captured
or native smoke executed as part of this local revision.

## Native CI acceptance

The existing CI `workspace-browser-smoke.js` invocation runs the extended real
Electron smoke. Its original creation, initial inspect and user mount still run
in their existing order. This added scenario is a **later presentation of an
existing page**, not proof of first-open ordering:

1. Navigate the already created shared native view to the local `/handoff`
   fixture; enter human control, activate the synthetic login and type a draft.
   Save the actual WebContents ID and Chromium session object.
2. Rebind only the Agent session incarnation. Register the renderer presentation
   context; do not create a tab, look up by URL, or navigate again.
3. Start inspect. The instrumented renderer-notification consumer asserts the
   exact Thread/tab and that capture count has not advanced. It calls the real
   Host mount with the request token and a changed native lease/geometry.
4. Assert the owner's attached child is the original WebContentsView. The mount
   acknowledges presentation; inspect can then capture and return `shown`.
5. Assert request → mount → inspect order, unchanged WebContents/session identity,
   local signed-in text and typed draft. Existing human-control rejection,
   explicit return, fresh observation and exactly-once confirmation checks follow.

The consumer is instrumented, not a full renderer/native end-to-end test.
Production renderer event/selection handling is tested separately. Failure output
includes the current phase and bounded `sharedTrace` with capture counts and
native owner/view state. Presentation milestones are `presentation-request`,
`presentation-mount-ack`, and `presentation-inspection-returned`; assertion errors
identify identity, order or state failures. CI timeout remains a failure, not an
acknowledgement. The existing layout phase checks native viewport equality through
unknown → clear and working states at 320/390/900px in English and Chinese.

## Scope

Automatic presentation is once per Workspace session incarnation and tab. Manual
switch/collapse suppresses following until explicit Follow; no Turn reset is
claimed. Connected external targets are exact-identity read-only peer tabs, retain
disconnected identities, and respect dismissal across unrelated plugin refreshes.
Automatic Host-operation presentation for connected external targets was left open
by the Workspace-only slice; the local follow-on below does not yet establish
native connected-browser acceptance.

## Subsequent integration and validation history

PR #431 initial head `a55956005d624c75e7bf34501aedc52f29ba3715` has the same
tree as local fixture head `ccf6993cb8e5b1ad568018f14a9dca827ce0fe71`.
CI run `38775748120`, native provider job `116562808722`, passed and explicitly
reported the presentation ACK/WebContents/profile/login/form and stable viewport
checks. This is Host/native-boundary evidence, not full renderer/native E2E.
That run was not all green: Windows packaged smoke failed with
`provider_error_inspect_element_com_h80131505`; ZenX checks failed the theme-source
policy because the new activity CSS contained raw fallback colors. The fallback
was removed in favor of the existing `--accent` token; theme-source-policy is now
part of the focused UI validation command. Neither original failure is erased.

The next integration retains #425's blank-page appearance/token/native-pixel
coverage and adds Host and renderer tests combining appearance changes with
presentation acknowledgement on the same mount lease. Current main's separately
reviewed changes are retained. Previously captured synthetic screenshots retain
their original commit labels and do not establish this new integrated revision.

Actual IPC ownership is tested with production AuxiliaryPanel/BrowserThreadPanel
and real BrowserLiveObservationIpcBridge instances: the catalog uses its own
read-only lane, and only the visible fixed peer owns the frame lane. Tests cover
multiple peers, snapshot refresh, stale callbacks/unsubscribe on A→B, window hide
and restore, final peer close, and exact visible frame-only external-open
authority. Hidden fixed peers do not replace a frame subscription with a
metadata-only subscription. Standalone BrowserThreadPanel behavior is unchanged.
Connected external automatic operation following remained open in that revision
under #179.

## Connected external activity follow-on (local implementation)

The independent catalog IPC lane fixes the catalog/frame subscription collision:
listing and Host activity continue while the selected exact target has its own
frame subscription. Catalog cannot request frames or authorize external opening.

Host operation begin/completion/failure events identify the existing Thread,
provider-session incarnation, Host call/canonical tool-call IDs and observer target;
the registry adds the current connection generation. No URL is an identity key.
Already-known targets are announced before backend dispatch. For a newly opened
page, there is no trustworthy target until the backend returns: presentation is
therefore after successful identity publication, not a pre-open or mount ACK.
External automatic presentation is a read-only ZenX peer-tab selection; it does
not activate Chrome/Edge, reopen a URL, change OS focus or switch the main Thread.
The underlying CDP ownership, revisions and unknown-outcome fences are unchanged.

The first operation per exact session-incarnation/target can reveal its tab in the
visible Thread. Manual switch/collapse suppresses following until explicit Follow.
Activity clearing leaves the page visible. Failed operations show a conservative
failure/uncertainty message, never a success indication or automatic retry.
Disconnect clears activity while preserving the unavailable old identity; retired
session/generation events cannot select a new same-URL target. Hidden/stale events
are not replayed when returning to the app.

Focused tests exercise real registry and IPC bridge objects with controlled
backend dependencies, plus production React components in JSDOM. These are not
native connected-browser E2E acceptance or screenshot evidence. Native connected
acceptance and any synthetic UI captures remain separate, owned by the designated
capture task. No such captures or native execution were performed for this slice.

### R1 ordering regressions

The original late-open and overlapping-failure repro assertions are retained in
`browser-activity-order.test.ts` and `browser-activity-failure-order.test.ts`.
Both failed before the fix. Presentation uses a Host-minted monotonic operation
sequence shared across Workspace and connected activity, rather than response
arrival time or URL. Tests resolve two opens in reverse order, cross the two
presentation channels, and verify that stale events cannot rewrite Follow.
An old inspection completing after a newer failed navigation retains the warning;
a successful inspection begun after that failure can clear the presentation
warning without changing the backend's action/unknown-outcome fences.

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
Automatic Host-operation presentation for connected external targets remains open.

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
Connected external automatic operation following remains open under #179.

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

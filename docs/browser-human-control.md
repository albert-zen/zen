# Shared Browser: explicit human control

Related to issue #179, which remains open for cross-Thread and profile policy.

## Scope and user flow

The current Thread's existing Browser tab stays on the same Electron
WebContents and shared persistent workspace profile. Choose **Take control**
to block subsequent Agent mutations of that page. Normal typing, URL-bar
navigation, back/forward/reload and human close remain available. Other pages
continue independently. Reading/inspection remains available; takeover is not
a privacy curtain or a website approval.

**Return to Agent** releases only this page's mutation barrier. The Agent must
inspect again and verify what actually changed. No message or tool is replayed,
no Turn is started, and return does not mean a login or confirmation succeeded.

Once a tab has entered handoff mode, all its Agent mutations consume a current
observation. `browser_navigate` and `browser_close` accept an optional
`observationId`, mandatory for such a tab. Old queued calls without a reference
or with a pre-takeover reference fail even if a queued inspect has since
finished. Other backends keep their existing contracts; the new argument is
additive. The first-party package is 1.0.5 so installed catalogs can receive
the schema/guidance update through the existing upgrade path.

## In-flight and interrupted operations

The Host fences control revisions immediately before native mutation dispatch,
including after asynchronous renderer/CDP preparation. Calls still preparing
reject without dispatch when their control revision changes. Already-sent work
cannot be cancelled by this button: the UI shows its unsettled count. If it
settles across a control change or fails after dispatch, its outcome is shown
as uncertain. Inspect the page before deciding what to do; never assume
rollback or repeat a possible submission automatically.

While any dispatched action remains unsettled, inspection cannot renew
mutation authority for a handed-off tab. After settlement, a fresh successful
inspection clears the transient unknown-outcome warning; it observes current
page state, not proof of server-side success. Repeated takeover/return is
idempotent. A fixed-size, keyboard-scrollable status region keeps status changes
from resizing the native viewport; actual resizing still expires observations.
Closing a page invalidates its handles; hiding, switching tabs or
switching Threads does not release human ownership. Session detachment leaves
the shared page and its barrier intact. Restart creates a new registry; this
feature neither restores tab authority nor replays old actions.

Profiles, cookies and permissions do not change. Existing same-profile tabs
can still affect shared login/server state, including logout. This is a
per-tab Agent API barrier, not a freeze of page scripts/network requests, an
OS input lock, cross-Thread assignment, multi-account isolation or durable
handoff ledger. Human input outside explicit takeover remains ordinary shared
input and does not silently change control.

## Practice comparison

- [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents):
  retain the actual page identity and distinguish completed/rejected async
  operations. We do not treat stopping a load or losing its reply as rollback
  of JavaScript or a remote form submission. The handoff protocol is Zen's
  own Host contract, not an Electron cancellation guarantee.
- [Playwright isolation](https://playwright.dev/docs/browser-contexts): page
  identity and storage context are distinct. Adopt explicit separation of
  page control and profile sharing; do not silently create a replacement
  context or copy a same-URL page and call it handoff.
- [Playwright authentication](https://playwright.dev/docs/auth): stored
  authentication can impersonate an account. Reject exporting credentials,
  cookies or authentication state into the model or repository. The acceptance
  fixture uses only local synthetic state, never a real account.

These official sources were checked on 2026-10-12. They inform the bounded
implementation, not permission to change the user's browser setup.

## Verification

The deterministic registry tests cover all mutation entry points, same-Thread
scoping, repeat/return, stale references, later queued-style inspection,
pre-dispatch takeover, dispatched unknown outcomes, initial navigation,
closed targets and session detachment. React DOM tests cover repeat clicks,
independent human navigation, late replies after tab/Thread/visibility changes,
retry and English/Chinese status.

The real Electron `smoke:workspace-browser` fixture adds synthetic sign-in,
human form input, Agent continuation on the exact WebContents, explicit human
confirmation, and return with no repeated submission. See the PR for the
exact tested commit, executed checks and environment limits. The fixture is
not certification of real websites, native Windows/macOS, credentials or
server-side transactions.

## Native navigation completion

The existing Host navigation generation also fences completion. A navigation
must observe its own main-frame commit and finish, or its same-document event,
in addition to Electron's loadURL promise. Electron 43 can resolve that promise
on a previous document's late finish event; such a reply alone is not success.
Redirected final URLs remain valid. A newer request, closed target or load that
stops before completion rejects and removes its temporary listeners. This is
per-request native completion tracking, not a queue or replay mechanism.

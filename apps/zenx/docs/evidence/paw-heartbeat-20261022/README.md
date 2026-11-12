# PAW heartbeat UI verification

Real RoomsPage rendered with production CSS and a synthetic in-memory Host SDK.
No user profile, credentials, real Thread or scheduler was read or modified.
Fixture: apps/zenx/test/fixtures/paw-heartbeat-preview.tsx.

Browser verified the existing-PAW management panel at a narrow 393px viewport:

- Hourly heartbeat can be added explicitly; helper text wraps without clipping.
- After adding, Add disappears and Manage heartbeat and Triggers remains.
- Message wakeups have a separate, explicit pause label.

Images capture the final production component and CSS for this change. The
fixture does not validate real Electron chrome or model execution. Backend tests
cover timer admission, exact Room routing, persistence and legacy preservation.

![Existing PAW: explicit add](existing-paw-add.png)
![Added heartbeat](heartbeat-added.png)

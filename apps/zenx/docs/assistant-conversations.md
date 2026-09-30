# Assistant conversations

Rooms can provide a one-to-one IM-style entry to an existing Thread. Choose
**Rooms → + Assistant**, select the existing conversation, and confirm
**Create & enable replies**. This creates one Room and one owned `roomMention`
Trigger in the existing automation store; it does not create a Thread or run a
model during setup. Both Rooms and Triggers must be enabled.

Every subsequent human message in that Room requests one reply without typing an
`@mention`. The original Thread's model, effort, workspace and permissions remain
unchanged. The setup and composer disclose that sending can consume model quota;
this is not a spending-cap implementation. Opening or reading the Room does not
start a Turn. Only the trusted UI can create or enable this mode; ordinary model
tool arguments cannot supply the UI authority marker.

An assistant Room has a fixed member and reply Trigger identity. Create a new
conversation to choose another Thread. Its managed Trigger can be paused/resumed
but not redirected or deleted independently. Deleting the Room removes its owned
Trigger and requires Triggers to be enabled. Ordinary multi-member Rooms retain
explicit mention behavior. Agent-authored posts do not implicitly wake an
assistant, even when their text contains its name.

## Pause and delivery

**Pause replies** stops future message-triggered admission. It does not cancel a
Turn already admitted, nor other independently configured triggers on the same
Thread. Messages sent while paused remain saved; enabling replies does not
replay them. Use the source conversation's ordinary interruption controls to
stop an active Turn.

Delivery reuses the existing immutable Room operation and one-attempt Trigger
path. A busy target currently reports a failed wakeup; there is no hidden retry
or assistant-specific queue. Inspect the saved message's delivery and the source
Thread before intentionally sending again. A response-loss/unknown result must
be reconciled with its existing operation rather than resubmitted as a new send.
A future busy-queue slice should reuse the canonical input queue and correlate
its exact resulting Turn before projecting a reply, not add a second queue.

One completed Trigger Turn projects its final answer to the Room with source
Thread/Turn identity. The setup prompt asks the model not to also post that same
final reply with a Room tool; arbitrary model behavior is not an exactly-once
content guarantee. Explicit Agent progress messages are still ordinary Room
messages.

## Background scope

Keep ZenX running in the background: closing its windows preserves the existing
Host; explicit Quit stops it. This feature adds no daemon, automatic recurring
model calls, cross-machine execution or mobile pairing. Existing authorized
Triggers can independently target the same Thread. The Cockpit experiment stays
separate and is not enabled by this feature.

## Credential-free validation

Existing `fake` model fixtures remain available. An optional loopback-only mock
Chat Completions server also exercises the real compatible-model parser:

```sh
node apps/zenx/scripts/mock-model-server.mjs
```

It prints a `http://127.0.0.1:43123/v1` endpoint (override with `ZENX_MOCK_PORT`).
Use model `zenx-mock` and an arbitrary dummy key such as `local-mock-only` in an
isolated OpenAI-compatible test profile. It never forwards a request upstream
and never requires a real credential. Do not expose it publicly.

- Ordinary text returns visibly labelled simulated streaming text
- `[mock:tool]` requests a fixed harmless shell command, then acknowledges its result
- `[mock:error]` returns a deliberate HTTP 400
- `[mock:slow]` streams slowly for interruption/cancellation tests

The marker in a Room wakeup is taken from the current Reason line, so older Room
history does not accidentally select a previous test scenario. These tests
validate transport and product behavior, not real-model reasoning quality.

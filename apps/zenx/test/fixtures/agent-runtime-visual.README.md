# Agent runtime component replay

This fixture renders the production `ThreadView` and its real disclosure, approval,
permission-menu, queue and dialog components. All provider responses are simulated;
it does not invoke tools, approve real capabilities, or send user messages.

From the repository root, after installing the workspace dependencies:

```sh
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5175
```

Open `/apps/zenx/test/fixtures/agent-runtime-visual.html` with these query options:

- `mode=runtime` (default), `scene=0..11`: concurrent work, native wait, approval,
  cancellation requested, cancellation unconfirmed, canonical stop with partial
  output, failure, completed answer, recovered history, wait with parallel work,
  action-set summaries with named unknown tools (10), and nested code/command calls (11).
  Scenes 10/11 deliberately read the same synthetic filename repeatedly: the
  summary counts operations and must never advertise multiple files. They use
  the production ThreadView and existing styles, not recreated UI markup.
- `mode=queue`, `scene=0..9`: two inputs, one input, long text and images, many
  inputs, delivery failure, idle continuation, approval coexistence, hidden-row failure,
  six real local test images, and an unavailable-image scene.
- `theme=light|dark`; `narrow&panelWidth=350` tests a narrow pane inside a wide window.
- `response=confirm|fail|fail-once` optionally supplies a simulated response 1.5 seconds
  after a component action. `fail-once` rejects the first request and confirms later
  retries so the real modal can stay open through its failure flow. Without it, use the visible confirmation/failure controls.

For an exact small component viewport, open
`agent-runtime-frame.html?mode=queue&scene=6&theme=light&width=390&height=600`.
It embeds the same fixture, not a replacement mockup.

## Canonical facts and interactions

- Queue additions, exact cancellations and delivery use `applyNativeThreadEvent`.
  An acknowledged cancellation callback alone does not remove a row.
- A wait call has `toolName: "wait"`, a native `running` task receipt, and outer
  exit code 0. There is no invented native `waiting` receipt status.
- A stop request acknowledgment does not manufacture a terminal event. The separate
  stop-fact control appends an actual `turn_aborted` canonical fact. A recovered
  `interrupted` turn without that fact is not presented as confirmed stopped.
- Approval success resolves the request only; the tool still needs its own result.
  The full-request dialog uses native request parameters and the actual scope.
- Image fixtures now contain six locally generated geometric PNGs, with exact native
  SHA-256/byte length/dimensions and real `onReadAttachment` bytes. These are clearly
  labeled test images, never user attachments. `imageRead=fail-once` simulates a single
  read failure per image for the actual retry action. Scene9 uses an intentionally
  unavailable reference, and the readable second row remains separate.
  The edit callback appends the actual native `user_message_queue_edited` revision
  only after the simulated confirmation. It preserves queue ID/client/order and does
  not cancel, requeue, or start work. `Add images` in this fixture supplies a labeled
  generated PNG rather than opening a user file picker. Queue reorder remains absent.
- The draft is real controlled Composer state. Disclosure, retry and cancellation
  should preserve it. Queue editor state is separate from this main draft.

## Suggested verification

1. Observe at least two uninterrupted 2.2-second text sweeps while running; update
   a running call label/count, then inspect native wait and terminal states.
2. Open full approval details, use keyboard dismissal, verify focus return and no
   decision. Submit once, confirm duplicate actions stay disabled, then reject or
   resolve the simulated response.
3. Expand long queue text, cancel the following image-only input, reject the request,
   retry and confirm the exact cancellation. Drain the last row and inspect the draft.
4. At 390×600, combine expanded queue, pending approval and a draft. Reject both an
   approval response and a queue cancellation; verify readable scope/cwd/errors,
   reachable 44-pixel decisions, queue scrolling and Composer controls.
5. Edit a queued text+image input, remove/add generated images, reject Save and
   retry. Confirm only a native edit fact updates the row in its original position.
   Cancel/close without saving leaves native input untouched.
6. Check ordinary terminal folding versus active text selection, stopped partial
   output versus unconfirmed external work, and explicit Review activity focus.

Automated regressions live in `agent-runtime-presentation.test.ts`,
`agent-runtime-interaction.test.ts`, `approval-request-refinement.test.ts`,
`activity-text.test.ts`, `queued-messages-refinement.test.ts`, `queued-image.test.ts`
and `queued-edit-interaction.test.ts`.
Browser recordings demonstrate rendered component/event behavior, not Electron,
provider end-to-end execution, physical-touch behavior or reduced-motion emulation.

Queue-image pressure checks accept `lang=en` for English labels and `longError`
for a deliberately long simulated editor failure. These are test inputs only.

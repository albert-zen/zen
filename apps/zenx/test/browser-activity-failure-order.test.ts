import assert from "node:assert/strict";
import test from "node:test";
import { BrowserThreadObservation } from "../src/main/capabilities/browser-thread-observation.js";
test("an older successful operation must not erase newer unknown outcome", () => {
  const observation = new BrowserThreadObservation({} as any);
  const session = observation.session("thread", "work");
  observation.publish(session, "browser_list_tabs", [
    {
      tabId: "one",
      sessionId: "work",
      title: "one",
      url: "https://example.test",
      loading: false,
    },
  ]);
  let target: any;
  observation.observe({ threadId: "thread", frames: false }, (event) => {
    if (event.type === "targets") target = event.targets[0];
  });
  const invocation = { arguments: { tabId: "one" }, callId: "call" } as any;
  const older = observation.operation(session, "browser_inspect", invocation);
  const newer = observation.operation(session, "browser_navigate", invocation);
  newer(true);
  assert.equal(target.activityFailed, true);
  older(false);
  assert.equal(target.activityCount, 0);
  assert.equal(
    target.activityFailed,
    true,
    "earlier inspection completion does not establish the later failed navigation outcome",
  );
  const fresh = observation.operation(session, "browser_inspect", invocation);
  fresh(false);
  assert.equal(
    target.activityFailed,
    false,
    "a successful inspection begun after the failure can clear its presentation warning",
  );
  observation.close();
});

import { BrowserInputUnsupportedError } from "../src/main/capabilities/browser-targeted-input.js";
import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { connectUserBrowserCdp } from "../src/main/capabilities/user-browser-provider.js";
import {
  createFakeCdpServer,
  deferred,
  waitUntil,
} from "./fixtures/user-browser-cdp.js";

async function fixture(targetedInput = true) {
  const cdp = await createFakeCdpServer({ targetedInput });
  const connection = await connectUserBrowserCdp(cdp.endpoint);
  const backend = connection.backend;
  await backend.listTabs("work");
  const observation = await backend.inspect("work", "target-1");
  return {
    cdp,
    backend,
    observation,
    async close() {
      await Promise.resolve(backend.close()).catch(() => undefined);
      await cdp.close();
    },
  };
}

for (const kind of ["click", "key"] as const) {
  test(`attached ${kind} dispatches exactly two targeted events without activation`, async () => {
    const f = await fixture();
    try {
      assert.deepEqual(
        f.observation.inputViewport,
        f.cdp.inputSnapshot.viewport,
      );
      assert.equal(f.observation.screenshot.status, "captured");
      assert.equal(f.observation.screenshot.width, 800);
      assert.equal(f.observation.focusedInputAvailable, true);
      if (kind === "click")
        await f.backend.pointerClick!(
          "work",
          "target-1",
          f.observation.observationId,
          41.5,
          28,
        );
      else
        await f.backend.keyPress!(
          "work",
          "target-1",
          f.observation.observationId,
          "Enter",
        );
      const commands = f.cdp
        .commandRequests()
        .filter((r) => r.method.startsWith("Input."));
      assert.equal(commands.length, 2);
      assert.deepEqual(
        commands.map((r) => r.params.type),
        kind === "click"
          ? ["mousePressed", "mouseReleased"]
          : ["keyDown", "keyUp"],
      );
      assert.ok(commands.every((r) => r.sessionId === f.cdp.latestSessionId()));
      assert.equal(commands[0]?.params.modifiers, undefined);
      if (kind === "click") assert.equal(commands[0]?.params.x, 41.5);
      else assert.equal(commands[0]?.params.windowsVirtualKeyCode, 13);
      assert.ok(!f.cdp.methods().some((m) => /activate|bringToFront/i.test(m)));
      await assert.rejects(
        f.backend.pointerClick!(
          "work",
          "target-1",
          f.observation.observationId,
          1,
          1,
        ),
        /stale or unknown/,
      );
      assert.equal(
        f.cdp.commandRequests().filter((r) => r.method.startsWith("Input."))
          .length,
        2,
      );
    } finally {
      await f.close();
    }
  });
}

test("fallback screenshot, foreign observations, invalid coordinates, and unsupported keys never dispatch", async () => {
  const fallback = await fixture(false);
  try {
    assert.equal(fallback.observation.inputViewport, undefined);
    await assert.rejects(
      fallback.backend.pointerClick!(
        "work",
        "target-1",
        fallback.observation.observationId,
        1,
        1,
      ),
      /real, coherent screenshot/,
    );
    assert.equal(fallback.cdp.count("Input.dispatchMouseEvent"), 0);
  } finally {
    await fallback.close();
  }
  const f = await fixture();
  try {
    for (const [x, y] of [
      [-1, 0],
      [800, 0],
      [0, 600],
      [NaN, 0],
      [Infinity, 0],
    ])
      await assert.rejects(
        f.backend.pointerClick!(
          "work",
          "target-1",
          f.observation.observationId,
          x!,
          y!,
        ),
        /finite CSS pixels/,
      );
    await assert.rejects(
      f.backend.keyPress!(
        "work",
        "target-1",
        f.observation.observationId,
        "F12" as never,
      ),
      /Unsupported browser key/,
    );
    await assert.rejects(
      f.backend.pointerClick!("work", "target-1", "foreign", 1, 1),
      /stale or unknown/,
    );
    await assert.rejects(
      f.backend.pointerClick!(
        "other",
        "target-1",
        f.observation.observationId,
        1,
        1,
      ),
      /Unknown user browser session/,
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 0);
    assert.equal(f.cdp.count("Input.dispatchKeyEvent"), 0);
  } finally {
    await f.close();
  }
});

for (const change of [
  "document",
  "viewport",
  "focus",
  "input",
  "layout",
] as const) {
  test(`attached input rejects a changed ${change} snapshot before any dispatch`, async () => {
    const f = await fixture();
    try {
      if (change === "document") f.cdp.inputSnapshot.documentKey += "/changed";
      if (change === "viewport") f.cdp.inputSnapshot.viewport.width++;
      if (change === "focus") f.cdp.inputSnapshot.focusId = "other-focus";
      if (change === "input") f.cdp.inputSnapshot.inputRevision++;
      if (change === "layout") f.cdp.inputSnapshot.layoutRevision++;
      await assert.rejects(
        f.backend.pointerClick!(
          "work",
          "target-1",
          f.observation.observationId,
          1,
          1,
        ),
        /page, viewport, focus or input changed/,
      );
      assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 0);
    } finally {
      await f.close();
    }
  });
}

test("screenshot viewport/input changes disable targeted input while preserving DOM inspection", async () => {
  const f = await fixture();
  try {
    f.cdp.interceptRequests((request) => {
      if (request.method === "Page.captureScreenshot")
        f.cdp.inputSnapshot.viewport.scrollY++;
    });
    const changed = await f.backend.inspect("work", "target-1");
    assert.match(changed.visibleText, /Signed in/);
    assert.equal(changed.inputViewport, undefined);
    await assert.rejects(
      f.backend.pointerClick!("work", "target-1", changed.observationId, 1, 1),
      /real, coherent screenshot/,
    );
  } finally {
    await f.close();
  }
});

test("key input requires the observed focused element", async () => {
  const f = await fixture();
  try {
    f.cdp.inputSnapshot.focusId = null;
    const observation = await f.backend.inspect("work", "target-1");
    assert.equal(observation.focusedInputAvailable, false);
    await assert.rejects(
      f.backend.keyPress!(
        "work",
        "target-1",
        observation.observationId,
        "Enter",
      ),
      /focused element/,
    );
    assert.equal(f.cdp.count("Input.dispatchKeyEvent"), 0);
  } finally {
    await f.close();
  }
});

for (const kind of ["click", "key"] as const) {
  for (const interruption of [
    "navigation",
    "abort",
    "detach",
    "disconnect",
  ] as const) {
    test(`attached ${kind} fences ${interruption} at every CDP await boundary`, async (t) => {
      // Derive the actual protocol path so newly added awaits join this matrix.
      const baseline = await fixture();
      let commands: ReturnType<typeof baseline.cdp.commandRequests>;
      try {
        const start = baseline.cdp.commandRequests().length;
        if (kind === "click")
          await baseline.backend.pointerClick!(
            "work",
            "target-1",
            baseline.observation.observationId,
            1,
            1,
          );
        else
          await baseline.backend.keyPress!(
            "work",
            "target-1",
            baseline.observation.observationId,
            "Enter",
          );
        commands = baseline.cdp.commandRequests().slice(start);
      } finally {
        await baseline.close();
      }
      for (const [boundary, command] of commands!.entries()) {
        if (command.method === "Target.getTargets") continue; // Summary follows known input completion.
        await t.test(
          `${boundary}: ${command.method} ${command.params.type ?? ""}`,
          async () => {
            const f = await fixture();
            const controller = new AbortController();
            let seen = 0;
            try {
              f.cdp.interceptRequests((request, emit) => {
                if (seen++ !== boundary) return;
                if (interruption === "abort")
                  controller.abort(new Error("cancel targeted input"));
                if (interruption === "navigation")
                  emit({
                    method: "Page.frameStartedNavigating",
                    sessionId: request.sessionId,
                    params: {
                      frameId: "main",
                      url: "https://example.test/next",
                    },
                  });
                if (interruption === "detach")
                  emit({
                    method: "Target.detachedFromTarget",
                    params: {
                      targetId: "target-1",
                      sessionId: request.sessionId,
                    },
                  });
                if (interruption === "disconnect") f.cdp.disconnect();
              });
              const action =
                kind === "click"
                  ? f.backend.pointerClick!(
                      "work",
                      "target-1",
                      f.observation.observationId,
                      1,
                      1,
                      controller.signal,
                    )
                  : f.backend.keyPress!(
                      "work",
                      "target-1",
                      f.observation.observationId,
                      "Enter",
                      controller.signal,
                    );
              await assert.rejects(action);
              f.cdp.interceptRequests(undefined);
              const actual = f.cdp
                .commandRequests()
                .filter((r) => r.method.startsWith("Input."));
              const possible = commands!
                .slice(0, boundary + 1)
                .filter((r) => r.method.startsWith("Input."));
              assert.deepEqual(
                actual.map((r) => r.params.type),
                possible.map((r) => r.params.type),
              );
              assert.ok(
                actual.every((r) => r.sessionId === f.cdp.latestSessionId()),
              );
              if (
                actual.length > 0 &&
                !(
                  actual.length === 2 &&
                  (interruption === "navigation" || interruption === "detach")
                )
              ) {
                await assert.rejects(
                  f.backend.inspect("work", "target-1"),
                  /taint|outcome is unknown|unavailable/,
                );
                await assert.rejects(
                  f.backend.pointerClick!(
                    "work",
                    "target-1",
                    f.observation.observationId,
                    1,
                    1,
                  ),
                );
                assert.equal(
                  f.cdp
                    .commandRequests()
                    .filter((r) => r.method.startsWith("Input.")).length,
                  actual.length,
                );
              }
            } finally {
              await f.close();
            }
          },
        );
      }
    });
  }
}

for (const kind of ["click", "key"] as const) {
  test(`human input between ${kind} down/up quarantines without releasing into changed state`, async () => {
    const f = await fixture();
    try {
      f.cdp.interceptRequests((request) => {
        if (
          request.params.type === "mousePressed" ||
          request.params.type === "keyDown" ||
          request.params.type === "rawKeyDown"
        )
          f.cdp.inputSnapshot.inputRevision++;
      });
      await assert.rejects(
        kind === "click"
          ? f.backend.pointerClick!(
              "work",
              "target-1",
              f.observation.observationId,
              1,
              1,
            )
          : f.backend.keyPress!(
              "work",
              "target-1",
              f.observation.observationId,
              "Enter",
            ),
        /outcome is unknown.*Do not retry/,
      );
      assert.equal(
        f.cdp.commandRequests().filter((r) => r.method.startsWith("Input."))
          .length,
        1,
      );
      await assert.rejects(
        f.backend.inspect("work", "target-1"),
        /tainted|outcome is unknown/,
      );
    } finally {
      await f.close();
    }
  });
}

test("unknown input retains late settlement before attachment cleanup", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const gate = deferred<void>();
  try {
    f.cdp.interceptRequests(async (request) => {
      if (request.params.type === "mousePressed") await gate.promise;
    });
    const action = f.backend.pointerClick!(
      "work",
      "target-1",
      f.observation.observationId,
      1,
      1,
      controller.signal,
    );
    await waitUntil(() => f.cdp.count("Input.dispatchMouseEvent") === 1);
    controller.abort();
    await assert.rejects(action, /outcome is unknown/);
    const closing = Promise.resolve(f.backend.closeSession("work"));
    void closing.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(f.cdp.count("Target.detachFromTarget"), 0);
    gate.resolve();
    await assert.rejects(closing, /outcome is unknown/);
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 1);
    await assert.rejects(
      f.backend.listTabs("work"),
      /tainted|outcome is unknown/,
    );
  } finally {
    gate.resolve();
    await f.close();
  }
});

for (const change of ["zoom", "invalid"] as const) {
  test(`optional ${change} input snapshot preserves DOM inspection`, async () => {
    const f = await fixture();
    try {
      if (change === "zoom") f.cdp.inputSnapshot.viewport.visualScale = 2;
      else f.cdp.inputSnapshot.documentKey = "invalid";
      const observed = await f.backend.inspect("work", "target-1");
      assert.match(observed.visibleText, /Signed in/);
      assert.equal(observed.targets.length, 1);
      assert.equal(observed.inputViewport, undefined);
      assert.equal(observed.focusedInputAvailable, undefined);
    } finally {
      await f.close();
    }
  });
}

test("known release acknowledgement followed by navigation permits fresh inspection", async () => {
  const f = await fixture();
  try {
    f.cdp.interceptRequests((request, emit) => {
      if (request.params.type === "mouseReleased")
        emit({
          method: "Page.frameStartedNavigating",
          sessionId: request.sessionId,
          params: { frameId: "main", url: "https://example.test/next" },
        });
    });
    await assert.rejects(
      f.backend.pointerClick!(
        "work",
        "target-1",
        f.observation.observationId,
        1,
        1,
      ),
      /outcome is unknown/,
    );
    f.cdp.interceptRequests(undefined);
    const observed = await f.backend.inspect("work", "target-1");
    await f.backend.pointerClick!(
      "work",
      "target-1",
      observed.observationId,
      2,
      2,
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 4);
  } finally {
    await f.close();
  }
});

test("keydown's own scroll and focus changes permit a same-document keyup", async () => {
  const f = await fixture();
  try {
    f.cdp.interceptRequests((request) => {
      if (
        request.params.type === "keyDown" ||
        request.params.type === "rawKeyDown"
      ) {
        f.cdp.inputSnapshot.viewport.scrollY = 200;
        f.cdp.inputSnapshot.layoutRevision++;
        f.cdp.inputSnapshot.focusId = "focused-2";
      }
    });
    await f.backend.keyPress!(
      "work",
      "target-1",
      f.observation.observationId,
      "ArrowDown",
    );
    assert.deepEqual(
      f.cdp.requests("Input.dispatchKeyEvent").map((r) => r.type),
      ["rawKeyDown", "keyUp"],
    );
  } finally {
    await f.close();
  }
});

for (const change of ["viewport", "hit-target"] as const) {
  test(`pointer ${change} changes after press stop the release and quarantine`, async () => {
    const f = await fixture();
    try {
      f.cdp.interceptRequests((request) => {
        if (request.params.type !== "mousePressed") return;
        if (change === "viewport") f.cdp.inputSnapshot.viewport.scrollY++;
        else f.cdp.inputSnapshot.pointerHitId = "replacement-canvas";
      });
      await assert.rejects(
        f.backend.pointerClick!(
          "work",
          "target-1",
          f.observation.observationId,
          1,
          1,
        ),
        /outcome is unknown/,
      );
      assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 1);
      await assert.rejects(
        f.backend.inspect("work", "target-1"),
        /tainted|outcome is unknown/,
      );
    } finally {
      await f.close();
    }
  });
}

test("pointer press changing unrelated DOM content permits a stable same-node release", async () => {
  const f = await fixture();
  try {
    f.cdp.interceptRequests((request) => {
      if (request.params.type === "mousePressed")
        f.cdp.inputSnapshot.layoutRevision++;
    });
    await f.backend.pointerClick!(
      "work",
      "target-1",
      f.observation.observationId,
      1,
      1,
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 2);
  } finally {
    await f.close();
  }
});

test("a rejected pointer surface probe sends no input", async () => {
  const f = await fixture();
  try {
    f.cdp.interceptRequests((request, emit) => {
      if (
        request.method === "Runtime.evaluate" &&
        String(request.params.expression).includes("elementFromPoint")
      )
        emit({
          id: request.id,
          result: { exceptionDetails: { text: "native surface rejected" } },
        });
    });
    await assert.rejects(
      f.backend.pointerClick!(
        "work",
        "target-1",
        f.observation.observationId,
        1,
        1,
      ),
      /snapshot failed/,
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 0);
    f.cdp.interceptRequests(undefined);
    const observation = await f.backend.inspect("work", "target-1");
    assert.ok(observation.inputViewport);
  } finally {
    await f.close();
  }
});

test("known failure before the first socket send never quarantines undispatched input", async (t) => {
  const f = await fixture();
  const send = WebSocket.prototype.send;
  try {
    t.mock.method(
      WebSocket.prototype,
      "send",
      function (this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
        if (String(args[0]).includes('"method":"Input.dispatchMouseEvent"'))
          throw new Error("known pre-dispatch input refusal");
        return send.apply(this, args);
      },
    );
    await assert.rejects(
      f.backend.pointerClick!(
        "work",
        "target-1",
        f.observation.observationId,
        1,
        1,
      ),
      (error) => {
        assert.match(String(error), /known pre-dispatch input refusal/);
        assert.doesNotMatch(String(error), /outcome is unknown/);
        return true;
      },
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 0);
    t.mock.restoreAll();
    const observed = await f.backend.inspect("work", "target-1");
    await f.backend.pointerClick!(
      "work",
      "target-1",
      observed.observationId,
      1,
      1,
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 2);
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test("a queued replacement inspection invalidates the observation before input dispatch", async () => {
  const f = await fixture();
  const started = deferred<void>();
  const gate = deferred<void>();
  try {
    f.cdp.interceptRequests(async (request) => {
      if (
        request.method === "Runtime.evaluate" &&
        String(request.params.expression).includes("elementFromPoint")
      ) {
        started.resolve();
        await gate.promise;
      }
    });
    const action = f.backend.pointerClick!(
      "work",
      "target-1",
      f.observation.observationId,
      1,
      1,
    );
    const rejected = assert.rejects(action, /document changed/);
    await started.promise;
    const inspecting = f.backend.inspect("work", "target-1");
    f.cdp.interceptRequests(undefined);
    gate.resolve();
    await rejected;
    const observation = await inspecting;
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 0);
    await f.backend.pointerClick!(
      "work",
      "target-1",
      observation.observationId,
      1,
      1,
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 2);
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("concurrent actions cannot consume one observation twice", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      f.backend.pointerClick!(
        "work",
        "target-1",
        f.observation.observationId,
        1,
        1,
      ),
      f.backend.pointerClick!(
        "work",
        "target-1",
        f.observation.observationId,
        1,
        1,
      ),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected"],
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 2);
  } finally {
    await f.close();
  }
});

for (const reason of ["native-surface", "shadow-surface"] as const) {
  test(`attached known ${reason} result preserves its public classification with zero Input`, async () => {
    const f = await fixture();
    try {
      f.cdp.interceptRequests((request, emit) => {
        if (
          request.method === "Runtime.evaluate" &&
          String(request.params.expression).includes("const hit = resolveHit")
        )
          emit({
            id: request.id,
            result: { result: { value: { browserInputUnsupported: reason } } },
          });
      });
      await assert.rejects(
        f.backend.pointerClick!(
          "work",
          "target-1",
          f.observation.observationId,
          1,
          1,
        ),
        (error) =>
          error instanceof BrowserInputUnsupportedError &&
          error.code === "BROWSER_INPUT_UNSUPPORTED" &&
          error.reason === reason,
      );
      assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 0);
    } finally {
      await f.close();
    }
  });
}

test("an unknown renderer exception cannot masquerade as a successful native-surface refusal", async () => {
  const f = await fixture();
  try {
    f.cdp.interceptRequests((request, emit) => {
      if (
        request.method === "Runtime.evaluate" &&
        String(request.params.expression).includes("const hit = resolveHit")
      )
        emit({
          id: request.id,
          result: {
            exceptionDetails: {
              text: "Uncaught",
              exception: {
                description: "BROWSER_INPUT_UNSUPPORTED:native-surface",
              },
            },
          },
        });
    });
    await assert.rejects(
      f.backend.pointerClick!(
        "work",
        "target-1",
        f.observation.observationId,
        1,
        1,
      ),
      (error) =>
        !(error instanceof BrowserInputUnsupportedError) &&
        /snapshot failed/.test(String(error)),
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 0);
  } finally {
    await f.close();
  }
});

test("attached actual closed-root metadata disables focus and rejects pointer with zero Input", async () => {
  const f = await fixture();
  try {
    f.cdp.interceptRequests((request, emit) => {
      if (request.method === "DOM.describeNode")
        emit({
          id: request.id,
          result: {
            node: {
              nodeType: 1,
              backendNodeId:
                request.params.backendNodeId ??
                (String(request.params.objectId).includes("hitNode")
                  ? 102
                  : 101),
              localName: "div",
              attributes: [],
              shadowRoots: [{ shadowRootType: "closed" }],
            },
          },
        });
    });
    const observation = await f.backend.inspect("work", "target-1");
    assert.equal(observation.focusedInputAvailable, false);
    assert.ok(observation.inputViewport);
    await assert.rejects(
      f.backend.keyPress!(
        "work",
        "target-1",
        observation.observationId,
        "Space",
      ),
      (error) =>
        error instanceof BrowserInputUnsupportedError &&
        error.reason === "shadow-surface",
    );
    await assert.rejects(
      f.backend.pointerClick!(
        "work",
        "target-1",
        observation.observationId,
        1,
        1,
      ),
      (error) =>
        error instanceof BrowserInputUnsupportedError &&
        error.reason === "shadow-surface",
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 0);
    assert.equal(f.cdp.count("Input.dispatchKeyEvent"), 0);
  } finally {
    await f.close();
  }
});

test("unknown surface metadata leaves DOM inspection available without claiming a native refusal", async () => {
  const f = await fixture();
  try {
    f.cdp.interceptRequests((request, emit) => {
      if (request.method === "DOM.describeNode")
        emit({ id: request.id, result: { node: {} } });
    });
    const observation = await f.backend.inspect("work", "target-1");
    assert.match(observation.visibleText, /Signed in/);
    assert.equal(observation.inputViewport, undefined);
    await assert.rejects(
      f.backend.pointerClick!(
        "work",
        "target-1",
        observation.observationId,
        1,
        1,
      ),
      (error) =>
        !(error instanceof BrowserInputUnsupportedError) &&
        /coherent screenshot/.test(String(error)),
    );
    assert.equal(f.cdp.count("Input.dispatchMouseEvent"), 0);
  } finally {
    await f.close();
  }
});

for (const operation of [
  "click",
  "initial-inspect",
  "after-screenshot",
] as const) {
  test(`cancelled ${operation} releases its owned object in the original live session`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    const start = f.cdp.commandRequests().length;
    let cancelled = false;
    let captured = false;
    try {
      f.cdp.interceptRequests((request) => {
        if (request.method === "Page.captureScreenshot") captured = true;
        if (
          request.method === "DOM.describeNode" &&
          !cancelled &&
          (operation !== "after-screenshot" || captured)
        ) {
          cancelled = true;
          controller.abort(new Error("cancel after owned object"));
        }
      });
      await assert.rejects(
        operation === "click"
          ? f.backend.pointerClick!(
              "work",
              "target-1",
              f.observation.observationId,
              1,
              1,
              controller.signal,
            )
          : f.backend.inspect("work", "target-1", controller.signal),
      );
      // The public abort can settle before finally finishes its bounded cleanup.
      await waitUntil(
        () =>
          f.cdp
            .commandRequests()
            .slice(start)
            .filter((r) => r.method === "Runtime.releaseObject").length ===
          (operation === "after-screenshot" ? 2 : 1),
      );
      const requests = f.cdp.commandRequests().slice(start);
      const allocations = requests.filter(
        (r) =>
          r.method === "Runtime.evaluate" && r.params.returnByValue === false,
      );
      const releases = requests.filter(
        (r) => r.method === "Runtime.releaseObject",
      );
      assert.equal(allocations.length, releases.length);
      assert.ok(
        releases.every((r) => r.sessionId === allocations[0]?.sessionId),
      );
      assert.ok(
        releases.every((r) => r.params.objectId === `${r.sessionId}:focusNode`),
      );
      assert.equal(
        requests.filter((r) => r.method.startsWith("Input.")).length,
        0,
      );
      f.cdp.interceptRequests(undefined);
      const fresh = await f.backend.inspect("work", "target-1");
      assert.ok(fresh.inputViewport);
    } finally {
      await f.close();
    }
  });
}

for (const interruption of ["navigation", "detach", "disconnect"] as const) {
  test(`owned object cleanup never follows ${interruption} to a successor`, async () => {
    const f = await fixture();
    const ownedId = "owned-before-lifecycle-change";
    let interrupted = false;
    let successor:
      Awaited<ReturnType<typeof connectUserBrowserCdp>> | undefined;
    const start = f.cdp.commandRequests().length;
    try {
      f.cdp.interceptRequests((request, emit) => {
        if (
          request.method === "Runtime.evaluate" &&
          request.params.returnByValue === false &&
          !interrupted
        )
          emit({
            id: request.id,
            result: { result: { subtype: "node", objectId: ownedId } },
          });
        if (request.method !== "DOM.describeNode" || interrupted) return;
        interrupted = true;
        if (interruption === "navigation") f.cdp.emitMainDocumentChange();
        if (interruption === "detach") f.cdp.detachSession();
        if (interruption === "disconnect") f.cdp.disconnect();
      });
      await assert.rejects(
        f.backend.pointerClick!(
          "work",
          "target-1",
          f.observation.observationId,
          1,
          1,
        ),
      );
      const beforeSuccessor = f.cdp.commandRequests().slice(start);
      assert.ok(
        beforeSuccessor.some(
          (r) =>
            r.method === "DOM.describeNode" && r.params.objectId === ownedId,
        ),
      );
      assert.equal(
        beforeSuccessor.filter(
          (r) =>
            r.method === "Runtime.releaseObject" ||
            r.method === "Target.attachToTarget",
        ).length,
        0,
      );
      f.cdp.interceptRequests(undefined);
      if (interruption === "disconnect") {
        successor = await connectUserBrowserCdp(f.cdp.endpoint);
        await successor.backend.listTabs("successor");
        assert.ok(
          (await successor.backend.inspect("successor", "target-1"))
            .inputViewport,
        );
      } else
        assert.ok((await f.backend.inspect("work", "target-1")).inputViewport);
      const requests = f.cdp.commandRequests().slice(start);
      assert.equal(
        requests.filter(
          (r) =>
            r.method === "Runtime.releaseObject" &&
            r.params.objectId === ownedId,
        ).length,
        0,
      );
      assert.equal(
        requests.filter((r) => r.method.startsWith("Input.")).length,
        0,
      );
    } finally {
      await Promise.resolve(successor?.backend.close()).catch(() => undefined);
      await f.close();
    }
  });
}

for (const phase of [
  "initial",
  "after-screenshot",
  "after-screenshot-layout-change",
] as const) {
  test(`optional input evidence failure at ${phase} preserves DOM inspection`, async () => {
    const f = await fixture();
    let describes = 0;
    let captures = 0;
    try {
      f.cdp.interceptRequests((request, emit) => {
        if (request.method === "Page.captureScreenshot") captures++;
        if (request.method !== "DOM.describeNode") return;
        describes++;
        if (phase === "after-screenshot-layout-change") {
          if (captures > 0 && describes === 3)
            f.cdp.inputSnapshot.layoutRevision++;
        } else if (phase === "initial" || captures > 0)
          emit({ id: request.id, result: { node: {} } });
      });
      const observation = await f.backend.inspect("work", "target-1");
      assert.match(observation.visibleText, /Signed in/);
      assert.ok(observation.targets.length);
      assert.equal(observation.screenshot.status, "captured");
      assert.equal(observation.inputViewport, undefined);
      assert.equal(observation.focusedInputAvailable, undefined);
      await assert.rejects(
        f.backend.pointerClick!(
          "work",
          "target-1",
          observation.observationId,
          1,
          1,
        ),
        /coherent screenshot/,
      );
      assert.equal(
        f.cdp.commandRequests().filter((r) => r.method.startsWith("Input."))
          .length,
        0,
      );
      f.cdp.interceptRequests(undefined);
      assert.ok((await f.backend.inspect("work", "target-1")).inputViewport);
    } finally {
      await f.close();
    }
  });
}

for (const interruption of [
  "navigation",
  "detach",
  "disconnect",
  "abort",
  "runtime-exception",
] as const) {
  test(`optional post-screenshot evidence never hides ${interruption}`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    let captured = false;
    let interrupted = false;
    try {
      f.cdp.interceptRequests((request, emit) => {
        if (request.method === "Page.captureScreenshot") captured = true;
        if (!captured || interrupted) return;
        if (interruption === "runtime-exception") {
          if (
            request.method !== "Runtime.evaluate" ||
            !String(request.params.expression).includes(
              "zenx-browser-targeted-input-v2",
            )
          )
            return;
          interrupted = true;
          emit({
            id: request.id,
            result: {
              exceptionDetails: {
                text: "BROWSER_INPUT_UNSUPPORTED:native-surface",
              },
            },
          });
          return;
        }
        if (request.method !== "DOM.describeNode") return;
        interrupted = true;
        emit({ id: request.id, result: { node: {} } });
        if (interruption === "navigation") f.cdp.emitMainDocumentChange();
        if (interruption === "detach") f.cdp.detachSession();
        if (interruption === "disconnect") f.cdp.disconnect();
        if (interruption === "abort")
          controller.abort(new Error("cancel optional evidence"));
      });
      await assert.rejects(
        f.backend.inspect("work", "target-1", controller.signal),
        (error) => !(error instanceof BrowserInputUnsupportedError),
      );
      assert.equal(interrupted, true);
      assert.equal(
        f.cdp.commandRequests().filter((r) => r.method.startsWith("Input."))
          .length,
        0,
      );
    } finally {
      await f.close();
    }
  });
}

test("unknown owned-object release is bounded and never retried", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const release = deferred<void>();
  const ownedId = "owned-before-cancelled-release";
  let cancelled = false;
  try {
    f.cdp.interceptRequests(async (request, emit) => {
      if (
        request.method === "Runtime.evaluate" &&
        request.params.returnByValue === false &&
        !cancelled
      )
        emit({
          id: request.id,
          result: { result: { subtype: "node", objectId: ownedId } },
        });
      if (request.method === "DOM.describeNode" && !cancelled) {
        cancelled = true;
        controller.abort(new Error("cancel before cleanup"));
      }
      if (
        request.method === "Runtime.releaseObject" &&
        request.params.objectId === ownedId
      )
        await release.promise;
    });
    await assert.rejects(
      f.backend.pointerClick!(
        "work",
        "target-1",
        f.observation.observationId,
        1,
        1,
        controller.signal,
      ),
    );
    await waitUntil(() =>
      f.cdp
        .commandRequests()
        .some(
          (r) =>
            r.method === "Runtime.releaseObject" &&
            r.params.objectId === ownedId,
        ),
    );
    // This queues behind the cancelled operation: it must finish even though
    // the original cleanup response remains withheld, without reattaching.
    const attaches = f.cdp.count("Target.attachToTarget");
    const fresh = await f.backend.inspect(
      "work",
      "target-1",
      AbortSignal.timeout(1_500),
    );
    assert.ok(fresh.inputViewport);
    assert.equal(f.cdp.count("Target.attachToTarget"), attaches);
    assert.equal(
      f.cdp
        .commandRequests()
        .filter(
          (r) =>
            r.method === "Runtime.releaseObject" &&
            r.params.objectId === ownedId,
        ).length,
      1,
    );
    assert.equal(
      f.cdp.commandRequests().filter((r) => r.method.startsWith("Input."))
        .length,
      0,
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

for (const throws of [false, true]) {
  test(`input capture diagnostics are bounded, redacted and observational (callback throws=${throws})`, async () => {
    const cdp = await createFakeCdpServer({ targetedInput: true });
    const diagnostics: unknown[] = [];
    const connection = await connectUserBrowserCdp(cdp.endpoint, undefined, {
      onInputCaptureDiagnostic: (value) => {
        diagnostics.push(value);
        if (throws) throw new Error("diagnostic callback failure");
      },
    });
    try {
      await connection.backend.listTabs("diagnostics");
      const valid = await connection.backend.inspect("diagnostics", "target-1");
      assert.ok(valid.inputViewport);
      assert.deepEqual(
        diagnostics,
        [],
        "coherent capture must not emit failure diagnostics",
      );
      Object.assign(cdp.inputSnapshot, { privatePageText: "SECRET_PAGE_TEXT" });
      cdp.interceptRequests((request) => {
        if (request.method === "Page.captureScreenshot")
          cdp.inputSnapshot.layoutRevision++;
      });
      const changed = await connection.backend.inspect(
        "diagnostics",
        "target-1",
      );
      assert.ok(changed.targets.length);
      assert.equal(changed.inputViewport, undefined);
      assert.deepEqual(diagnostics, [
        {
          reason: "snapshot-changed",
          captureStatus: "captured",
          before: {
            available: true,
            inputRevision: 0,
            layoutRevision: 0,
            viewport: cdp.inputSnapshot.viewport,
          },
          after: {
            available: true,
            inputRevision: 0,
            layoutRevision: 1,
            viewport: cdp.inputSnapshot.viewport,
          },
          documentChanged: false,
          focusChanged: false,
        },
      ]);
      const text = JSON.stringify(diagnostics);
      for (const privateValue of [
        "SECRET_PAGE_TEXT",
        cdp.inputSnapshot.documentKey,
        cdp.inputSnapshot.focusId!,
      ])
        assert.ok(!text.includes(privateValue));
      assert.ok(text.length < 1000);
      assert.equal(
        cdp.commandRequests().filter((r) => r.method.startsWith("Input."))
          .length,
        0,
      );
    } finally {
      await Promise.resolve(connection.backend.close()).catch(() => undefined);
      await cdp.close();
    }
  });
}

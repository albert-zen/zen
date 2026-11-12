// Acceptance-app diagnostics only; never part of the production Host bundle.
const statuses = [
  "queued",
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "cancel_requested",
  "cancellation_unconfirmed",
];
const errorNames = [
  "Error",
  "AbortError",
  "TimeoutError",
  "TypeError",
  "RangeError",
  "AssertionError",
  "AggregateError",
];
const signals = [
  "SIGINT",
  "SIGTERM",
  "SIGKILL",
  "SIGHUP",
  "SIGABRT",
  "SIGPIPE",
];
const member = (value, allowed) => (allowed.includes(value) ? value : null);
const exitCode = (value) => (Number.isSafeInteger(value) ? value : null);
const errorName = (error) => member(error?.name, errorNames) ?? "other";

export async function observeLaunchHostShell({
  execute,
  signal,
  marker,
  record,
  emitter = process,
  now = () => performance.now(),
}) {
  const started = now();
  let lastTime = started;
  const events = [];
  let droppedEvents = 0;
  const diagnosticErrors = [];
  const removers = [];
  function elapsed() {
    const time = now();
    if (!Number.isFinite(time) || !Number.isFinite(started) || time < lastTime)
      throw new Error("Invalid Host shell observation clock");
    lastTime = time;
    return Math.round((time - started) * 1000) / 1000;
  }
  function add(event) {
    const entry = { event, elapsedMs: elapsed() };
    if (events.length === 16) {
      events.splice(8, 1);
      droppedEvents += 1;
    }
    events.push(entry);
  }
  function passive(action) {
    return (...args) => {
      try {
        action(...args);
      } catch {
        // Never throw into product IPC/signal handlers. Fail this gate after
        // execute settles, without retaining arbitrary payload/error text.
        if (diagnosticErrors.length === 0)
          diagnosticErrors.push(new Error("Host shell observation failed"));
      }
    };
  }
  function listen(event, handler, once = false) {
    const listener = passive(handler);
    emitter[once ? "once" : "on"](event, listener);
    removers.push(() => emitter.removeListener(event, listener));
  }
  function abortState() {
    return {
      aborted: signal.aborted,
      reasonName: signal.aborted ? errorName(signal.reason) : null,
    };
  }
  let result;
  let executionError;
  let executionFailed = false;
  let observation;
  try {
    listen("message", (message) => {
      if (message?.type === "shutdown") add("shutdown-message");
    });
    listen("disconnect", () => add("disconnect"), true);
    const observedSignals = signals
      .slice(0, 2)
      .filter((name) => emitter.listenerCount(name) > 0);
    // Product Host uses once handlers. Do not suppress default signal handling
    // when none exists, or leave an observer after the product's first signal.
    for (const name of observedSignals) listen(name, () => add(name), true);
    const onAbort = passive(() => add("outer-abort"));
    signal.addEventListener("abort", onAbort, { once: true });
    removers.push(() => signal.removeEventListener("abort", onAbort));
    add("shell-start");
    record("start", {
      elapsedMs: events[0].elapsedMs,
      outerSignal: abortState(),
      observedSignals,
    });
    try {
      result = await execute();
    } catch (error) {
      executionFailed = true;
      executionError = error;
    }
    add(executionFailed ? "shell-throw" : "shell-result");
    const facts = result?.structuredContent;
    observation = {
      elapsedMs: events.at(-1).elapsedMs,
      outcome: executionFailed ? "threw" : "returned",
      errorName: executionFailed ? errorName(executionError) : null,
      outerSignal: abortState(),
      result: executionFailed
        ? null
        : {
            exitCode: exitCode(result?.exitCode),
            outputBytes:
              typeof result?.output === "string"
                ? Buffer.byteLength(result.output, "utf8")
                : null,
            markerMatched:
              typeof result?.output === "string" &&
              result.output.trim() === marker,
            status: member(facts?.status, statuses),
            exit_code: exitCode(facts?.exit_code),
            cancellation: member(facts?.cancellation, [
              "confirmable",
              "best_effort",
            ]),
            foreground: member(facts?.foreground, ["running", "exited"]),
            stdio: member(facts?.stdio, ["open", "eof"]),
            foreground_exit_code: exitCode(facts?.foreground_exit_code),
            foreground_signal: member(facts?.foreground_signal, signals),
          },
      events,
      droppedEvents,
      diagnosticErrorCount: diagnosticErrors.length,
    };
  } catch (error) {
    diagnosticErrors.push(error);
  } finally {
    for (const remove of removers) remove();
  }
  if (observation) {
    try {
      record("result", observation);
    } catch (error) {
      diagnosticErrors.push(error);
    }
  }
  if (diagnosticErrors.length > 0) {
    throw new AggregateError(
      [...(executionFailed ? [executionError] : []), ...diagnosticErrors],
      "Host shell observation failed",
    );
  }
  if (executionFailed) throw executionError;
  return result;
}

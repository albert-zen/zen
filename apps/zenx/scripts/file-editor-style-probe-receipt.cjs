/** Fixture-only: diagnostic failures never replace the original native failure. */
async function fileEditorAfterFailureProbe({
  persistOriginal,
  captureOriginal,
  runProbe,
  persistProbe,
  deadlineMs = 1500,
}) {
  const receipt = {
    scope:
      "after-failure style probe only; original native assertion remains failed",
    diagnosticStatus: "running",
    phase: "persist-original",
    originalReceiptPersisted: false,
    originalScreenshotPersisted: false,
    probeAttempted: false,
    probeMayStillBeRunning: false,
  };
  let deadline;
  try {
    await persistOriginal();
    receipt.originalReceiptPersisted = true;
    receipt.phase = "capture-original";
    await captureOriginal();
    receipt.originalScreenshotPersisted = true;
    receipt.phase = "run-probe";
    receipt.probeAttempted = true;
    const result = await Promise.race([
      Promise.resolve().then(runProbe),
      new Promise((_, reject) => {
        deadline = setTimeout(() => {
          receipt.probeMayStillBeRunning = true;
          reject(
            new Error(
              `After-failure probe exceeded its ${deadlineMs} ms diagnostic deadline; renderer completion is uncertain`,
            ),
          );
        }, deadlineMs);
      }),
    ]);
    clearTimeout(deadline);
    receipt.phase = "persist-probe";
    await persistProbe(result);
    receipt.phase = "complete";
    receipt.diagnosticStatus = "complete";
  } catch (error) {
    receipt.diagnosticStatus = "failed";
    receipt.failure = String(error.stack || error);
  } finally {
    clearTimeout(deadline);
  }
  return receipt;
}
module.exports = { fileEditorAfterFailureProbe };

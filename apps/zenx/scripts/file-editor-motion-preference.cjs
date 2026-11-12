const assert = require("node:assert/strict");

/** Owned synthetic renderer only. Never changes an OS preference or editor state. */
async function prepareFileEditorMotion(
  webContents,
  preference,
  saveReceipt,
  deadlineMs = 5000,
) {
  if (preference === undefined) return;
  assert.ok(["reduce", "no-preference"].includes(preference));
  const receipt = {
    requested: preference,
    status: "running",
    phase: "bootstrap-document",
  };
  let settled = false,
    timer,
    originalError;
  const phase = async (name) => {
    if (settled) throw new Error("Motion setup already settled");
    receipt.phase = name;
    await saveReceipt({ ...receipt });
    if (settled) throw new Error("Motion setup already settled");
  };
  try {
    await Promise.race([
      (async () => {
        await phase("bootstrap-document");
        // Electron documents that sendCommand before first navigation can await
        // navigation. Bootstrap an inert target before awaiting renderer commands.
        await webContents.loadURL("about:blank");
        await phase("attach-debugger");
        webContents.debugger.attach("1.3");
        await phase("emulate-media");
        await webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: preference }],
        });
        await phase("verify-media");
        receipt.reducedMotion = await webContents.executeJavaScript(
          "matchMedia('(prefers-reduced-motion: reduce)').matches",
        );
        assert.equal(
          receipt.reducedMotion,
          preference === "reduce",
          "Bootstrap renderer uses the requested media preference",
        );
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Motion setup exceeded ${deadlineMs} ms at ${receipt.phase}`,
              ),
            ),
          deadlineMs,
        );
      }),
    ]);
    receipt.status = "ready";
    receipt.phase = "ready";
  } catch (error) {
    originalError = error;
    receipt.status = "failed";
    receipt.failure = String(error.stack || error);
  } finally {
    settled = true;
    clearTimeout(timer);
    // Local metadata is independent of the renderer, including a missing target.
    // Preserve the original setup failure if persisting its receipt also fails.
    try {
      await saveReceipt({ ...receipt });
    } catch (error) {
      originalError ||= error;
    }
  }
  if (originalError) throw originalError;
  return receipt;
}
module.exports = { prepareFileEditorMotion };

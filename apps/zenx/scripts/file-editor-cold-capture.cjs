/** Read-only follow-up, never a replacement for the original capture or verdict. */
exports.observeColdCapture = async (read, waitTwoFrames, captureSecond) => {
  const receipt = {
    status: "running",
    scope:
      "Read-only DOM geometry can flush layout; two rAF callbacks allow rendering to progress. These observations do not establish what the original PNG displayed, do not replace it, and do not change its original assertion. The existing overall deadline still applies.",
  };
  try {
    receipt.immediatelyAfterOriginal = await read();
    await waitTwoFrames();
    receipt.afterTwoFrames = await read();
    await captureSecond();
    receipt.status = "complete";
  } catch (error) {
    receipt.status = "failed";
    receipt.failure = String(error.stack || error);
  }
  return receipt;
};

// Test-app-only ownership receipt publication.
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function publishOwnershipReceipt(ownershipFile, identity) {
  // Readers use receipt existence as readiness. Finish the private write before
  // publishing it; link is atomic and, unlike rename, cannot replace an owner.
  const temporaryDirectory = await mkdtemp(`${ownershipFile}.`);
  try {
    const temporaryReceipt = path.join(temporaryDirectory, "owner.json");
    await writeFile(temporaryReceipt, JSON.stringify(identity), {
      flag: "wx",
      mode: 0o600,
    });
    await link(temporaryReceipt, ownershipFile);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

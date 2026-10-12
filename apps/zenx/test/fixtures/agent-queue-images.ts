import type { AttachmentRef } from "../../../../src/attachment.js";

/** Locally generated geometric test images; never user attachments. */
export const queueImageAttachments = [
  {
    type: "attachment",
    sha256: "a242d78195298d032c90861c557ac3b13d54b1bbe40ac96d5d0f9bc548248ea7",
    mediaType: "image/png",
    byteLength: 10230,
    width: 640,
    height: 420,
  },
  {
    type: "attachment",
    sha256: "490daf414329d31c44c3c6ec19deb8a6f06e27b861a9cb97a113b64b2c8416a8",
    mediaType: "image/png",
    byteLength: 10586,
    width: 640,
    height: 420,
  },
  {
    type: "attachment",
    sha256: "5f311d15b0defcbb0db8ba2a2e4db3c8c4157e92df26b15cc22432a58560185c",
    mediaType: "image/png",
    byteLength: 10690,
    width: 640,
    height: 420,
  },
  {
    type: "attachment",
    sha256: "ee4f915223fe1408d2254262b275caadac14f22e9123edbc6111a9206a82d338",
    mediaType: "image/png",
    byteLength: 10482,
    width: 640,
    height: 420,
  },
  {
    type: "attachment",
    sha256: "a06f6eb600f3fca75439bf99dc1de76bfaa494213584ef4121fb9a723234ca43",
    mediaType: "image/png",
    byteLength: 10555,
    width: 640,
    height: 420,
  },
  {
    type: "attachment",
    sha256: "db48af993ed084881682b0efb596d535c0d58864008e040410533900003c1517",
    mediaType: "image/png",
    byteLength: 10808,
    width: 640,
    height: 420,
  },
] as const satisfies readonly AttachmentRef[];

export const missingQueueImage: AttachmentRef = {
  type: "attachment",
  sha256: "f".repeat(64),
  mediaType: "image/png",
  byteLength: 17,
  width: 640,
  height: 420,
};

export async function readQueueFixtureImage(
  attachment: AttachmentRef,
): Promise<Uint8Array> {
  const index = queueImageAttachments.findIndex(
    (image) => image.sha256 === attachment.sha256,
  );
  if (index < 0) throw new Error("Simulated image is unavailable.");
  const response = await fetch(
    new URL(
      `./assets/queue-images/queue-image-${index + 1}.png`,
      import.meta.url,
    ),
  );
  if (!response.ok) throw new Error("Simulated image could not be read.");
  return new Uint8Array(await response.arrayBuffer());
}

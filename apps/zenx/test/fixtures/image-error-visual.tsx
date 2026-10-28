// Synthetic failures only; uses production thumbnail and preview components.
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AttachmentImage,
  ImagePreview,
} from "../../src/renderer/src/ImagePresentation.js";
import type { AttachmentRef } from "../../../../src/attachment.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
document.documentElement.dataset.appearance = "dark";
const attachment: AttachmentRef = {
  type: "attachment",
  sha256: "a".repeat(64),
  mediaType: "image/png",
  byteLength: 4,
  width: 1,
  height: 1,
};
const read = async () => {
  throw new Error(
    "Synthetic attachment read failed: fixture image is unavailable.",
    {
      cause: new Error(
        "Synthetic EIO: local fixture storage read interrupted. No user file or actual request was used.",
      ),
    },
  );
};
function Fixture() {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <main style={{ padding: 32, maxWidth: 720 }}>
      <h1>Image error · owner-local details</h1>
      <p>
        Synthetic data · production AttachmentImage + ImagePreview. No Host,
        model, or user profile access.
      </p>
      <h2>Failed queue thumbnail</h2>
      <div className="message-images" style={{ padding: 16 }}>
        <AttachmentImage
          attachment={attachment}
          name="Synthetic image"
          compact
          retryOnError
          onReadAttachment={read}
          onOpen={(_ref, _name, element) => setTrigger(element)}
        />
      </div>
      <button ref={button} onClick={() => setTrigger(button.current)}>
        Open failed image preview
      </button>
      <p>
        Acceptance: expand thumbnail details; open preview → Tab to Technical
        details → expand → Tab into text → Escape. Original cause remains plain
        text; close returns focus to the trigger.
      </p>
      {trigger && (
        <ImagePreview
          attachment={attachment}
          name="Synthetic image"
          onReadAttachment={read}
          trigger={trigger}
          onClose={() => setTrigger(null)}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

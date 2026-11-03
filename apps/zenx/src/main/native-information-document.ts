import { isTrustedImZenXSetupSender } from "./imzenx-setup-ipc.js";

/** Per-request current-document lease; navigation invalidates even a same-URL reload. */
export function captureNativeInformationDocument(options: {
  rendererUrl: string;
  sender(): {
    ownedWindow: boolean;
    mainFrame: boolean;
    url: string;
    document: unknown;
    destroyed: boolean;
  };
  onDocumentNavigation(invalidate: () => void): () => void;
}): { admit(): void; close(): void } {
  const initial = options.sender();
  let invalid = false;
  const admit = () => {
    const current = options.sender();
    if (
      invalid ||
      current.destroyed ||
      !initial.document ||
      current.document !== initial.document ||
      !isTrustedImZenXSetupSender(current, options.rendererUrl)
    )
      throw Error(
        "Information editing requires the current trusted ZenX main document",
      );
  };
  admit();
  const unsubscribe = options.onDocumentNavigation(() => {
    invalid = true;
  });
  return {
    admit,
    close() {
      invalid = true;
      unsubscribe();
    },
  };
}

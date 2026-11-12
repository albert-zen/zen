import { EditorView } from "@codemirror/view";

/** Shared by every CodeMirror editor; the nonce belongs to this loaded document. */
export function editorStyleNonce() {
  const metas = document.querySelectorAll<HTMLMetaElement>(
    'meta[name="zenx-style-nonce"]',
  );
  if (metas.length === 0) {
    // Vite dev and explicitly permissive isolated fixtures have no nonce.
    // Missing metadata never relaxes CSP: a strict document still blocks styles.
    return [];
  }
  const nonce = metas[0]!.content;
  if (metas.length !== 1 || !/^[A-Za-z0-9+/]{32}$/u.test(nonce))
    throw new Error("Invalid document editor style nonce");
  return [EditorView.cspNonce.of(nonce)];
}

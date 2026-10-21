/** Small input seam shared by the plain and structured composer surfaces. */
export interface ComposerEditorHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly element: HTMLElement | null;
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
  setSelectionRange(start: number, end: number): void;
}
export type ComposerInput = HTMLTextAreaElement | ComposerEditorHandle;
export function composerInputElement(
  input: ComposerInput | null,
): HTMLElement | null {
  return input && "element" in input ? input.element : input;
}

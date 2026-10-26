/**
 * Nonce for the style elements CodeMirror injects at runtime.
 *
 * The production renderer keeps `style-src 'self'`, so the editor base theme
 * and its syntax token colours only apply when their injected style element
 * carries this token. `src/renderer/index.html` spells the same value in the
 * CSP meta, and `test/renderer-csp.test.ts` keeps the two in sync.
 */
export const EDITOR_STYLE_NONCE = "qMpCLgrjajDz";

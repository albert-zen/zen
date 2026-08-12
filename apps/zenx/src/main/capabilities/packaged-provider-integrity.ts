/**
 * Release-build trust anchor for resources/providers/manifest.json.
 * This source-embedded value is immutable after the application is built.
 * A release that ships different provider bytes must update this constant in
 * the same signed source change; an invalid anchor leaves providers offline.
 */
export const PACKAGED_PROVIDER_MANIFEST_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

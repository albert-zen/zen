/**
 * Release-build trust anchor for resources/providers/manifest.json.
 * This source-embedded value is immutable after the application is built.
 * A release that ships different provider bytes must update this constant in
 * the same signed source change; an invalid anchor leaves providers offline.
 */
export const PACKAGED_PROVIDER_MANIFEST_SHA256 =
  "__ZENX_PACKAGED_PROVIDER_MANIFEST_SHA256__";

# Image input preparation

Zen prepares each model-visible image through the shared Host sampling boundary. This applies to user uploads, `view_image`, explicit code media, and auxiliary compaction/image-probe samples. The original attachment and local source file are never overwritten.

## Profiles and codecs

The dimension calculation follows the fixed Codex source at [`f05aa41`](https://github.com/openai/codex/blob/f05aa41da6d063cd820dbad207d1cfabae594ff2/codex-rs/utils/image/src/lib.rs#L308-L352):

- Default HIGH: longest edge 2048, at most 2500 patches, each patch `ceil(width/32) * ceil(height/32)`, no upscaling. A 2048-square image becomes 1600-square.
- Explicit ORIGINAL: longest edge 6000 and at most 10000 patches. ORIGINAL is bounded, not an unlimited byte/resolution bypass.
- Below the dimensions threshold, PNG, JPEG and WebP retain their original bytes, even if a small-dimension PNG has many bytes.
- On transformation, JPEG stays JPEG at quality 85, PNG stays PNG, WebP is lossless WebP, and GIF becomes a static PNG.
- Sharp 0.35.5 supplies the reusable Node/Electron codec. Its `linear` kernel is the triangle filter. `keepIccProfile()` is applied only to RGB ICC profiles. Container-level EXIF copying preserves the source raw EXIF instead of libvips rewriting its pixel-size tags. Neither requests automatic orientation. PNG/JPEG/WebP orientation/EXIF/ICC fixtures verify this; non-RGB ICC is not attached to re-encoded RGB pixels. Rust `image` and Sharp/libvips are different encoders; this is not a claim of identical encoded bytes, pixel rounding, or all possible metadata behavior. PNG encoding/compression may produce different byte sizes.

The existing per-file 20 MiB, 16384-dimension and 40-megapixel admission limits remain. Preparation adds no request image-count limit or aggregate image-byte cap and does not elide historical images. Existing bounded native inline-upload admission limits remain a separate transport contract. Unknown provider limits are not invented. Byte reduction depends on the actual image; no fixed KB result is promised.

## Original detail capability

`view_image` accepts `detail: "original"`. The current provider/model must explicitly declare `supportsImageDetailOriginal: true` in model metadata. The subscription catalog's actual boolean `supports_image_detail_original` is preserved through discovery/cache; a manual model capability can also supply it. Image modality support or a familiar model ID alone does not imply this capability. For a non-default model whose general input modalities are unknown, the Host retains its existing attempt semantics with bounded HIGH preparation; it does not falsely claim that images were withheld. Unknown and unsupported tool requests fail clearly before reading the image.

Image input parts can also request original detail. Each sample freezes the actual selected profile and capability. When an older original-detail image is used with a different model whose capability is unknown or false, the new sample explicitly announces a HIGH fallback rather than blocking all history or pretending to send original detail. ORIGINAL still applies the 6000/10000 profile. Adapters serialize the explicitly selected `detail` value; they do not resize or change pixels themselves.

## Persistence and replay

The Host imports prepared bytes as a separate content-addressed attachment. Before dispatch it appends sample-scoped `image_preparation` semantic Items containing the exact view, notice, selected provider/model, profile/capability and original occurrence address. The sole ItemList compiler substitutes those persisted parts at the original image position, not at the history tail. Derived media keep the original `itemId / field / partIndex / sha256` provenance for exact media-rejection recovery. Two occurrences sharing an attachment hash remain separate occurrences.

Cold replay compiles the stored prepared reference and exact notice; it does not run the codec again or read current provider configuration. A different sample gets its own preparation choice. Previously stored deterministic derived bytes may be reused, but the byte cache is not a second conversation authority. Referencing an original remains restricted to images already authorized to the current thread, or a permitted local path through `view_image`; preparation does not add remote URL fetching or broaden file access.

Read-only context preflight applies the same dimension calculation numerically, without manufacturing a model-visible attachment. The final context-window guard still measures the real persisted compiled view and notices. Estimates remain provider-neutral pressure estimates, not billing/tokenizer claims.

An admitted image whose pixels cannot be decoded or transformed receives a persisted, sample-scoped unavailable notice instead of pixels. The immutable original attachment remains referenced and is reconsidered for each later sample; missing/corrupt storage, identity and derived-write failures remain hard preparation errors. This change does not change transport retries or claim that an HTTP 500 proves an image is too large. It does not silently delete images after HTTP 500. Codex's separate compaction retained-token policy and development-only per-image ORIGINAL selection are not aggregate byte/count budgets.

## Verification limits

Zen follows Codex-style processing-failure placeholders for already-admitted local images. Only in-memory codec operations receive stable decode/processing categories, never raw decoder messages or paths. The strict decoder requires the exact shared safe notice template derived from that category and the canonical original ref, including on cold reload; matching text fields alone cannot admit arbitrary prose. The persisted overlay is text-only and the UI says unavailable rather than claiming that a resized image was sent. Original-detail capability/profile validation still applies, and unavailable results never trigger an original-resolution bypass or replace canonical source attachments. Remote URL image retrieval is outside Zen's current authorized input contract. Sharp/libvips is not Rust's `image` crate, so equivalent dimension/format/metadata policy does not establish pixel-for-pixel encoder identity.

Read-only context and summary budgeting may reuse the text cost of a durable unavailable observation for the same original occurrence, requested detail and effective preparation profile. Changing original-detail capability does not invalidate a HIGH codec observation, including an original request falling back to HIGH; a switch between HIGH and supported ORIGINAL remains a different profile. This avoids counting known unavailable history as image patches before chunking. A later successful observation supersedes the estimate. Unknown/new inputs retain conservative dimension estimates, and every actual sample still verifies the original and persists its own prepared/unavailable view before the final compiled-window guard.

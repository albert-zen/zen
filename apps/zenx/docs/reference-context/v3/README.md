# Inline reference context capture (v3)

This synthetic-only fixture demonstrates an ordered draft with five inline
reference chips: two message excerpts, two Thread pointers, and one file pointer.
`fixture-metadata.json` retains the original v3 input **byte-for-byte**, including
its original source identities and UTF-16 chip positions. The actual user text
from the new sole ItemList compiler, observed at the production Chat Completions
and Responses adapter transport boundaries, is in `model-user-message.txt`.

The capture verifies three separate facts before dispatch: the original v3 input
is unchanged in the durable fact log; compact user-role semantic text/parts have
already been persisted to ItemList; and the compiler's exact contents match the
actual provider serialization. `verification.json` records these checks for both
adapters. All data is synthetic, network access is blocked, and only the user
text, original input fixture, and verification facts are exported. Temporary
source logs and ItemLists are removed; no full provider requests, system prompts,
or tool prompts are exported.

The visible receipt timestamp is the recorded submission time. The original v3
format carries no source-message timestamps, so unavailable source times are
stated explicitly rather than replaced with submission or checkpoint time. The
two selected excerpts are unchanged, including their whitespace. Thread and file
pointers do not include source bodies or imply that a source has been read.

The four `sN` references retain exact source identities as internal provenance,
not model prose. When the existing authorized `zenx_threads_read` capability is
available, its `ref` argument accepts these owner-scoped read-only source refs;
message refs route to the exact Item, Thread refs to the exact Thread. Current
native permissions still apply. These refs do not authorize mutations or confer
access after a fork/import. The file has no dedicated selected-source reader:
its exact workspace and relative path remain visible to avoid changing its
location. No unusable file `sN` is minted. Names and excerpts remain user-role
quoted data, not higher-priority instructions or new authorization.

The UI continues rendering the original v3 input through the same shared codec.
The stored semantic text and original source fact are separately inspectable;
neither renderer nor provider adapter invents a late textual wrapper.

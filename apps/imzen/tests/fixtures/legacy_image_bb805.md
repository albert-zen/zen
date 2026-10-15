# Legacy image fixture provenance

`legacy_image_bb805.json` was generated with the actual installed
`im-agent-sdk` Git revision `bb8055054e4b77b2677682e708dd6f394b56406c`,
verified through its installation `direct_url.json` and module path. No current
SDK mocks were used to fabricate the old shape. A synthetic 2×2 PNG was downloaded
from an in-memory callback, validated/staged with the old public
`ImageMediaMaterializer` and `materialize_inbound_images`, then passed through the
old `NativeTransportChannelAdapter` and `BaseChannelAdapter.dispatch_inbound`.
The resulting channel attachment carries the actual 79-byte size.

The second record deliberately represents a custom old public API caller with
no declared size. Actual old `ZenApplicationAdapter.send_input` accepted both
records beneath a configured trusted root and emitted `localImage` input. This
second record is not a QQ-produced attachment. The old IMZen steering unit test
and real-ZAS synthetic transport probe also constructed this size-less shape.
The local path was replaced with a synthetic placeholder; the tests materialize
the recorded bytes beneath their own temporary root.

The original main SDK pin `7d5f11793656` and bb805 have identical Git blobs for
all four native channel implementations and their shared image chain. The
installed files were also checked byte-for-byte against the bb805 source:

- `channels/native/media.py`: `b2e382813e20dc870b7318dbfae17d09a5c649c3`
- `channels/native/models.py`: `f63a2fbe000e774484709921ab7ea115b26285bf`
- `channels/native/qq.py`: `16dbdbb65b5428a62c3fa22461d7bcca7bb1b008`
- `channels/native/qq_media.py`: `2b43cee93c0d2dc14e478c42feabb4ee6acaadfc`
- `channels/native/telegram.py`: `f291fc64ed4f3e45891e01dd05eed8aa2a8e5002`
- `channels/native/feishu.py`: `0bc481c3e2b1d555452a7743b57b89a5a32b4715`
- `channels/native/weixin.py`: `a31175d23ad83778e491cd1640a5b8443710502c`
- `channels/native/weixin_ilink.py`: `3ef93256e06a0029e3894972cb5c34bdf94af80b`
- `channels/runtime.py`: `f9fa0b97846723ac8d2519460942b94d5c9f1078`
- `contracts/model.py`: `d61d32cb797a9fc09d72aeffa61a9200d6ae8935`
- `attachments.py`: `5985756b0383e2f201408f27b21b2cd935d19dda`

Paths are under `src/imagent/` in the old SDK. The input-preparation prefix of
`applications/appserver.py:send_input` also has an identical AST at both pins.
All inputs, peers, IDs, and staged bytes were synthetic. No real IM account or
network delivery was used. The production regression passes through the public
Gateway and SDK adapter; the existing ZAS integration probe exercises the
size-less image shape against the real native server.

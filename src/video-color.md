# Video colour conversion

The web video element defaults to the versioned `chromium65` colour profile.
Set `videoColorProfile: "ffmpeg"` in the runtime configuration to use the decoder's
ordinary conversion. Unknown profile names fail loading rather than silently
selecting another colour contract.

The host's `media.loadVideo(path, profile)` and `loadVideoAsync(path, profile)`
accept the same profile names. Omitting the profile retains ordinary FFmpeg
conversion for direct host consumers.

The compatible conversion covers even-sized, 8-bit planar YUV420, limited-range
Rec.601 with centred or unspecified chroma location. VP8 without colour-matrix
metadata uses Rec.601. Other unspecified matrices, explicit full range, other
matrices, chroma locations, pixel formats and odd dimensions retain ordinary
conversion. These fallbacks are not claims of browser pixel equivalence.

Chroma sampling interpolates horizontally and then vertically, rounding to a
byte after each axis. Displayed video uses the compositor's float32 Rec.601
matrix and limited-range adjustment. Canvas and texture consumers use the GPU
canvas matrix. RGB channels saturate independently; alpha is opaque.

A video owns one stable presentation image. The current compatible frame retains
packed YUV planes, bounded by the existing checked frame dimensions and allocation
limit. `media.videoCanvasImage(handle)` lazily creates a second stable image with
the canvas conversion. It returns the presentation image when no separate
conversion is needed. Both images update when a new decoded frame is installed.
Canvas requests do not alter the presentation image or video playback state.

The video owns both image handles and releases them on resource replacement,
explicit release or finalization. Renderers may retain either image under the
ordinary image ownership contract. Installed YUV backing and the reusable canvas
conversion buffer participate in the host's external memory accounting. Ordinary
movie playback allocates no canvas surface or second image.

The synthetic colour regression compares two decoded frames against separately
captured browser presentation, Canvas2D and WebGL texture bytes. It also checks
backward seeking, stable texture handles, lazy allocation, retained renderer
ownership, invalid profiles and the full-range BT.709 fallback.

The fixture is an authored 64×64, two-frame YUV420 pattern at 2 FPS. Its byte
values are `(9*x + 5*y + 53*frame) % 256` for Y,
`(17*x + 31*y + 73*frame) % 256` for U and
`(37*x + 11*y + 97*frame) % 256` for V, with chroma coordinates on the 32×32
planes. VP8 encoding uses libvpx, `-b:v 10M -qmin 0 -qmax 0 -g 1`.
The reference freezes the resulting movie hash, browser identity and two fresh
process replays at times 0.02 and 0.52 seconds. Presentation bytes come from
page screenshots; canvas bytes from `drawImage`/`getImageData`; texture bytes
from video `texImage2D` and framebuffer readback. The separate fallback fixture
uses lossless VP9 with explicit full-range BT.709 metadata.

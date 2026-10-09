# Third-party notices

PMJS's MIT license covers its own contributions, not third-party material.

| Material | Origin/version | Terms and retained notice |
| --- | --- | --- |
| Fragment sorting implementation | V8 5.1.281, copyright 2012 | BSD-3-Clause; `third_party/v8.LICENSE` |
| Terrax lighting compatibility portions and tests | TerraxLighting 1.4.9 | MIT, copyright 2016 Terraxz; `third_party/terrax.LICENSE` |
| Unicode default-ignorable data | Unicode 16.0.0 | Unicode-3.0; `third_party/unicode.LICENSE` |
| Effekseer and stb portions | Revision pinned in `tools/effekseer.lock.json` | MIT and embedded stb notice; `third_party/effekseer.LICENSE` |
| Effekseer effect fixtures | Revision in `test/assets/effects/LICENSE` | MIT; adjacent `LICENSE` |
| Color-matrix shader contract and pixel-test reference | PixiJS 4.5.4 | MIT; `third_party/pixi4.LICENSE` |
| Pixi 5 sprite fixture | PixiJS 5.3.12 | MIT; `test/assets/pixi5/LICENSE` |
| Zoom blur fixture | pixi-filters 3.1.0 | MIT; `test/assets/pixi-filters/LICENSE` |
| Fallback and test font | Liberation Sans 2.1.5, renamed subset | SIL-OFL-1.1; `js/pmjs-web/fallback-font.LICENSE`, `test/assets/testfont.LICENSE` |
| Text shaping font | DejaVu 2.37, renamed PMJS Text Test | Bitstream-Vera, Arev terms and public-domain DejaVu changes; `test/assets/text-shaping.LICENSE` |
| Skia and ARM parity source fixture | bd0dafbc8112f6cfa92a8096d8cb5696d8535ef9 | BSD-3-Clause; `third_party/skia65/Skia.LICENSE` |
| Skia65 FreeType | Revision in `tools/skia65/sources.lock.json` | FTL option; `third_party/skia65/FreeType.LICENSE` (GPL alternative also retained) |
| Skia65 HarfBuzz | 1.7.3 with pinned Chromium fixes | MIT-style terms; `third_party/skia65/HarfBuzz.LICENSE` |
| Skia65 ICU | c8ca2962b46670ec89071ffd1291688983cd319c | Unicode/ICU and included data notices; `third_party/skia65/ICU.LICENSE` |
| Host HarfBuzz | Build-dependent | MIT-style terms; `third_party/harfbuzz.LICENSE` |

This software is based in part on the work of the FreeType Team.
FreeType is used under its FreeType License option; retaining its GPL alternative
text does not select that alternative.

## Linked and packaged dependencies

Node/V8, SDL2, EGL/GLES providers, zlib, libpng, libjpeg, FreeType, HarfBuzz,
and FFmpeg are external dependencies. Applicable licenses depend on the
versions and build configurations distributed. EGL/GLES and SDL supplied
by the operating system are not automatically bundled dependencies.
Node's distribution includes notices for additional components; retain its full
LICENSE when shipping Node. Test fixtures are not normally runtime payloads.
Linux ARM64 builds also link Zig's compiler runtime and LLVM libc++, libc++abi
and libunwind. Their complete MIT and Apache/LLVM exception notices are installed
under `share/pmjs/notices/compiler/` in the binary package.

[FFmpeg's license](https://ffmpeg.org/legal.html) depends on its build
configuration. LGPL builds and GPL builds have different redistribution requirements; PMJS's MIT license does not replace
those terms. Builds configured with `--enable-nonfree` are unredistributable.
Distributed binaries require the applicable notices and corresponding source,
including modifications and build information required by their licenses.

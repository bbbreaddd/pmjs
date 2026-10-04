import argparse
import pathlib
import re

from provision import ROOT, digest, provision

OUTPUT = ROOT / "src/skia65/pinned_sources.cmake"


def generate(cache):
    groups = [
        ("ft", "chromium/third_party/freetype/BUILD.gn", '${chromium}/third_party/freetype/BUILD.gn',
            r'"src/(src/[^"\n]+\.c)"', ["builds/unix/ftsystem.c"], {"src/base/ftsystem.c"}),
        ("hb", "chromium/third_party/harfbuzz-ng/BUILD.gn", '${chromium}/third_party/harfbuzz-ng/BUILD.gn',
            r'"src/([^"\n]+\.cc)"', [], {"hb-glib.cc", "hb-coretext.cc"}),
        ("icu", "icu/BUILD.gn", '${icu}/BUILD.gn',
            r'"(source/common/[^"\n]+\.(?:c|cpp))"', [], set()),
    ]
    lines = []
    for name, file, variable, pattern, initial, excluded in groups:
        source = cache / file
        lines += [f'file(SHA256 "{variable}" {name}BuildSha256)',
            f'if(NOT {name}BuildSha256 STREQUAL "{digest(source)}")',
            f'  message(FATAL_ERROR "Pinned {name} build definition changed; verify the frozen source list")',
            'endif()', f'set({name}Sources']
        entries = list(dict.fromkeys(initial + re.findall(pattern, source.read_text())))
        if not entries:
            raise RuntimeError(f"No pinned sources found in {source}")
        lines += [f'  "${{{name}}}/{entry}"' for entry in entries if entry not in excluded]
        lines += [')', '']
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=pathlib.Path, default=ROOT / ".cache/skia65")
    parser.add_argument("--write", action="store_true")
    options = parser.parse_args()
    provision(options.cache)
    generated = generate(options.cache)
    if options.write:
        OUTPUT.write_text(generated)
    elif OUTPUT.read_text() != generated:
        raise RuntimeError("Frozen component sources changed; regenerate and review explicitly")

#include "Sk4px.h"
#define SK_OPTS_NS candidate
#include "SkBlitMask_opts.h"
#undef SK_OPTS_NS
#undef SkBlitMask_opts_DEFINED
#undef SK_ARM_HAS_NEON
#define SK_OPTS_NS reference
#include "SkBlitMask_opts.h"
#undef SK_OPTS_NS

#include <array>
#include <cstdio>
#include <vector>

int main() {
    const std::array<int, 20> widths = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        11, 12, 13, 14, 15, 16, 17, 31, 32, 33};
    const std::array<SkColor, 8> colors = {0x01000000, 0x40000000, 0x80000000,
        0xa0ffffff, 0xfe204080, 0x8010ff80, 0xff000000, 0xffffffff};
    const std::array<SkPMColor, 6> destinations = {0x00000000, 0x70000000,
        0x30000000, 0x80402010, 0xffabcdef, 0xffffffff};
    for (int width : widths) for (SkColor color : colors)
        for (SkPMColor destination : destinations) for (int coverage = 0; coverage < 256; ++coverage) {
            const int stride = width + 7, maskStride = width + 3, height = 3;
            std::vector<SkPMColor> actual(stride * (height + 2), 0x12345678);
            std::vector<SkAlpha> mask(maskStride * height, 0);
            for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
                actual[(y + 1) * stride + x + 1] = destination;
                mask[y * maskStride + x] = static_cast<SkAlpha>(coverage + 53 * x + 71 * y);
            }
            auto expected = actual;
            candidate::blit_mask_d32_a8(actual.data() + stride + 1,
                stride * sizeof(SkPMColor), mask.data(), maskStride, color, width, height);
            reference::blit_mask_d32_a8(expected.data() + stride + 1,
                stride * sizeof(SkPMColor), mask.data(), maskStride, color, width, height);
            if (actual != expected) {
                std::fprintf(stderr, "Mask mismatch: width=%d color=%08x destination=%08x coverage=%d\n",
                    width, color, destination, coverage);
                return 1;
            }
        }
    std::puts("245760 mask cases match pinned non-NEON Sk4px arithmetic");
}

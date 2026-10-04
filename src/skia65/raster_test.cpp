#include "Sk4px.h"
#define SK_OPTS_NS candidate
#include "SkBlitRow_opts.h"

#include <array>
#include <cmath>
#include <cstdio>

int main() {
    constexpr std::array<int, 24> widths = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        13, 14, 15, 16, 17, 23, 24, 31, 32, 33, 63, 65};
    size_t rows = 0;
    for (int width : widths) for (unsigned alpha = 0; alpha < 256; ++alpha)
        for (unsigned channel = 0; channel < 256; ++channel) {
            std::array<SkPMColor, 80> actual, source;
            actual.fill(0x12345678);
            for (int x = 0; x < width; ++x) {
                source[x] = SkPreMultiplyColor(SkColorSetARGB(alpha,
                    channel, (channel + 53 * x) & 255, (channel + 71 * x) & 255));
                actual[x + 1] = SkPreMultiplyColor(SkColorSetARGB((alpha + 31 * x) & 255,
                    (channel + 19 * x) & 255, 255 - channel, (channel + 137) & 255));
            }
            auto expected = actual;
            for (int x = 0; x < width; ++x) expected[x + 1] = SkPMSrcOver(source[x], expected[x + 1]);
            candidate::blit_row_s32a_opaque(actual.data() + 1, source.data(), width, 255);
            if (actual != expected) {
                std::fprintf(stderr, "Source-over mismatch: width=%d alpha=%u channel=%u\n", width, alpha, channel);
                return 1;
            }
            ++rows;
        }
    for (int n = -1024; n <= 1024; ++n) {
        const std::array<float, 4> values = {n * 0.5f, n * 0.5f - 0.0001f,
            n * 0.5f + 0.0001f, n * 0.25f};
        std::array<int32_t, 4> actual;
        Sk4f_round(Sk4f::Load(values.data())).store(actual.data());
        for (int lane = 0; lane < 4; ++lane) {
            if (actual[lane] != static_cast<int32_t>(std::nearbyint(values[lane]))) {
                std::fprintf(stderr, "Float rounding mismatch: value=%.9g\n", values[lane]);
                return 1;
            }
        }
    }
    std::printf("%zu source-over rows and 8196 float conversions match reference arithmetic\n", rows);
}

#include "media_mix.hpp"
#include "effects_audio.hpp"

#include <cmath>
#include <string_view>
#include <iomanip>
#include <fstream>
#include <iostream>
#include <vector>

namespace {

int failures = 0;

void check(bool condition, const char* label, int line) {
  if (!condition) {
    ++failures;
    std::cerr << "FAIL line " << line << ": " << label << '\n';
  }
}

#define CHECK(cond, label) check((cond), (label), __LINE__)

bool near(float actual, float expected, float tolerance = 1e-5F) {
  return std::fabs(actual - expected) <= tolerance;
}

pmjs::VoiceMixState constantVoice(int frames, float left, float right) {
  pmjs::VoiceMixState voice;
  voice.playing = true;
  for (int i = 0; i < frames; ++i) {
    voice.samples.push_back(left);
    voice.samples.push_back(right);
  }
  return voice;
}

void testVolumeAndMaster() {
  auto voice = constantVoice(8, 0.5F, -0.5F);
  voice.volume = 0.25F;
  std::vector<float> output(4, 0.0F);
  pmjs::mixVoiceInto(voice, output.data(), 2, 1.0F);
  CHECK(near(output[0], 0.125F) && near(output[1], -0.125F), "voice volume scales samples");
  CHECK(near(output[2], 0.125F) && near(output[3], -0.125F), "voice volume is stable");

  auto master = constantVoice(8, 0.5F, 0.5F);
  std::vector<float> masterOut(2, 0.0F);
  pmjs::mixVoiceInto(master, masterOut.data(), 1, 0.65F);
  CHECK(near(masterOut[0], 0.325F) && near(masterOut[1], 0.325F),
        "master volume scales mixed samples");
}

void testMzEqualPowerPan() {
  for (int channels : {1, 2}) for (float pan : {-1.0F, -0.5F, 0.0F, 0.5F, 1.0F}) {
    // The decoder duplicates mono into two channels with a -3 dB gain.
    auto voice = constantVoice(8, channels == 1 ? 0.5F / std::sqrt(2.0F) : 0.25F,
      channels == 1 ? 0.5F / std::sqrt(2.0F) : 0.5F);
    voice.panMatrix = pmjs::equalPowerPanMatrix(channels, pan);
    std::vector<float> out(2);
    pmjs::mixVoiceInto(voice, out.data(), 1, 1);
    float expectedLeft, expectedRight;
    if (channels == 1) {
      const float angle = (std::atan2(pan, 1 - std::fabs(pan)) + std::numbers::pi_v<float> / 2) / 2;
      expectedLeft = 0.5F * std::cos(angle); expectedRight = 0.5F * std::sin(angle);
    } else if (pan < 0) {
      const float angle = std::atan2(pan, 1 - std::fabs(pan)) + std::numbers::pi_v<float> / 2;
      expectedLeft = 0.25F + 0.5F * std::cos(angle); expectedRight = 0.5F * std::sin(angle);
    } else {
      const float angle = std::atan2(pan, 1 - std::fabs(pan));
      expectedLeft = 0.25F * std::cos(angle); expectedRight = 0.5F + 0.25F * std::sin(angle);
    }
    CHECK(near(out[0], expectedLeft) && near(out[1], expectedRight), "MZ equal-power position matches mono/stereo rules");
  }
  std::ifstream reference(PMJS_MZ_AUDIO_REFERENCE);
  int channels = 0, cases = 0;
  float pan, left, right;
  while (reference >> channels >> pan >> left >> right) {
    auto fixture = constantVoice(4, channels == 1 ? 0.5F / std::sqrt(2.0F) : 0.25F,
      channels == 1 ? 0.5F / std::sqrt(2.0F) : 0.5F);
    fixture.panMatrix = pmjs::equalPowerPanMatrix(channels, pan);
    float output[2]{};
    pmjs::mixVoiceInto(fixture, output, 1, 1);
    CHECK(near(output[0], left, 1e-6F) && near(output[1], right, 1e-6F), "MZ panning matches stock Web Audio samples");
    ++cases;
  }
  CHECK(cases == 18 && reference.eof(), "all stock MZ panning references must run");
  auto voice = constantVoice(8, 0.5F, 0.5F);
  voice.gain = 0.2F; voice.targetGain = 0.8F; voice.gainStep = 0.2F; voice.absoluteGainEnvelope = true;
  std::vector<float> out(8);
  pmjs::mixVoiceInto(voice, out.data(), 4, 1);
  CHECK(near(out[0], 0.1F) && near(out[6], 0.4F), "absolute gain ramps from current value without logical volume multiplication");
}

void testPanLaw() {
  auto right = constantVoice(4, 0.4F, 0.4F);
  right.pan = 1.0F;
  std::vector<float> rightOut(2, 0.0F);
  pmjs::mixVoiceInto(right, rightOut.data(), 1, 1.0F);
  CHECK(near(rightOut[0], 0.0F) && near(rightOut[1], 0.4F), "full-right pan silences left");

  auto left = constantVoice(4, 0.4F, 0.4F);
  left.pan = -1.0F;
  std::vector<float> leftOut(2, 0.0F);
  pmjs::mixVoiceInto(left, leftOut.data(), 1, 1.0F);
  CHECK(near(leftOut[0], 0.4F) && near(leftOut[1], 0.0F), "full-left pan silences right");

  auto center = constantVoice(4, 0.4F, 0.4F);
  std::vector<float> centerOut(2, 0.0F);
  pmjs::mixVoiceInto(center, centerOut.data(), 1, 1.0F);
  CHECK(near(centerOut[0], 0.4F) && near(centerOut[1], 0.4F), "center pan is neutral");
}

void testSpatialEffects() {
  std::ifstream reference(PMJS_EFFECT_AUDIO_REFERENCE);
  CHECK(reference.good(), "contained stock audio reference must be readable");
  int channels = 0, cases = 0;
  float x, y, z, left, right;
  while (reference >> channels >> x >> y >> z >> left >> right) {
    auto voice = channels == 1 ? constantVoice(4, 0.176776695F, 0.176776695F) :
                               constantVoice(4, 0.25F, -0.125F);
    const auto gains = pmjs::spatialEffectGains(channels, x, y, z);
    voice.leftGain = gains[0]; voice.rightGain = gains[1];
    float output[2]{};
    pmjs::mixVoiceInto(voice, output, 1, 1);
    CHECK(near(output[0], left) && near(output[1], right),
      "spatial output matches captured stock panner amplitude and geometry");
    auto adjusted = voice;
    adjusted.volume = 0.5F; adjusted.pitch = 2;
    const auto before = adjusted.positionFrame;
    float quieter[2]{};
    pmjs::mixVoiceInto(adjusted, quieter, 1, 0.5F);
    CHECK(near(quieter[0], left * 0.25F) && near(quieter[1], right * 0.25F),
      "spatial mono and stereo retain authored volume and master gain");
    CHECK(adjusted.positionFrame == before + 2, "spatial mono and stereo retain pitch advancement");
    ++cases;
  }
  CHECK(cases == 18 && reference.eof(), "all mono and stereo spatial reference cases must run");
  auto stereo = constantVoice(4, 0.25F, -0.125F);
  const auto gains = pmjs::spatialEffectGains(2, 10, 10, 10);
  stereo.leftGain = gains[0]; stereo.rightGain = gains[1];
  stereo.volume = 0.5F; stereo.pitch = 2;
  float output[2]{};
  pmjs::mixVoiceInto(stereo, output, 1, 0.5F);
  CHECK(near(output[0], 0.0625F) && near(output[1], -0.03125F),
    "stereo bypasses spatial panning and attenuation, retaining volume and master gain");
  CHECK(stereo.positionFrame == 2, "spatial playback retains pitch advancement");
}

void testPitchAdvancement() {
  pmjs::VoiceMixState voice;
  voice.playing = true;
  voice.pitch = 2.0F;
  for (int i = 1; i <= 6; ++i) {
    voice.samples.push_back(static_cast<float>(i));
    voice.samples.push_back(static_cast<float>(-i));
  }
  std::vector<float> output(2, 0.0F);
  pmjs::mixVoiceInto(voice, output.data(), 1, 1.0F);
  CHECK(near(output[0], 1.0F) && near(output[1], -1.0F), "double pitch reads the first frame");
  CHECK(voice.positionFrame == 2, "double pitch advances two frames");

  pmjs::VoiceMixState half;
  half.playing = true;
  half.pitch = 0.5F;
  half.samples = {0.0F, 0.0F, 1.0F, 1.0F, 2.0F, 2.0F, 3.0F, 3.0F};
  std::vector<float> halfOut(4, 0.0F);
  pmjs::mixVoiceInto(half, halfOut.data(), 2, 1.0F);
  CHECK(near(halfOut[0], 0.0F) && near(halfOut[2], 0.5F), "half pitch interpolates");
  CHECK(half.positionFrame == 1, "half pitch advances one frame per two outputs");
}

void testFadeCompletionAndStopAfterFade() {
  auto voice = constantVoice(16, 1.0F, 1.0F);
  voice.gain = 1.0F;
  voice.targetGain = 0.0F;
  voice.gainStep = -0.25F;
  voice.stopAfterFade = true;
  std::vector<float> output(8, 0.0F);
  pmjs::mixVoiceInto(voice, output.data(), 4, 1.0F);
  CHECK(near(output[0], 0.75F) && near(output[2], 0.5F) && near(output[4], 0.25F),
        "fade ramps per-frame gains");
  CHECK(near(output[6], 0.0F), "fade completion mixes no further frames");
  CHECK(voice.gain == 0.0F && voice.gainStep == 0.0F, "fade completion settles gain");
  CHECK(!voice.playing, "stop-after-fade halts the voice");

  // Replay after fade: the service resets gain/playback state on play().
  voice.playing = true;
  voice.gain = 1.0F;
  voice.targetGain = 1.0F;
  voice.gainStep = 0.0F;
  voice.stopAfterFade = false;
  std::vector<float> replay(2, 0.0F);
  pmjs::mixVoiceInto(voice, replay.data(), 1, 1.0F);
  CHECK(near(replay[0], 1.0F) && voice.playing, "replay after fade mixes again");
}

void testGainRampPrecision() {
  constexpr int duration = 48000;
  for (const auto endpoints : {std::array<float, 2>{0.6F, 0.2F},
                               std::array<float, 2>{0.2F, 0.8F}}) {
    auto voice = constantVoice(duration + 3, 1, 1);
    voice.gain = endpoints[0];
    voice.targetGain = endpoints[1];
    voice.gainStep = (voice.targetGain - voice.gain) / duration;
    voice.absoluteGainEnvelope = true;
    std::vector<float> output((duration + 1) * 2);
    for (int frame = 0; frame <= duration; frame += 128) {
      pmjs::mixVoiceInto(voice, output.data() + frame * 2,
        std::min(128, duration + 1 - frame), 1);
    }
    for (int frame = 0; frame <= duration; ++frame) {
      const float expected = static_cast<float>(static_cast<double>(endpoints[0]) +
        (static_cast<double>(endpoints[1]) - endpoints[0]) * frame / duration);
      CHECK(near(output[frame * 2], expected, 1e-6F) &&
            near(output[frame * 2 + 1], expected, 1e-6F),
            "one-second gain automation preserves sample timing and amplitude across callbacks");
    }
    CHECK(voice.gain == voice.targetGain && voice.gainStep == 0 && voice.playing,
          "gain automation reaches its target and retains the source");
  }
}

void testLoopWrap() {
  pmjs::VoiceMixState voice;
  voice.playing = true;
  voice.loop = true;
  voice.loopStart = 2;
  voice.loopEnd = 4;
  voice.positionFrame = 2;
  for (int i = 0; i < 8; ++i) {
    voice.samples.push_back(static_cast<float>(i * 10));
    voice.samples.push_back(0.0F);
  }
  std::vector<float> output(6, 0.0F);
  pmjs::mixVoiceInto(voice, output.data(), 3, 1.0F);
  CHECK(near(output[0], 0.0F) && near(output[2], 10.0F) && near(output[4], 20.0F),
        "loop wrap replays from the loop start");
  CHECK(voice.positionFrame == 3, "loop wrap resets the position frame");
}

void testDurationWrapWithoutLoopPoints() {
  pmjs::VoiceMixState voice;
  voice.playing = true;
  voice.loop = true;
  voice.duration = 4.0 / 48000.0;
  voice.positionFrame = 3;
  for (int i = 0; i < 8; ++i) {
    voice.samples.push_back(0.25F);
    voice.samples.push_back(0.25F);
  }
  std::vector<float> output(4, 0.0F);
  pmjs::mixVoiceInto(voice, output.data(), 2, 1.0F);
  CHECK(voice.positionFrame == 1, "loop without points wraps at the duration end");
  CHECK(near(output[0], 0.25F) && near(output[2], 0.25F), "wrapped loop keeps mixing");
}

void testSimultaneousVoicesAccumulate() {
  auto first = constantVoice(4, 0.3F, 0.1F);
  auto second = constantVoice(4, 0.1F, 0.3F);
  std::vector<float> output(2, 0.0F);
  pmjs::mixVoiceInto(first, output.data(), 1, 1.0F);
  pmjs::mixVoiceInto(second, output.data(), 1, 1.0F);
  pmjs::clampStereoMix(output.data(), 1);
  CHECK(near(output[0], 0.4F) && near(output[1], 0.4F), "voices accumulate");

  auto loud = constantVoice(4, 0.8F, 0.8F);
  auto louder = constantVoice(4, 0.8F, 0.8F);
  std::vector<float> hot(2, 0.0F);
  pmjs::mixVoiceInto(loud, hot.data(), 1, 1.0F);
  pmjs::mixVoiceInto(louder, hot.data(), 1, 1.0F);
  pmjs::clampStereoMix(hot.data(), 1);
  CHECK(near(hot[0], 1.0F) && near(hot[1], 1.0F), "hot mixes clamp to unity");
}

void testEofAndPaused() {
  pmjs::VoiceMixState drained;
  drained.playing = true;
  drained.eof = true;
  std::vector<float> output(2, 5.0F);
  pmjs::mixVoiceInto(drained, output.data(), 1, 1.0F);
  CHECK(!drained.playing, "drained voice at EOF stops");
  CHECK(near(output[0], 5.0F), "drained voice mixes nothing");

  auto paused = constantVoice(4, 0.5F, 0.5F);
  paused.playing = false;
  std::vector<float> quiet(2, 0.0F);
  pmjs::mixVoiceInto(paused, quiet.data(), 1, 1.0F);
  CHECK(near(quiet[0], 0.0F) && near(quiet[1], 0.0F), "paused voice mixes nothing");
}

void testPreparedSampleParity() {
  auto asset = std::make_shared<pmjs::PreparedAudioAsset>();
  for (int frame = 0; frame < 16; ++frame) {
    asset->samples.push_back(frame * 0.03F);
    asset->samples.push_back(-frame * 0.02F);
  }
  for (float pitch : {0.5F, 1.0F, 1.3F, 2.0F, 8.0F}) {
    for (bool loop : {false, true}) {
      pmjs::VoiceMixState sample, stream;
      sample.asset = asset;
      sample.positionFrame = stream.positionFrame = 3;
      sample.playing = stream.playing = true;
      sample.pitch = stream.pitch = pitch;
      sample.pan = stream.pan = -0.4F;
      sample.volume = stream.volume = 0.7F;
      sample.gain = stream.gain = 0.9F;
      sample.targetGain = stream.targetGain = 0.3F;
      sample.gainStep = stream.gainStep = -0.01F;
      sample.duration = stream.duration = static_cast<double>(asset->samples.size() / 2) / 48000;
      sample.loop = stream.loop = loop;
      sample.loopStart = stream.loopStart = 4;
      sample.loopEnd = stream.loopEnd = 12;
      stream.eof = true;
      for (int position = 3, count = 0; count < 512; ++count, ++position) {
        if (loop && position >= 12) position = 4;
        if (!loop && position >= 16) break;
        stream.samples.push_back(asset->samples[position * 2]);
        stream.samples.push_back(asset->samples[position * 2 + 1]);
      }
      std::vector<float> sampleOutput(100, 0), streamOutput(100, 0);
      pmjs::mixVoiceInto(sample, sampleOutput.data(), 50, 0.8F);
      pmjs::mixVoiceInto(stream, streamOutput.data(), 50, 0.8F);
      for (std::size_t i = 0; i < sampleOutput.size(); ++i)
        CHECK(near(sampleOutput[i], streamOutput[i]), "sample matches streaming interpolation/fade/pan");
      CHECK(sample.playing == stream.playing, "sample and stream completion agree");
      CHECK(sample.positionFrame == stream.positionFrame, "sample and stream final positions agree");
    }
  }
  pmjs::VoiceMixState left, right;
  left.asset = right.asset = asset;
  left.playing = right.playing = true;
  left.pan = -1; right.pan = 1;
  left.pitch = 0.5F; right.pitch = 2;
  left.positionFrame = 2; right.positionFrame = 5;
  std::vector<float> output(2, 0);
  pmjs::mixVoiceInto(left, output.data(), 1, 1);
  pmjs::mixVoiceInto(right, output.data(), 1, 1);
  CHECK(near(output[0], 0.06F) && near(output[1], -0.10F), "shared asset voices overlap independently");
  CHECK(left.positionFrame == 2 && right.positionFrame == 7, "independent sample phases");
  left.gain = 0.1F; left.targetGain = 0; left.gainStep = -0.1F; left.stopAfterFade = true;
  pmjs::mixVoiceInto(left, output.data(), 1, 1);
  CHECK(!left.playing && right.playing, "sample fade does not stop another voice");
  for (std::uint64_t start : {0U, 4U}) {
    pmjs::VoiceMixState whole;
    whole.asset = asset; whole.playing = whole.loop = true;
    whole.positionFrame = 15; whole.loopStart = start;
    whole.duration = 15.5 / 48000;
    std::vector<float> wrapped(4, 0);
    pmjs::mixVoiceInto(whole, wrapped.data(), 2, 1);
    CHECK(near(wrapped[0], 0.45F) && near(wrapped[2], start * 0.03F),
      "sample loops at PCM end and honors a start-only loop point");
    CHECK(whole.positionFrame == start + 1, "sample loop cursor matches samples");
  }
}

void testPreparedHighPitchEof() {
  auto asset = std::make_shared<pmjs::PreparedAudioAsset>();
  asset->samples.resize(200, 0.25F);
  for (float pitch : {2.0F, 8.0F}) {
    for (std::uint64_t position : {96U, 98U}) {
      pmjs::VoiceMixState sample, stream;
      sample.asset = asset;
      sample.playing = stream.playing = true;
      sample.positionFrame = stream.positionFrame = position;
      sample.pitch = stream.pitch = pitch;
      stream.eof = true;
      stream.samples.assign(asset->samples.begin() + position * 2, asset->samples.end());
      for (int frame = 0; frame < 5; ++frame) {
        float actual[2]{}, expected[2]{};
        pmjs::mixVoiceInto(sample, actual, 1, 1);
        pmjs::mixVoiceInto(stream, expected, 1, 1);
        CHECK(near(actual[0], expected[0]) && near(actual[1], expected[1]), "EOF sample output parity");
        CHECK(sample.positionFrame == stream.positionFrame && sample.positionFrame <= 100,
          "high-pitch EOF position is bounded and matches streaming");
        CHECK(sample.playing == stream.playing && sample.phase == stream.phase,
          "high-pitch EOF playing state and residual phase match streaming");
      }
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::string_view(argv[1]) == "--mz-gain-reference") {
    auto voice = constantVoice(16, 0.5F, 0.5F);
    voice.gain = 0.2F; voice.targetGain = 0.8F; voice.gainStep = 0.15F; voice.absoluteGainEnvelope = true;
    float output[10]{};
    pmjs::mixVoiceInto(voice, output, 5, 1);
    std::cout << std::setprecision(9) << '[';
    for (int i = 0; i < 5; ++i) { if (i) std::cout << ','; std::cout << output[i * 2]; }
    std::cout << "]\n";
    return 0;
  }
  if (argc == 2 && std::string_view(argv[1]) == "--mz-pan-reference") {
    std::cout << std::setprecision(9) << '[';
    bool first = true;
    for (int channels : {1, 2}) for (float pan : {-1.0F, -0.75F, -0.5F, -0.25F, 0.0F, 0.25F, 0.5F, 0.75F, 1.0F}) {
      auto voice = constantVoice(4, channels == 1 ? 0.5F / std::sqrt(2.0F) : 0.25F,
        channels == 1 ? 0.5F / std::sqrt(2.0F) : 0.5F);
      voice.panMatrix = pmjs::equalPowerPanMatrix(channels, pan);
      float output[2]{};
      pmjs::mixVoiceInto(voice, output, 1, 1);
      if (!first) std::cout << ',';
      first = false;
      std::cout << "[" << channels << ',' << pan << ',' << output[0] << ',' << output[1] << "]";
    }
    std::cout << "]\n";
    return 0;
  }
  testVolumeAndMaster();
  testPanLaw();
  testMzEqualPowerPan();
  testSpatialEffects();
  testPitchAdvancement();
  testFadeCompletionAndStopAfterFade();
  testGainRampPrecision();
  testLoopWrap();
  testDurationWrapWithoutLoopPoints();
  testSimultaneousVoicesAccumulate();
  testEofAndPaused();
  testPreparedSampleParity();
  testPreparedHighPitchEof();
  if (failures == 0) std::cout << "media-mix unit tests passed\n";
  return failures == 0 ? 0 : 1;
}

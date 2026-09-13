#include "media_mix.hpp"

#include <cmath>
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

}  // namespace

int main() {
  testVolumeAndMaster();
  testPanLaw();
  testPitchAdvancement();
  testFadeCompletionAndStopAfterFade();
  testLoopWrap();
  testDurationWrapWithoutLoopPoints();
  testSimultaneousVoicesAccumulate();
  testEofAndPaused();
  if (failures == 0) std::cout << "media-mix unit tests passed\n";
  return failures == 0 ? 0 : 1;
}

#pragma once

// Shared sample math for the real-time callback and deterministic unit tests.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>

namespace pmjs {

struct VoiceMixState {
  std::deque<float> samples;  // interleaved stereo frames
  double phase = 0;
  std::uint64_t positionFrame = 0;
  float volume = 1.0F, pitch = 1.0F, pan = 0.0F;
  float gain = 1.0F, targetGain = 1.0F, gainStep = 0.0F;
  bool stopAfterFade = false, playing = false, loop = false, eof = false;
  std::uint64_t loopStart = 0, loopEnd = 0;
  double duration = 0;
};

inline void mixVoiceInto(VoiceMixState& voice, float* output, int frames,
                         float master) {
  if (!voice.playing) return;
  for (int frame = 0; frame < frames; ++frame) {
    if (voice.samples.size() < 4) {
      if (voice.eof) voice.playing = false;
      break;
    }
    if (voice.gainStep != 0) {
      const float next = voice.gain + voice.gainStep;
      if ((voice.gainStep > 0 && next >= voice.targetGain) ||
          (voice.gainStep < 0 && next <= voice.targetGain)) {
        voice.gain = voice.targetGain;
        voice.gainStep = 0;
        if (voice.stopAfterFade && voice.gain <= 0) {
          voice.playing = false;
          break;
        }
      } else {
        voice.gain = next;
      }
    }
    const float fraction = static_cast<float>(voice.phase);
    const float left =
        voice.samples[0] * (1 - fraction) + voice.samples[2] * fraction;
    const float right =
        voice.samples[1] * (1 - fraction) + voice.samples[3] * fraction;
    const float leftGain =
        voice.volume * voice.gain * (voice.pan > 0 ? 1 - voice.pan : 1);
    const float rightGain =
        voice.volume * voice.gain * (voice.pan < 0 ? 1 + voice.pan : 1);
    output[frame * 2] += left * leftGain * master;
    output[frame * 2 + 1] += right * rightGain * master;
    voice.phase += voice.pitch;
    while (voice.phase >= 1 && voice.samples.size() >= 2) {
      voice.samples.pop_front();
      voice.samples.pop_front();
      voice.phase -= 1;
      ++voice.positionFrame;
      if (voice.loop && voice.loopEnd > voice.loopStart &&
          voice.positionFrame >= voice.loopEnd)
        voice.positionFrame = voice.loopStart;
      else if (voice.loop && voice.duration > 0 &&
               voice.positionFrame >=
                   static_cast<std::uint64_t>(voice.duration * 48000))
        voice.positionFrame = 0;
    }
  }
}

inline void clampStereoMix(float* output, int frames) {
  for (int index = 0; index < frames * 2; ++index)
    output[index] = std::clamp(output[index], -1.0F, 1.0F);
}

}  // namespace pmjs

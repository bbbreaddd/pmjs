#pragma once

// Shared sample math for the real-time callback and deterministic unit tests.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include "media_decoder.hpp"

namespace pmjs {

struct PreparedAudioAsset : DecodedAudio {
  double sourceDuration = 0;
};

struct VoiceMixState {
  std::shared_ptr<const PreparedAudioAsset> asset;
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
    std::uint64_t nextSampleFrame = voice.positionFrame + 1;
    if (voice.asset) {
      const auto length = voice.asset->samples.size() / 2;
      const auto end = voice.loop && voice.loopEnd > voice.loopStart
        ? voice.loopEnd : length;
      if (voice.loop && nextSampleFrame >= end) nextSampleFrame = voice.loopStart;
      if (voice.positionFrame >= length || nextSampleFrame >= length) {
        voice.playing = false;
        break;
      }
    } else if (voice.samples.size() < 4) {
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
    const auto sample = [&](int channel, bool next) {
      if (voice.asset) return voice.asset->samples[
        (next ? nextSampleFrame : voice.positionFrame) * 2 + channel];
      return voice.samples[(next ? 2 : 0) + channel];
    };
    const float left = sample(0, false) * (1 - fraction) + sample(0, true) * fraction;
    const float right = sample(1, false) * (1 - fraction) + sample(1, true) * fraction;
    const float leftGain =
        voice.volume * voice.gain * (voice.pan > 0 ? 1 - voice.pan : 1);
    const float rightGain =
        voice.volume * voice.gain * (voice.pan < 0 ? 1 + voice.pan : 1);
    output[frame * 2] += left * leftGain * master;
    output[frame * 2 + 1] += right * rightGain * master;
    voice.phase += voice.pitch;
    while (voice.phase >= 1 && (voice.asset
        ? (voice.loop || voice.positionFrame < voice.asset->samples.size() / 2)
        : voice.samples.size() >= 2)) {
      if (!voice.asset) {
        voice.samples.pop_front();
        voice.samples.pop_front();
      }
      voice.phase -= 1;
      ++voice.positionFrame;
      if (voice.asset && voice.loop && voice.positionFrame >=
          (voice.loopEnd > voice.loopStart ? voice.loopEnd : voice.asset->samples.size() / 2))
        voice.positionFrame = voice.loopStart;
      else if (voice.loop && voice.loopEnd > voice.loopStart &&
          voice.positionFrame >= voice.loopEnd)
        voice.positionFrame = voice.loopStart;
      else if (voice.loop && voice.duration > 0 &&
               voice.positionFrame >= (voice.asset ? voice.asset->samples.size() / 2
                 : static_cast<std::uint64_t>(voice.duration * 48000)))
        voice.positionFrame = 0;
    }
  }
}

inline void clampStereoMix(float* output, int frames) {
  for (int index = 0; index < frames * 2; ++index)
    output[index] = std::clamp(output[index], -1.0F, 1.0F);
}

}  // namespace pmjs

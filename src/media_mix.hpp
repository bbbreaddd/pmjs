#pragma once

// Shared sample math for the real-time callback and deterministic unit tests.

#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include "media_decoder.hpp"

namespace pmjs {

struct PreparedAudioAsset : DecodedAudio {
  double sourceDuration = 0;
  int sourceChannels = 0;
};

struct VoiceMixState {
  std::shared_ptr<const PreparedAudioAsset> asset;
  std::deque<float> samples;  // interleaved stereo frames
  double phase = 0;
  std::uint64_t positionFrame = 0;
  float volume = 1.0F, pitch = 1.0F, pan = 0.0F;
  float leftGain = 1.0F, rightGain = 1.0F;
  std::array<float, 4> panMatrix{1, 0, 0, 1};
  double gain = 1, targetGain = 1, gainStep = 0;
  bool absoluteGainEnvelope = false;
  bool stopAfterFade = false, playing = false, loop = false, eof = false;
  bool suspended = false;
  std::uint64_t loopStart = 0, loopEnd = 0;
  double duration = 0;
};

inline std::array<float, 4> equalPowerPanMatrix(int channels, float position) {
  position = std::clamp(position, -1.0F, 1.0F);
  const float halfPi = std::numbers::pi_v<float> / 2;
  const float pan = std::atan2(position, 1 - std::abs(position)) / halfPi;
  if (channels == 1) {
    // Decoding duplicates mono at -3 dB; recover its amplitude before panning.
    const float angle = (pan + 1) * halfPi / 2;
    return {std::sqrt(2.0F) * std::cos(angle), 0, 0, std::sqrt(2.0F) * std::sin(angle)};
  }
  const float angle = (pan <= 0 ? pan + 1 : pan) * halfPi;
  return pan <= 0 ? std::array<float, 4>{1, std::cos(angle), 0, std::sin(angle)} :
                    std::array<float, 4>{std::cos(angle), 0, std::sin(angle), 1};
}

inline void mixVoiceInto(VoiceMixState& voice, float* output, int frames,
                         float master) {
  if (!voice.playing || voice.suspended) return;
  const auto advanceGain = [&voice]() {
    if (voice.gainStep != 0) {
      const double next = voice.gain + voice.gainStep;
      if ((voice.gainStep > 0 && next >= voice.targetGain) ||
          (voice.gainStep < 0 && next <= voice.targetGain)) {
        voice.gain = voice.targetGain;
        voice.gainStep = 0;
        if (voice.stopAfterFade && voice.gain <= 0) {
          voice.playing = false;
          return;
        }
      } else {
        voice.gain = next;
      }
    }
  };
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
    if (!voice.absoluteGainEnvelope) advanceGain();
    if (!voice.playing) break;
    const float fraction = static_cast<float>(voice.phase);
    const auto sample = [&](int channel, bool next) {
      if (voice.asset) return voice.asset->samples[
        (next ? nextSampleFrame : voice.positionFrame) * 2 + channel];
      return voice.samples[(next ? 2 : 0) + channel];
    };
    const float left = sample(0, false) * (1 - fraction) + sample(0, true) * fraction;
    const float right = sample(1, false) * (1 - fraction) + sample(1, true) * fraction;
    const float leftGain =
        voice.volume * voice.gain * voice.leftGain * (voice.pan > 0 ? 1 - voice.pan : 1);
    const float rightGain =
        voice.volume * voice.gain * voice.rightGain * (voice.pan < 0 ? 1 + voice.pan : 1);
    output[frame * 2] += (left * voice.panMatrix[0] + right * voice.panMatrix[1]) * leftGain * master;
    output[frame * 2 + 1] += (left * voice.panMatrix[2] + right * voice.panMatrix[3]) * rightGain * master;
    if (voice.absoluteGainEnvelope) advanceGain();
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

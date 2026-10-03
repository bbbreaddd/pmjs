#include "media_service.hpp"
#include "media_mix.hpp"
#include "effects_audio.hpp"
#include <SDL.h>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {
void require(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(message);
}
std::vector<std::uint8_t> wav(int frames, std::uint16_t sample = 4000, int channels = 2) {
  std::vector<std::uint8_t> bytes(44 + frames * channels * 2);
  auto word = [&](int offset, std::uint32_t value, int count) {
    for (int i = 0; i < count; ++i) bytes[offset + i] = value >> (i * 8);
  };
  auto text = [&](int offset, const char* value) {
    for (int i = 0; i < 4; ++i) bytes[offset + i] = value[i];
  };
  text(0, "RIFF"); word(4, bytes.size() - 8, 4); text(8, "WAVE");
  text(12, "fmt "); word(16, 16, 4); word(20, 1, 2); word(22, channels, 2);
  word(24, 48000, 4); word(28, 48000 * channels * 2, 4); word(32, channels * 2, 2); word(34, 16, 2);
  text(36, "data"); word(40, frames * channels * 2, 4);
  for (int i = 44; i < static_cast<int>(bytes.size()); i += 2) word(i, sample, 2);
  return bytes;
}
void write(const std::filesystem::path& path, const std::vector<std::uint8_t>& bytes) {
  std::ofstream file(path, std::ios::binary);
  file.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
}
}
int main() {
  SDL_setenv("SDL_AUDIODRIVER", "dummy", 1);
  SDL_setenv("PMJS_AUDIO_DIAGNOSTICS", "1", 1);
  if (SDL_Init(SDL_INIT_AUDIO) != 0) return 2;
  const auto root = std::filesystem::temp_directory_path() /
    ("pmjs-audio-assets-" + std::to_string(SDL_GetPerformanceCounter()));
  std::filesystem::create_directories(root);
  try {
    const auto bytes = wav(4800);
    for (const int channels : {1, 2}) {
      const auto name = root / (channels == 1 ? "mono.wav" : "stereo.wav");
      write(name, wav(64, 8192, channels));
      const auto decoded = pmjs::MediaDecoder::decodeAudio(name);
      require(decoded && decoded->samples.size() >= 8, "spatial PCM fixture decodes");
      pmjs::AudioDecoderSession streaming(name);
      const auto samples = streaming.read(4);
      require(samples.size() == 8, "spatial PCM fixture streams");
      for (const bool stream : {false, true}) {
        pmjs::VoiceMixState voice;
        voice.playing = true;
        const auto& input = stream ? samples : decoded->samples;
        voice.samples.assign(input.begin(), input.end());
        const auto gains = pmjs::spatialEffectGains(channels, -1, 0, 0);
        voice.leftGain = gains[0]; voice.rightGain = gains[1];
        float output[2]{};
        pmjs::mixVoiceInto(voice, output, 1, 1);
        require(std::abs(output[0] - 0.25F) < 1e-5F &&
          std::abs(output[1] - (channels == 1 ? 0.0F : 0.25F)) < 1e-5F,
          "prepared and streaming decoders preserve spatial source amplitude");
      }
    }
    write(root / "a.wav", bytes); write(root / "b.wav", bytes);
    write(root / "c.wav", bytes);
    SDL_setenv("PMJS_AUDIO_DIAGNOSTICS", "0", 1);
    {
      pmjs::MediaService ordinary(root);
      const auto handle = ordinary.loadAudio("a.wav");
      require(ordinary.setStereoGains(handle, 1.41421356F, 0) &&
        !ordinary.setStereoGains(handle, -1, 1) &&
        !ordinary.setStereoGains(handle, std::numeric_limits<float>::infinity(), 1) &&
        !ordinary.setStereoGains(handle, 1, std::numeric_limits<float>::quiet_NaN()) &&
        !ordinary.setStereoGains(0, 1, 1) && ordinary.setStereoGains(handle, 1, 1),
        "stereo gains accept amplification and reject invalid coefficients or handles");
      require(handle && ordinary.play(handle, true, 0), "ordinary native loads stream");
      SDL_Delay(40);
      const auto normal = ordinary.audioCacheStats();
      require(!normal.diagnostics && normal.streamVoices == 1 &&
        normal.workerDecodeCalls == 0 && normal.workerDecodeUs == 0 && normal.workerCpuUs == 0,
        "normal playback must not accumulate worker timing instrumentation");
      require(ordinary.position(handle) > 0, "uninstrumented streaming still advances");
      ordinary.release(handle);
    }
    SDL_setenv("PMJS_AUDIO_DIAGNOSTICS", "1", 1);
    pmjs::MediaService media(root);
    const pmjs::AudioLoadOptions sample{pmjs::AudioIntent::effect, {}, {}};
    std::string error;
    const auto beforeUnique = media.audioCacheStats();
    for (int index = 0; index < 12; ++index) {
      const auto name = "unique-" + std::to_string(index) + ".wav";
      write(root / name, wav(96000, 4000 + index));
      const auto handle = media.loadAudio(name, &error, sample);
      require(handle && media.bufferedFrames(handle) == 0, "cold medium SE stays streamed");
      media.release(handle);
    }
    auto afterUnique = media.audioCacheStats();
    require(afterUnique.preparations == beforeUnique.preparations &&
      afterUnique.streamLoads == beforeUnique.streamLoads + 12 && afterUnique.cacheBytes == 0,
      "unique SE workload must not fill the cache or prepare PCM on main thread");
    for (auto intent : {pmjs::AudioIntent::unknown, pmjs::AudioIntent::music,
                        pmjs::AudioIntent::ambient, pmjs::AudioIntent::jingle}) {
      const auto handle = media.loadAudio("a.wav", &error, {intent, {}, {}});
      require(handle && media.audioCacheStats().sampleVoices == 0,
        "unhinted and non-effect native audio must stream");
      media.release(handle);
    }
    const auto beforeAnonymous = media.audioCacheStats();
    const auto anonymous = media.loadAudioBytes(bytes, &error, sample);
    require(anonymous && media.audioCacheStats().preparations == beforeAnonymous.preparations,
      "anonymous bytes must stream even with effect intent");
    media.release(anonymous);
    auto first = media.loadAudio("a.wav", &error, sample);
    auto second = media.loadAudio("a.wav", &error, sample);
    require(first && second && first != second, "independent handles required");
    auto stats = media.audioCacheStats();
    require(stats.preparations == 1 && stats.hits == 1 && stats.livePcmBytes == 38400,
      "two voices must share one prepared PCM allocation");
    require(media.setParameters(first, 0.2F, 0.5F, -1) &&
      media.setParameters(second, 0.8F, 2, 1), "independent parameters");
    require(media.play(first, true, 0.025) && media.play(second, true, 0.05), "play samples");
    require(media.stop(first) && !media.isPlaying(first) && media.isPlaying(second),
      "stopping one voice must not stop the other");
    media.setPreparedAudioPolicyForTesting({0, 2 * 1024 * 1024, 256 * 1024});
    stats = media.audioCacheStats();
    require(stats.cacheBytes == 0 && stats.livePcmBytes == 38400 && media.isPlaying(second),
      "eviction must retain voice-owned PCM");
    SDL_Delay(40);
    require(media.isPlaying(second) && media.position(second) != 0.05,
      "evicted sample must continue advancing");
    require(media.audioCacheStats().workerDecodeCalls == 0, "samples must bypass decoder worker");
    media.release(first); media.release(second);
    require(media.audioCacheStats().livePcmBytes == 0, "last voice releases evicted PCM");

    media.setPreparedAudioPolicyForTesting({38400, 38400, 256 * 1024});
    auto a = media.loadAudio("a.wav", &error, sample);
    auto b = media.loadAudio("b.wav", &error, sample);
    auto again = media.loadAudio("a.wav", &error, sample);
    stats = media.audioCacheStats();
    require(a && b && again && stats.preparations == 4 && stats.entries == 1 &&
      stats.cacheBytes <= 38400 && stats.livePcmBytes == 115200, "byte LRU and pinned assets");
    media.release(a); media.release(b); media.release(again);
    media.setPreparedAudioPolicyForTesting({0, 0, 256 * 1024});
    require(media.sampleMemoryBytes() == 0, "eviction and release settle memory");

    media.setPreparedAudioPolicyForTesting({76800, 38400, 256 * 1024});
    auto hot = media.loadAudio("a.wav", &error, sample);
    auto cold = media.loadAudio("b.wav", &error, sample);
    auto touched = media.loadAudio("a.wav", &error, sample);
    auto newest = media.loadAudio("c.wav", &error, sample);
    const auto afterLru = media.audioCacheStats();
    auto kept = media.loadAudio("a.wav", &error, sample);
    auto evicted = media.loadAudio("b.wav", &error, sample);
    require(kept && evicted && media.audioCacheStats().hits == afterLru.hits + 1 &&
      media.audioCacheStats().preparations == afterLru.preparations + 1,
      "byte LRU must evict the untouched asset");
    for (auto handle : {hot, cold, touched, newest, kept, evicted}) media.release(handle);
    media.setPreparedAudioPolicyForTesting({0, 0, 256 * 1024});
    media.setPreparedAudioPolicyForTesting({16 * 1024 * 1024, 2 * 1024 * 1024, 256 * 1024});
    pmjs::AudioLoadOptions blob{pmjs::AudioIntent::effect, "blob:one", {}};
    auto fromBytes = media.loadAudioBytes(bytes, &error, blob);
    auto sameBytes = media.loadAudioBytes(bytes, &error, blob);
    const auto beforeChanged = media.audioCacheStats();
    blob.resourceIdentity = "blob:two";
    auto changedBytes = media.loadAudioBytes(wav(4800, 8000), &error, blob);
    require(fromBytes && sameBytes && changedBytes &&
      media.audioCacheStats().preparations == beforeChanged.preparations + 1,
      "different immutable blob resources must not alias");
    require(media.audioCacheStats().cacheBytes == 76800, "identified bytes retain only two PCM assets");
    media.release(fromBytes); media.release(sameBytes); media.release(changedBytes);

    auto original = media.loadAudio("a.wav", &error, sample);
    write(root / "replacement.wav", wav(9600));
    std::filesystem::rename(root / "replacement.wav", root / "a.wav");
    auto replacement = media.loadAudio("a.wav", &error, sample);
    require(original && replacement && media.duration(original) != media.duration(replacement),
      "effective replacement resource must not alias retained sample");
    media.release(original); media.release(replacement);

    media.setPreparedAudioPolicyForTesting({16 * 1024 * 1024, 1024, 256 * 1024});
    auto longSound = media.loadAudio("a.wav", &error, sample);
    require(longSound && media.audioCacheStats().streamVoices == 1, "over-limit audio streams");
    media.play(longSound, true, 0);
    SDL_Delay(40);
    require(media.bufferedFrames(longSound) <= 48000, "stream buffer remains bounded");
    require(media.audioCacheStats().workerDecodeCalls > 0, "stream uses worker");
    media.stop(longSound); media.release(longSound);
    require(!media.loadAudioBytes({1, 2, 3, 4}, &error, blob), "bad bytes must fail");
    media.setPreparedAudioPolicyForTesting({16 * 1024 * 1024, 2 * 1024 * 1024, 256 * 1024});
    auto recovered = media.loadAudioBytes(bytes, &error, blob);
    require(recovered != 0, "failed load must not poison later preparation");
    media.release(recovered);
    media.setPreparedAudioPolicyForTesting({0, 0, 256 * 1024});
    require(media.sampleMemoryBytes() == 0, "all sample memory settles");
    media.setPreparedAudioPolicyForTesting({16 * 1024 * 1024, 2 * 1024 * 1024, 1024 * 1024});
    auto promoted = media.loadAudio("unique-0.wav", &error, sample);
    require(promoted && media.audioCacheStats().sampleVoices == 1,
      "explicitly raised sync ceiling permits medium preparation");
    media.setPreparedAudioPolicyForTesting({16 * 1024 * 1024, 2 * 1024 * 1024, 0});
    auto retained = media.loadAudio("unique-0.wav", &error, sample);
    auto uncached = media.loadAudio("unique-1.wav", &error, sample);
    require(retained && uncached && media.audioCacheStats().sampleVoices == 2 &&
      media.audioCacheStats().streamVoices == 1,
      "sync ceiling limits cold preparation without invalidating retained assets");
    media.release(promoted); media.release(retained); media.release(uncached);
    media.setPreparedAudioPolicyForTesting({0, 0, 256 * 1024});
    require(media.sampleMemoryBytes() == 0, "medium retained PCM settles after eviction");
    std::filesystem::remove_all(root);
    std::cout << "audio asset ownership tests passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    std::filesystem::remove_all(root);
    SDL_Quit();
    return 1;
  }
  SDL_Quit();
}

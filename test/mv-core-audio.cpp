#include "mv_core_audio_graphics.hpp"
#include "mv_core_utils.hpp"
#include "mv_engine.hpp"
#include "mv_managers.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using pmjs::mv::AudioManager;
using pmjs::mv::Session;
using pmjs::mv::Value;
using pmjs::mv::core::Html5Audio;
using pmjs::mv::core::WebAudio;
using Array = Value::Array;
using Object = Value::Object;

namespace {
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

bool approx(double a, double b, double eps = 1e-6) {
  return std::abs(a - b) <= eps;
}

void pushU32LE(std::vector<std::uint8_t>& out, std::uint32_t value) {
  out.push_back(static_cast<std::uint8_t>(value & 0xff));
  out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xff));
  out.push_back(static_cast<std::uint8_t>((value >> 16) & 0xff));
  out.push_back(static_cast<std::uint8_t>((value >> 24) & 0xff));
}

void pushU32BE(std::vector<std::uint8_t>& out, std::uint32_t value) {
  out.push_back(static_cast<std::uint8_t>((value >> 24) & 0xff));
  out.push_back(static_cast<std::uint8_t>((value >> 16) & 0xff));
  out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xff));
  out.push_back(static_cast<std::uint8_t>(value & 0xff));
}

std::vector<std::uint8_t> buildSyntheticOgg(std::uint32_t sampleRate, const std::string& commentBody) {
  std::vector<std::uint8_t> idPacket(12, 0);
  idPacket[0] = 1;
  std::copy_n("vorbis", 6, idPacket.begin() + 1);
  pushU32LE(idPacket, sampleRate);
  idPacket.resize(30, 0);

  std::vector<std::uint8_t> commentPacket(7 + commentBody.size() + 1, 0);
  commentPacket[0] = 3;
  std::copy_n("vorbis", 6, commentPacket.begin() + 1);
  std::copy(commentBody.begin(), commentBody.end(), commentPacket.begin() + 7);
  commentPacket.back() = 0;

  std::vector<std::uint8_t> ogg;
  ogg.insert(ogg.end(), {'O', 'g', 'g', 'S'});
  ogg.resize(26, 0);
  ogg.push_back(2);
  ogg.push_back(static_cast<std::uint8_t>(idPacket.size()));
  ogg.push_back(static_cast<std::uint8_t>(commentPacket.size()));
  ogg.insert(ogg.end(), idPacket.begin(), idPacket.end());
  ogg.insert(ogg.end(), commentPacket.begin(), commentPacket.end());
  return ogg;
}

std::vector<std::uint8_t> buildSyntheticMp4(std::uint32_t timescale, const std::string& udtaPayload) {
  auto makeBox = [](const char tag[4], const std::vector<std::uint8_t>& body) {
    std::vector<std::uint8_t> box;
    pushU32BE(box, static_cast<std::uint32_t>(8 + body.size()));
    box.insert(box.end(), tag, tag + 4);
    box.insert(box.end(), body.begin(), body.end());
    return box;
  };
  std::vector<std::uint8_t> mvhdBody(24, 0);
  mvhdBody[12] = static_cast<std::uint8_t>((timescale >> 24) & 0xff);
  mvhdBody[13] = static_cast<std::uint8_t>((timescale >> 16) & 0xff);
  mvhdBody[14] = static_cast<std::uint8_t>((timescale >> 8) & 0xff);
  mvhdBody[15] = static_cast<std::uint8_t>(timescale & 0xff);
  const auto mvhd = makeBox("mvhd", mvhdBody);
  const auto udta = makeBox("udta", std::vector<std::uint8_t>(udtaPayload.begin(), udtaPayload.end()));
  std::vector<std::uint8_t> moovBody = mvhd;
  moovBody.insert(moovBody.end(), udta.begin(), udta.end());
  const auto ftyp = makeBox("ftyp", {'M', '4', 'A', ' '});
  const auto moov = makeBox("moov", moovBody);
  std::vector<std::uint8_t> mp4 = ftyp;
  mp4.insert(mp4.end(), moov.begin(), moov.end());
  return mp4;
}
}  // namespace

int main() try {
  require(!WebAudio::initialize(false), "unbound WebAudio initialize returns false");
  WebAudio::setMasterVolume(1.5);
  require(WebAudio::masterVolume == 1.0, "masterVolume clamps high");
  WebAudio::setMasterVolume(-0.25);
  require(WebAudio::masterVolume == 0.0, "masterVolume clamps low");
  WebAudio::setMasterVolume(1.0);
  WebAudio::setEncryptionKey("000102030405060708090a0b0c0d0e0f");

  WebAudio empty;
  require(!empty.isReady() && !empty.isPlaying() && empty.seek() == 0.0 && empty.playbackPosition() == 0.0,
          "default WebAudio starts stopped and zeroed");
  WebAudio unbound("audio/se/Cursor.ogg");
  require(!unbound.isReady() && !unbound.isPlaying() && unbound.seek() == 0.0,
          "unbound non-empty WebAudio degrades without throwing");
  unbound.fadeOut(0.5);

  Html5Audio::initialize();
  Html5Audio::setStaticSe("audio/se/Cursor.ogg");
  Html5Audio::setup("audio/bgm/Theme.ogg");
  require(!Html5Audio::isReady() && !Html5Audio::isPlaying() && Html5Audio::seek() == 0.0,
          "unbound Html5Audio degrades cleanly");
  Html5Audio::clear();

  {
    using namespace std::string_literals;
    WebAudio ogg;
    const auto bytes = buildSyntheticOgg(44100, "LOOPSTART=44100\0LOOPLENGTH=88200"s);
    ogg.readLoopComments(bytes);
    require(ogg.sampleRate == 44100 && approx(ogg.loopStart, 1.0) && approx(ogg.loopLength, 2.0),
            "readLoopComments scales Ogg loop tags by sample rate");
  }

  {
    using namespace std::string_literals;
    WebAudio oggMissingLength;
    const auto bytes = buildSyntheticOgg(44100, "LOOPSTART=44100\0ARTIST=Test"s);
    oggMissingLength.readLoopComments(bytes);
    require(oggMissingLength.loopStart == 0.0 && oggMissingLength.loopLength == 0.0,
            "missing LOOPLENGTH resets loopStart instead of keeping raw samples");
  }

  {
    using namespace std::string_literals;
    WebAudio mp4;
    const auto bytes = buildSyntheticMp4(48000, "LOOPSTART=48000\0LOOPLENGTH=96000"s);
    mp4.readLoopComments(bytes);
    require(mp4.sampleRate == 48000 && approx(mp4.loopStart, 1.0) && approx(mp4.loopLength, 2.0),
            "readLoopComments parses MP4 mvhd timescale and udta loop tags");
  }

  {
    std::vector<std::uint8_t> endian{0x01, 0x02, 0x03, 0x04};
    require(WebAudio::readLittleEndian(endian, 0) == 0x04030201U, "readLittleEndian");
    require(WebAudio::readBigEndian(endian, 0) == 0x01020304U, "readBigEndian");
    require(WebAudio::readFourCharacters(endian, 1) == "", "readFourCharacters bounds check");
  }

  Value db = Object{
    {"system", Object{{"startMapId", 1}, {"startX", 1}, {"startY", 1}, {"partyMembers", Array{1}},
                      {"sounds", Array{Object{{"name", "Cursor"}, {"volume", 85}, {"pitch", 100}, {"pan", 0}}}}}},
    {"actors", Array{Value{}, Object{{"classId", 1}, {"initialLevel", 1}}}},
    {"tilesets", Array{Value{}, Object{{"flags", Array{0}}}}},
    {"maps", Object{{"1", Object{{"width", 3}, {"height", 3}, {"tilesetId", 1}, {"data", Array(3 * 3 * 6, 0)}, {"events", Array{}}}}}}
  };
  Session session(db);
  session.newGame();
  const auto bgm = Object{{"name", "Theme"}, {"volume", 90}, {"pitch", 100}, {"pan", 0}};
  AudioManager::playBgm(session, bgm);
  AudioManager::fadeInBgm(session, 2);
  AudioManager::fadeOutMe(session, 1);
  pmjs::mv::SoundManager::playCursor(session);
  const auto& cmds = session.audioCommands();
  require(cmds.size() >= 4 && cmds[cmds.size() - 3]["kind"].text() == "fade-in-bgm" &&
          cmds[cmds.size() - 3]["sound"].integer() == 2 &&
          cmds[cmds.size() - 2]["kind"].text() == "fade-me" && cmds[cmds.size() - 2]["sound"].integer() == 1 &&
          cmds.back()["kind"].text() == "se" && cmds.back()["sound"]["name"].text() == "Cursor",
          "AudioManager and SoundManager queue expected audio commands");

  session.configure(Object{{"bgmVolume", 40}, {"alwaysDash", true}});
  const auto config = session.configuration();
  require(config["bgmVolume"].integer() == 40 && config["bgsVolume"].integer() == 100 &&
          config["meVolume"].integer() == 100 && config["seVolume"].integer() == 100 &&
          config["alwaysDash"].boolean() && !config["commandRemember"].boolean(),
          "Session::configure updates partial settings via ConfigManager while preserving defaults");
  bool rejectedInvalid = false;
  try {
    session.configure(Object{{"seVolume", 101}});
  } catch (const std::invalid_argument&) {
    rejectedInvalid = true;
  }
  require(rejectedInvalid && session.configuration()["seVolume"].integer() == 100,
          "Session::configure rejects out-of-range volume without mutating state");

  AudioManager::stopBgm(session);
  const auto replayed = Object{{"name", "Field"}, {"volume", 80}, {"pitch", 100}, {"pan", 0}, {"pos", 1.5}};
  AudioManager::replayBgm(session, replayed);
  const auto& replayCmds = session.audioCommands();
  require(replayCmds.size() >= 2 &&
          replayCmds[replayCmds.size() - 2]["kind"].text() == "bgm" &&
          approx(replayCmds[replayCmds.size() - 2]["sound"]["pos"].number(), 1.5) &&
          replayCmds.back()["kind"].text() == "fade-in-bgm" &&
          approx(replayCmds.back()["sound"].number(), 0.5),
          "AudioManager::replayBgm starts non-current BGM at pos with 0.5s fade-in");

  Value titledDb = Object{
    {"system", Object{{"startMapId", 1}, {"startX", 1}, {"startY", 1}, {"partyMembers", Array{1}}, {"gameTitle", "Title"}}},
    {"actors", Array{Value{}, Object{{"characterName", "Hero"}, {"characterIndex", 2}, {"faceName", "Faces"}, {"faceIndex", 3}}}},
    {"tilesets", Array{Value{}, Object{{"flags", Array{0}}}}},
    {"maps", Object{{"1", Object{{"width", 3}, {"height", 3}, {"tilesetId", 1}, {"data", Array(3 * 3 * 6, 0)}, {"events", Array{}}}}}}
  };
  Session saveSession(titledDb);
  saveSession.newGame();
  saveSession.setSaveMetadata(Array{
    Value{},
    Object{{"title", "Title"}},
    Object{{"globalId", "RPGMV"}, {"title", "Title"}}
  });
  require(!pmjs::mv::DataManager::isThisGameFile(saveSession, 1, false) &&
          pmjs::mv::DataManager::isThisGameFile(saveSession, 2, false),
          "DataManager::isThisGameFile requires matching globalId when not in local mode");
  auto savedHidden = saveSession.save();
  auto& actorsData = std::get<Array>(std::get<Object>(std::get<Object>(savedHidden.data)["actors"].data)["_data"].data);
  std::get<Object>(actorsData[1].data)["_hidden"] = true;
  saveSession.load(savedHidden);
  const auto saveInfo = pmjs::mv::DataManager::makeSavefileInfo(saveSession);
  require(saveInfo["characters"].array().empty() && saveInfo["faces"].array().empty(),
          "DataManager::makeSavefileInfo excludes hidden actors");

  std::cout << "native MV core audio checks passed\n";
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}

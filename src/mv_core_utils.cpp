#include "mv_core_utils.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <charconv>
#include <filesystem>
#include <limits>
#include <set>
#include <stdexcept>
#include <type_traits>
#include "resources.hpp"

namespace pmjs::mv {

std::string Utils::escapeHtml(const std::string& str) {
  std::string out;
  out.reserve(str.size());
  for (char c : str) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&#39;"; break;
      default: out.push_back(c); break;
    }
  }
  return out;
}

void Spriteset_Base::update(const Session& session) {
  const auto screenTone = session.screenTone();
  for (int i = 0; i < 4; ++i) tone[i] = static_cast<int>(screenTone[i]);
  toneSprite.setTone(tone[0], tone[1], tone[2], tone[3]);
  const auto flashColor = session.screenFlashColor();
  flashSprite.setColor(static_cast<int>(flashColor[0]), static_cast<int>(flashColor[1]), static_cast<int>(flashColor[2]));
  flashSprite.setOpacity(static_cast<int>(flashColor[3]));
  fadeSprite.setOpacity(static_cast<int>(255 - session.screenBrightness()));
}

void Spriteset_Map::update(const Session& session) {
  Spriteset_Base::update(session);
  parallaxOx = session.mapState().parallaxX * 48.0;
  parallaxOy = session.mapState().parallaxY * 48.0;
}

void Spriteset_Battle::update(const Session& session) {
  Spriteset_Base::update(session);
  battleback1Name = session.mapState().battleback1Name.text();
  battleback2Name = session.mapState().battleback2Name.text();
}

bool DataManager::isBattleTest(const Session& session) {
  return !session.database()["testTroopId"].null();
}

bool DataManager::isEventTest(const Session& session) {
  return !session.database()["testEvent"].null();
}

bool DataManager::isSkill(const Value& item) {
  return !item["stypeId"].null();
}

bool DataManager::isItem(const Value& item) {
  return !item["itypeId"].null();
}

bool DataManager::isWeapon(const Value& item) {
  return !item["wtypeId"].null();
}

bool DataManager::isArmor(const Value& item) {
  return !item["atypeId"].null();
}

std::unordered_map<std::string, Value> DataManager::extractMetadata(const std::string& note) {
  std::unordered_map<std::string, Value> meta;
  std::size_t pos = 0;
  while (pos < note.size()) {
    const std::size_t start = note.find('<', pos);
    if (start == std::string::npos) break;
    const std::size_t end = note.find('>', start + 1);
    if (end == std::string::npos) break;
    const std::string inner = note.substr(start + 1, end - start - 1);
    const std::size_t nested = inner.find('<');
    if (nested != std::string::npos) {
      pos = start + 1 + nested;
      continue;
    }
    const std::size_t colon = inner.find(':');
    if (colon != std::string::npos) {
      meta[inner.substr(0, colon)] = Value{inner.substr(colon + 1)};
    } else if (!inner.empty()) {
      meta[inner] = Value{true};
    }
    pos = end + 1;
  }
  return meta;
}

void DataManager::extractMetadata(Value& data) {
  auto* object = std::get_if<Value::Object>(&data.data);
  if (!object) return;
  const auto noteIt = object->find("note");
  Value::Object metaObject;
  if (noteIt != object->end()) {
    for (auto& [key, val] : extractMetadata(noteIt->second.text())) {
      metaObject.emplace(std::move(key), std::move(val));
    }
  }
  (*object)["meta"] = Value{std::move(metaObject)};
}

void DataManager::onLoad(Value& object, bool isMap) {
  if (isMap) {
    extractMetadata(object);
    if (auto* mapObject = std::get_if<Value::Object>(&object.data)) {
      const auto eventsIt = mapObject->find("events");
      if (eventsIt != mapObject->end()) {
        if (auto* events = std::get_if<Value::Array>(&eventsIt->second.data)) {
          for (auto& entry : *events) {
            if (!entry["note"].null()) extractMetadata(entry);
          }
        }
      }
    }
    return;
  }
  if (auto* array = std::get_if<Value::Array>(&object.data)) {
    for (auto& entry : *array) {
      if (!entry["note"].null()) extractMetadata(entry);
    }
  } else if (!object["hasEncryptedImages"].null() || !object["hasEncryptedAudio"].null() ||
             !object["encryptionKey"].null()) {
    Decrypter::readEncryptionkey(object);
  }
}

bool DataManager::isThisGameFile(const Session& session, int savefileId, bool localMode) {
  if (savefileId <= 0 || savefileId >= static_cast<int>(session.saveMetadata_.size())) return false;
  const auto& savefile = session.saveMetadata_[static_cast<std::size_t>(savefileId)];
  if (savefile.null()) return false;
  if (localMode) return true;
  const std::string title = savefile["title"].text();
  if (title != session.database()["system"]["gameTitle"].text()) return false;
  const auto& gid = savefile["globalId"];
  return gid.null() || gid.text() == globalId();
}

bool DataManager::isAnySavefileExists(const Session& session, bool localMode) {
  for (int i = 1; i < static_cast<int>(session.saveMetadata_.size()); ++i) {
    if (isThisGameFile(session, i, localMode)) return true;
  }
  return false;
}

int DataManager::latestSavefileId(const Session& session, bool localMode) {
  int savefileId = 1;
  double timestamp = 0.0;
  for (int i = 1; i < static_cast<int>(session.saveMetadata_.size()); ++i) {
    const auto& info = session.saveMetadata_[static_cast<std::size_t>(i)];
    if (isThisGameFile(session, i, localMode) && info["timestamp"].number() > timestamp) {
      timestamp = info["timestamp"].number();
      savefileId = i;
    }
  }
  return savefileId;
}

int DataManager::lastAccessedSavefileId(const Session& session) {
  return session.lastAccessedSavefileId_;
}

void DataManager::selectSavefileForNewGame(Session& session, bool /*localMode*/) {
  session.lastAccessedSavefileId_ = 1;
  const int numSavefiles = std::max(0, static_cast<int>(session.saveMetadata_.size()) - 1);
  if (numSavefiles == 0) return;
  if (numSavefiles < maxSavefiles()) {
    session.lastAccessedSavefileId_ = numSavefiles + 1;
    return;
  }
  double oldest = std::numeric_limits<double>::max();
  for (int i = 1; i < static_cast<int>(session.saveMetadata_.size()); ++i) {
    const auto& info = session.saveMetadata_[static_cast<std::size_t>(i)];
    if (info.null()) {
      session.lastAccessedSavefileId_ = i;
      break;
    }
    const double ts = info["timestamp"].number();
    if (ts < oldest) {
      oldest = ts;
      session.lastAccessedSavefileId_ = i;
    }
  }
}

Value DataManager::makeSavefileInfo(const Session& session) {
  Value::Array characters;
  Value::Array faces;
  const std::size_t count = std::min<std::size_t>(4, session.party_.size());
  for (std::size_t i = 0; i < count; ++i) {
    const auto actorIt = session.actors_.find(session.party_[i]);
    if (actorIt == session.actors_.end()) continue;
    characters.emplace_back(Value::Array{actorIt->second.characterName, actorIt->second.characterIndex});
    faces.emplace_back(Value::Array{actorIt->second.faceName, actorIt->second.faceIndex});
  }
  const std::uint64_t totalSeconds = session.ticks_ / 60;
  const std::uint64_t hours = totalSeconds / 3600;
  const std::uint64_t minutes = (totalSeconds / 60) % 60;
  const std::uint64_t seconds = totalSeconds % 60;
  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), "%02llu:%02llu:%02llu",
                static_cast<unsigned long long>(hours),
                static_cast<unsigned long long>(minutes),
                static_cast<unsigned long long>(seconds));
  const double nowMs = static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count());
  return Value::Object{
    {"globalId", globalId()},
    {"title", session.database()["system"]["gameTitle"].text()},
    {"characters", std::move(characters)},
    {"faces", std::move(faces)},
    {"playtime", std::string(buffer)},
    {"timestamp", nowMs}
  };
}

std::string ImageManager::generateCacheKey(const std::string& path, int hue) {
  return path + ":" + std::to_string(hue);
}

bool ImageManager::isObjectCharacter(const std::string& filename) {
  for (char c : filename) {
    if (c == '!') return true;
    if (c != '$') break;
  }
  return false;
}

bool ImageManager::isBigCharacter(const std::string& filename) {
  for (char c : filename) {
    if (c == '$') return true;
    if (c != '!') break;
  }
  return false;
}

bool ImageManager::isZeroParallax(const std::string& filename) {
  return !filename.empty() && filename[0] == '!';
}

std::string ImageManager::pathForFolder(const std::string& folder, const std::string& filename) {
  if (filename.empty()) return "";
  return folder + filename + ".png";
}

ImageCache& ImageManager::imageCache() {
  static ImageCache cache;
  return cache;
}

RequestQueue& ImageManager::requestQueue() {
  static RequestQueue queue;
  return queue;
}

std::uint64_t ImageManager::systemReservationId() {
  static const std::uint64_t id = 0x53595354ULL;
  return id;
}

void ImageManager::setDefaultReservationId(std::uint64_t reservationId) {
  defaultReservationId_ = reservationId;
}

std::uint64_t ImageManager::defaultReservationId() {
  return defaultReservationId_;
}

void ImageManager::reserve(const std::string& folder, const std::string& filename, int hue, std::size_t pixelCount, std::uint64_t reservationId) {
  const std::string path = pathForFolder(folder, filename);
  if (path.empty()) {
    if (!imageCache().get("empty")) {
      imageCache().add("empty", 0);
      imageCache().reserve("empty", 0, systemReservationId());
    }
    return;
  }
  const std::string key = generateCacheKey(path, hue);
  if (!imageCache().get(key)) imageCache().add(key, pixelCount);
  imageCache().reserve(key, pixelCount, reservationId ? reservationId : defaultReservationId_);
}

void ImageManager::request(const std::string& folder, const std::string& filename, int hue, std::function<void()> startRequest, std::function<bool()> isRequestReady) {
  const std::string path = pathForFolder(folder, filename);
  if (path.empty()) return;
  const std::string key = generateCacheKey(path, hue);
  if (!imageCache().get(key)) {
    imageCache().add(key, 0);
    if (auto* entry = imageCache().get(key)) entry->requestOnly = true;
    requestQueue().enqueue(key, std::move(startRequest), std::move(isRequestReady));
  } else {
    requestQueue().raisePriority(key);
  }
}

void ImageManager::releaseReservation(std::uint64_t reservationId) {
  imageCache().releaseReservation(reservationId);
}

bool ImageManager::isReady() {
  return imageCache().isReady();
}

void ImageManager::update() {
  requestQueue().update();
}

void ImageManager::clear() {
  imageCache().clear();
}

void ImageManager::clearRequest() {
  requestQueue().clear();
}

namespace {
std::vector<std::string>& staticSeNames() {
  static std::vector<std::string> names;
  return names;
}
Value makeAudioEntry(const Value& sound, double pos) {
  return Value::Object{
    {"name", sound["name"].text()},
    {"volume", sound["volume"].number(90)},
    {"pitch", sound["pitch"].number(100)},
    {"pan", sound["pan"].number(0)},
    {"pos", pos}
  };
}
}

Value AudioManager::makeEmptyAudioObject() {
  return Value::Object{{"name", ""}, {"volume", 0}, {"pitch", 0}, {"pan", 0}, {"pos", 0}};
}

std::string AudioManager::audioFileExt() {
  return ".ogg";
}

bool AudioManager::shouldUseHtml5Audio() {
  return false;
}

int AudioManager::bgmVolume(const Session& session) { return session.volumes_[0]; }
void AudioManager::setBgmVolume(Session& session, int value) {
  session.volumes_[0] = std::clamp(value, 0, 100);
  ++session.configurationRevision_;
}

int AudioManager::bgsVolume(const Session& session) { return session.volumes_[1]; }
void AudioManager::setBgsVolume(Session& session, int value) {
  session.volumes_[1] = std::clamp(value, 0, 100);
  ++session.configurationRevision_;
}

int AudioManager::meVolume(const Session& session) { return session.volumes_[2]; }
void AudioManager::setMeVolume(Session& session, int value) {
  session.volumes_[2] = std::clamp(value, 0, 100);
  ++session.configurationRevision_;
}

int AudioManager::seVolume(const Session& session) { return session.volumes_[3]; }
void AudioManager::setSeVolume(Session& session, int value) {
  session.volumes_[3] = std::clamp(value, 0, 100);
  ++session.configurationRevision_;
}

bool AudioManager::isCurrentBgm(const Session& session, const Value& bgm) {
  const std::string name = bgm["name"].text();
  return !name.empty() && session.savedBgm_["name"].text() == name;
}

void AudioManager::playBgm(Session& session, const Value& bgm) {
  playBgm(session, bgm, bgm["pos"].number(0.0));
}

void AudioManager::playBgm(Session& session, const Value& bgm, double pos) {
  Value entry = makeAudioEntry(bgm, pos);
  if (isCurrentBgm(session, bgm)) {
    updateBgmParameters(session, entry);
    session.savedBgm_ = std::move(entry);
    return;
  }
  stopBgm(session);
  if (!bgm["name"].text().empty()) session.audio("bgm", entry, pos > 0.0);
}

void AudioManager::replayBgm(Session& session, const Value& bgm) {
  if (isCurrentBgm(session, bgm)) {
    updateBgmParameters(session, bgm);
  } else {
    playBgm(session, bgm, bgm["pos"].number(0.0));
  }
}

void AudioManager::updateBgmParameters(Session& session, const Value& bgm) {
  session.audio("bgm", bgm, false);
}

void AudioManager::stopBgm(Session& session) {
  const auto emptyAudio = makeEmptyAudioObject();
  session.audio("bgm", emptyAudio);
}

void AudioManager::fadeOutBgm(Session& session, int durationSeconds) {
  session.savedBgm_ = makeEmptyAudioObject();
  session.audio("fade-bgm", Value{durationSeconds});
}

void AudioManager::fadeInBgm(Session& session, int durationSeconds) {
  (void)durationSeconds;
  if (!session.savedBgm_.null() && !session.savedBgm_["name"].text().empty()) {
    session.audio("bgm", session.savedBgm_, false);
  }
}

bool AudioManager::isCurrentBgs(const Session& session, const Value& bgs) {
  const std::string name = bgs["name"].text();
  return !name.empty() && session.savedBgs_["name"].text() == name;
}

void AudioManager::playBgs(Session& session, const Value& bgs) {
  playBgs(session, bgs, bgs["pos"].number(0.0));
}

void AudioManager::playBgs(Session& session, const Value& bgs, double pos) {
  Value entry = makeAudioEntry(bgs, pos);
  if (isCurrentBgs(session, bgs)) {
    updateBgsParameters(session, entry);
    session.savedBgs_ = std::move(entry);
    return;
  }
  stopBgs(session);
  if (!bgs["name"].text().empty()) session.audio("bgs", entry, pos > 0.0);
}

void AudioManager::replayBgs(Session& session, const Value& bgs) {
  if (isCurrentBgs(session, bgs)) {
    updateBgsParameters(session, bgs);
  } else {
    playBgs(session, bgs, bgs["pos"].number(0.0));
  }
}

void AudioManager::updateBgsParameters(Session& session, const Value& bgs) {
  session.audio("bgs", bgs, false);
}

void AudioManager::stopBgs(Session& session) {
  const auto emptyAudio = makeEmptyAudioObject();
  session.audio("bgs", emptyAudio);
}

void AudioManager::fadeOutBgs(Session& session, int durationSeconds) {
  session.savedBgs_ = makeEmptyAudioObject();
  session.audio("fade-bgs", Value{durationSeconds});
}

void AudioManager::fadeInBgs(Session& session, int durationSeconds) {
  (void)durationSeconds;
  if (!session.savedBgs_.null() && !session.savedBgs_["name"].text().empty()) {
    session.audio("bgs", session.savedBgs_, false);
  }
}

void AudioManager::playMe(Session& session, const Value& me) {
  if (me["name"].text().empty()) {
    stopMe(session);
  } else {
    session.audio("me", me);
  }
}

void AudioManager::updateMeParameters(Session& session, const Value& me) {
  session.audio("me", me, false);
}

void AudioManager::fadeOutMe(Session& session, int /*durationSeconds*/) {
  stopMe(session);
}

void AudioManager::stopMe(Session& session) {
  session.audio("me", makeEmptyAudioObject());
}

void AudioManager::playSe(Session& session, const Value& se) {
  if (!se["name"].text().empty()) session.audio("se", se);
}

void AudioManager::stopSe(Session& session) {
  session.audio("stop-se", Value{});
}

void AudioManager::playStaticSe(Session& session, const Value& se) {
  if (se["name"].text().empty()) return;
  loadStaticSe(se);
  session.audio("se", se);
}

void AudioManager::loadStaticSe(const Value& se) {
  const std::string name = se["name"].text();
  if (!name.empty() && !isStaticSe(se)) staticSeNames().push_back(name);
}

bool AudioManager::isStaticSe(const Value& se) {
  const std::string name = se["name"].text();
  const auto& names = staticSeNames();
  return !name.empty() && std::find(names.begin(), names.end(), name) != names.end();
}

void AudioManager::stopAll(Session& session) {
  stopMe(session);
  stopBgm(session);
  stopBgs(session);
  stopSe(session);
}

Value AudioManager::saveBgm(const Session& session) {
  if (session.savedBgm_.null() || session.savedBgm_["name"].text().empty()) return makeEmptyAudioObject();
  return makeAudioEntry(session.savedBgm_, session.savedBgm_["pos"].number(0));
}

Value AudioManager::saveBgs(const Session& session) {
  if (session.savedBgs_.null() || session.savedBgs_["name"].text().empty()) return makeEmptyAudioObject();
  return makeAudioEntry(session.savedBgs_, session.savedBgs_["pos"].number(0));
}

Value ConfigManager::makeData() const {
  return Value::Object{
    {"alwaysDash", alwaysDash},
    {"commandRemember", commandRemember},
    {"bgmVolume", bgmVolume},
    {"bgsVolume", bgsVolume},
    {"meVolume", meVolume},
    {"seVolume", seVolume}
  };
}

void ConfigManager::applyData(const Value& config) {
  alwaysDash = readFlag(config, "alwaysDash");
  commandRemember = readFlag(config, "commandRemember");
  bgmVolume = readVolume(config, "bgmVolume");
  bgsVolume = readVolume(config, "bgsVolume");
  meVolume = readVolume(config, "meVolume");
  seVolume = readVolume(config, "seVolume");
}

bool ConfigManager::readFlag(const Value& config, const std::string& name) {
  return config[name].boolean();
}

int ConfigManager::readVolume(const Value& config, const std::string& name) {
  const auto& v = config[name];
  if (v.null()) return 100;
  return std::clamp(v.integer(100), 0, 100);
}

void ConfigManager::applyToSession(Session& session) const {
  session.alwaysDash_ = alwaysDash;
  session.commandRemember_ = commandRemember;
  session.volumes_ = {bgmVolume, bgsVolume, meVolume, seVolume};
}

void ConfigManager::readFromSession(const Session& session) {
  alwaysDash = session.alwaysDash_;
  commandRemember = session.commandRemember_;
  bgmVolume = session.volumes_[0];
  bgsVolume = session.volumes_[1];
  meVolume = session.volumes_[2];
  seVolume = session.volumes_[3];
}

void ConfigManager::load(Session& session, const Value& config) {
  ConfigManager loaded;
  loaded.applyData(config);
  loaded.applyToSession(session);
  ++session.configurationRevision_;
}

Value ConfigManager::save(const Session& session) {
  ConfigManager current;
  current.readFromSession(session);
  return current.makeData();
}

bool StorageManager::isLocalMode() {
  return true;
}

std::string StorageManager::localFileDirectoryPath(const std::string& baseDir) {
  return baseDir + "/save/";
}

std::string StorageManager::localFilePath(const std::string& baseDir, int savefileId) {
  if (savefileId < 0) return localFileDirectoryPath(baseDir) + "config.rpgsave";
  if (savefileId == 0) return localFileDirectoryPath(baseDir) + "global.rpgsave";
  return localFileDirectoryPath(baseDir) + "file" + std::to_string(savefileId) + ".rpgsave";
}

std::string StorageManager::localFileBackupPath(const std::string& baseDir, int savefileId) {
  return localFilePath(baseDir, savefileId) + ".bak";
}

std::string StorageManager::webStorageKey(int savefileId) {
  if (savefileId < 0) return "RPG Config";
  if (savefileId == 0) return "RPG Global";
  return "RPG File" + std::to_string(savefileId);
}

bool StorageManager::localFileExists(const std::string& baseDir, int savefileId) {
  std::error_code ec;
  return std::filesystem::exists(localFilePath(baseDir, savefileId), ec);
}

bool StorageManager::localFileBackupExists(const std::string& baseDir, int savefileId) {
  std::error_code ec;
  return std::filesystem::exists(localFileBackupPath(baseDir, savefileId), ec);
}

bool StorageManager::removeLocalFile(const std::string& baseDir, int savefileId) {
  std::error_code ec;
  return std::filesystem::remove(localFilePath(baseDir, savefileId), ec);
}

bool Decrypter::checkImgIgnore(const std::string& url) {
  return std::find(ignoreList.begin(), ignoreList.end(), url) != ignoreList.end();
}

bool Decrypter::hasEncryptedHeader(const std::vector<std::uint8_t>& data) {
  static constexpr std::uint8_t kSig[16] = {
    0x52, 0x50, 0x47, 0x4d, 0x56, 0x00, 0x00, 0x00,
    0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00
  };
  if (data.size() < kHeaderLen) return false;
  return std::equal(std::begin(kSig), std::end(kSig), data.begin());
}

std::vector<std::uint8_t> Decrypter::cutArrayHeader(const std::vector<std::uint8_t>& data, std::size_t length) {
  if (data.size() <= length) return {};
  return std::vector<std::uint8_t>(data.begin() + static_cast<std::ptrdiff_t>(length), data.end());
}

std::vector<std::uint8_t> Decrypter::decryptArrayBuffer(const std::vector<std::uint8_t>& data, const std::array<std::uint8_t, 16>& key) {
  if (data.empty()) return {};
  if (!hasEncryptedHeader(data)) throw std::runtime_error("Header is wrong");
  if (data.size() < kHeaderLen * 2) throw std::out_of_range("encrypted payload shorter than encryption header");
  auto output = cutArrayHeader(data, kHeaderLen);
  for (std::size_t index = 0; index < kHeaderLen; ++index) output[index] ^= key[index];
  return output;
}

std::vector<std::uint8_t> Decrypter::decryptArrayBuffer(const std::vector<std::uint8_t>& data, const std::string& hexKey) {
  return decryptArrayBuffer(data, imageEncryptionKey(hexKey));
}

std::vector<std::uint8_t> Decrypter::decryptArrayBuffer(const std::vector<std::uint8_t>& data) {
  return decryptArrayBuffer(data, encryptionKey);
}

std::string Decrypter::extToEncryptExt(const std::string& url) {
  if (url.size() >= 4 && url.substr(url.size() - 4) == ".png") return url.substr(0, url.size() - 4) + ".rpgmvp";
  if (url.size() >= 4 && url.substr(url.size() - 4) == ".ogg") return url.substr(0, url.size() - 4) + ".rpgmvo";
  if (url.size() >= 4 && url.substr(url.size() - 4) == ".m4a") return url.substr(0, url.size() - 4) + ".rpgmvm";
  return url;
}

void Decrypter::readEncryptionkey(const Value& systemJson) {
  hasEncryptedImages = systemJson["hasEncryptedImages"].boolean(); hasEncryptedAudio = systemJson["hasEncryptedAudio"].boolean();
  encryptionKey.fill(0);
  const auto key = systemJson["encryptionKey"].text();
  if (!key.empty()) encryptionKey = imageEncryptionKey(key);
}

namespace {
void appendUtf8(std::string& text, std::uint32_t point) {
  if (point < 0x80) text.push_back(static_cast<char>(point));
  else if (point < 0x800) { text.push_back(static_cast<char>(0xc0 | point >> 6)); text.push_back(static_cast<char>(0x80 | (point & 63))); }
  else if (point < 0x10000) { text.push_back(static_cast<char>(0xe0 | point >> 12)); text.push_back(static_cast<char>(0x80 | (point >> 6 & 63))); text.push_back(static_cast<char>(0x80 | (point & 63))); }
  else { text.push_back(static_cast<char>(0xf0 | point >> 18)); text.push_back(static_cast<char>(0x80 | (point >> 12 & 63))); text.push_back(static_cast<char>(0x80 | (point >> 6 & 63))); text.push_back(static_cast<char>(0x80 | (point & 63))); }
}
std::string escapeJsonString(const std::string& text) {
  constexpr char digits[] = "0123456789abcdef";
  std::string out = "\"";
  for (std::size_t index = 0; index < text.size(); ++index) {
    const auto c = static_cast<unsigned char>(text[index]);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 32) { out += "\\u00"; out += digits[c >> 4]; out += digits[c & 15]; }
        else if (c == 0xed && index + 2 < text.size() && (static_cast<unsigned char>(text[index + 1]) & 0xe0) == 0xa0) {
          const auto point = static_cast<unsigned>(((c & 15) << 12) | ((text[index + 1] & 63) << 6) | (text[index + 2] & 63));
          out += "\\u"; for (int shift = 12; shift >= 0; shift -= 4) out += digits[point >> shift & 15]; index += 2;
        } else out.push_back(static_cast<char>(c));
    }
  }
  return out + '"';
}
std::string jsonNumber(double value) {
  if (!std::isfinite(value)) return "null";
  if (!value) return "0";
  char buffer[128];
  const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value, std::chars_format::general);
  if (result.ec != std::errc{}) throw std::runtime_error("cannot encode JSON number");
  std::string number(buffer, result.ptr);
  const auto exponentAt = number.find('e');
  if (exponentAt == std::string::npos) return number;
  const int exponent = std::stoi(number.substr(exponentAt + 1));
  if (std::abs(value) >= 1e-6 && std::abs(value) < 1e21) {
    const bool negative = number[0] == '-';
    std::string mantissa = number.substr(negative ? 1 : 0, exponentAt - (negative ? 1 : 0));
    const auto decimalAt = mantissa.find('.');
    const int before = decimalAt == std::string::npos ? static_cast<int>(mantissa.size()) : static_cast<int>(decimalAt);
    if (decimalAt != std::string::npos) mantissa.erase(decimalAt, 1);
    const int point = before + exponent;
    if (point <= 0) mantissa = "0." + std::string(-point, '0') + mantissa;
    else if (point >= static_cast<int>(mantissa.size())) mantissa += std::string(point - mantissa.size(), '0');
    else mantissa.insert(point, ".");
    return negative ? "-" + mantissa : mantissa;
  }
  return number.substr(0, exponentAt) + "e" + (exponent >= 0 ? "+" : "-") + std::to_string(std::abs(exponent));
}
class JsonParser {
 public:
  explicit JsonParser(const std::string& source) : source_(source) {}
  Value parse() { auto value = parseValue(0); whitespace(); if (position_ != source_.size()) fail(); return value; }
 private:
  const std::string& source_;
  std::size_t position_ = 0;
  [[noreturn]] void fail() const { throw std::invalid_argument("invalid JSON at byte " + std::to_string(position_)); }
  void whitespace() { while (position_ < source_.size() && (source_[position_] == ' ' || source_[position_] == '\t' || source_[position_] == '\r' || source_[position_] == '\n')) ++position_; }
  bool take(char c) { whitespace(); if (position_ < source_.size() && source_[position_] == c) { ++position_; return true; } return false; }
  std::uint32_t hex4() {
    if (position_ + 4 > source_.size()) fail();
    std::uint32_t point = 0;
    for (int index = 0; index < 4; ++index) {
      const char c = source_[position_++];
      if (c >= '0' && c <= '9') point = point * 16 + c - '0';
      else if (c >= 'a' && c <= 'f') point = point * 16 + c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') point = point * 16 + c - 'A' + 10;
      else fail();
    }
    return point;
  }
  std::string string() {
    if (!take('"')) fail();
    std::string out;
    while (position_ < source_.size()) {
      const auto c = static_cast<unsigned char>(source_[position_++]);
      if (c == '"') return out;
      if (c < 32) fail();
      if (c != '\\') { out.push_back(c); continue; }
      if (position_ == source_.size()) fail();
      switch (source_[position_++]) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          auto point = hex4();
          if (point >= 0xd800 && point <= 0xdbff && position_ + 6 <= source_.size() && source_.compare(position_, 2, "\\u") == 0) {
            const auto saved = position_; position_ += 2; const auto low = hex4();
            if (low >= 0xdc00 && low <= 0xdfff) point = 0x10000 + ((point - 0xd800) << 10) + low - 0xdc00;
            else position_ = saved;
          }
          appendUtf8(out, point); break;
        }
        default: fail();
      }
    }
    fail();
  }
  Value parseValue(int depth) {
    if (depth > 512) throw std::invalid_argument("JSON nesting limit exceeded");
    whitespace(); if (position_ == source_.size()) fail();
    const char c = source_[position_];
    if (c == '"') return string();
    if (take('{')) {
      Value::Object object;
      if (take('}')) return object;
      do { const auto key = string(); if (!take(':')) fail(); object[key] = parseValue(depth + 1); } while (take(','));
      if (!take('}')) fail(); return object;
    }
    if (take('[')) {
      Value::Array array;
      if (take(']')) return array;
      do { array.push_back(parseValue(depth + 1)); } while (take(','));
      if (!take(']')) fail(); return array;
    }
    for (const auto& token : {std::string("null"), std::string("true"), std::string("false")}) {
      if (source_.compare(position_, token.size(), token) == 0) { position_ += token.size(); return token == "null" ? Value{} : Value(token == "true"); }
    }
    const auto start = position_;
    if (source_[position_] == '-') ++position_;
    if (position_ == source_.size()) fail();
    const auto digit = [&](std::size_t at) { return at < source_.size() && source_[at] >= '0' && source_[at] <= '9'; };
    if (source_[position_] == '0') ++position_;
    else { if (!digit(position_)) fail(); while (digit(position_)) ++position_; }
    if (position_ < source_.size() && source_[position_] == '.') { ++position_; if (!digit(position_)) fail(); while (digit(position_)) ++position_; }
    if (position_ < source_.size() && (source_[position_] == 'e' || source_[position_] == 'E')) {
      ++position_; if (position_ < source_.size() && (source_[position_] == '+' || source_[position_] == '-')) ++position_;
      if (!digit(position_)) fail(); while (digit(position_)) ++position_;
    }
    return std::strtod(source_.substr(start, position_ - start).c_str(), nullptr);
  }
};
std::string rawJson(const Value& value) {
  if (value.isUndefined()) throw std::invalid_argument("undefined has no JSON representation");
  if (value.null()) return "null";
  if (const auto* boolean = std::get_if<bool>(&value.data)) return *boolean ? "true" : "false";
  if (const auto* number = std::get_if<double>(&value.data)) return jsonNumber(*number);
  if (const auto* text = std::get_if<std::string>(&value.data)) return escapeJsonString(*text);
  std::string out;
  if (const auto* array = std::get_if<Value::Array>(&value.data)) {
    out = "[";
    for (const auto& child : *array) { if (out.size() > 1) out += ','; out += child.isUndefined() ? "null" : rawJson(child); }
    return out + ']';
  }
  out = "{";
  for (const auto& [key, child] : std::get<Value::Object>(value.data)) { if (child.isUndefined()) continue; if (out.size() > 1) out += ','; out += escapeJsonString(key) + ':' + rawJson(child); }
  return out + '}';
}
std::string pointerKey(const std::string& key) {
  std::string out;
  for (char c : key) out += c == '~' ? "~0" : c == '/' ? "~1" : std::string(1,c);
  return out;
}
}
JsonNode::Ptr JsonEx::fromValue(const Value& value) {
  std::map<std::string,JsonNode::Ptr> paths;
  std::vector<std::pair<JsonNode::Ptr,std::string>> references;
  std::function<JsonNode::Ptr(const Value&,const std::string&,int)> convert = [&](const Value& value, const std::string& path, int depth) -> JsonNode::Ptr {
    if (depth >= kMaxDepth) throw std::runtime_error("Object too deep");
    auto node = std::make_shared<JsonNode>(); paths[path] = node;
    if (const auto* array = std::get_if<Value::Array>(&value.data)) {
      JsonNode::Array body;
      for (std::size_t index = 0; index < array->size(); ++index) body.push_back(convert((*array)[index], path + '/' + std::to_string(index), depth + 1));
      node->data = std::move(body);
    } else if (const auto* object = std::get_if<Value::Object>(&value.data)) {
      if (const auto ref = object->find("@r"); ref != object->end() && std::holds_alternative<std::string>(ref->second.data)) { references.push_back({node, ref->second.text()}); return node; }
      node->constructorName = value["@"].text();
      JsonNode::Object body;
      for (const auto& [key, child] : *object) if (key != "@" && key != "@c") body[key] = convert(child, path + '/' + pointerKey(key), depth + 1);
      node->data = std::move(body);
    } else std::visit([&](const auto& primitive) { using Type = std::decay_t<decltype(primitive)>; if constexpr (!std::is_same_v<Type,Value::Array> && !std::is_same_v<Type,Value::Object>) node->data = primitive; }, value.data);
    return node;
  };
  const auto root = convert(value, "", 0);
  std::map<const JsonNode*,JsonNode::Ptr> replacements;
  for (const auto& [node, path] : references) { const auto found = paths.find(path); if (found == paths.end()) throw std::invalid_argument("invalid save reference path"); replacements[node.get()] = found->second; }
  std::set<const JsonNode*> visited;
  std::function<void(JsonNode::Ptr&)> link = [&](JsonNode::Ptr& node) {
    if (const auto found = replacements.find(node.get()); found != replacements.end()) node = found->second;
    if (!visited.insert(node.get()).second) return;
    if (auto* array = std::get_if<JsonNode::Array>(&node->data)) for (auto& child : *array) link(child);
    if (auto* object = std::get_if<JsonNode::Object>(&node->data)) for (auto& [key, child] : *object) { (void)key; link(child); }
  };
  auto result = root; link(result); return result;
}
Value JsonEx::toValue(const JsonNode::Ptr& value) {
  std::map<const JsonNode*,std::string> ancestors;
  std::function<Value(const JsonNode::Ptr&,const std::string&,int)> convert = [&](const JsonNode::Ptr& node, const std::string& path, int depth) -> Value {
    if (!node) return {};
    if (const auto found = ancestors.find(node.get()); found != ancestors.end()) return Value::Object{{"@r",found->second}};
    if (depth >= kMaxDepth) throw std::runtime_error("Object too deep");
    ancestors[node.get()] = path;
    Value result;
    if (const auto* array = std::get_if<JsonNode::Array>(&node->data)) {
      Value::Array body; for (std::size_t index = 0; index < array->size(); ++index) body.push_back(convert((*array)[index], path + '/' + std::to_string(index), depth + 1)); result = std::move(body);
    } else if (const auto* object = std::get_if<JsonNode::Object>(&node->data)) {
      Value::Object body; if (!node->constructorName.empty()) body["@"] = node->constructorName;
      for (const auto& [key, child] : *object) body[key] = convert(child, path + '/' + pointerKey(key), depth + 1); result = std::move(body);
    } else std::visit([&](const auto& primitive) { using Type = std::decay_t<decltype(primitive)>; if constexpr (!std::is_same_v<Type,JsonNode::Array> && !std::is_same_v<Type,JsonNode::Object>) result.data = primitive; }, node->data);
    ancestors.erase(node.get()); return result;
  };
  return convert(value, "", 0);
}
std::string JsonEx::stringifyGraph(const JsonNode::Ptr& value) {
  int sequence = 0;
  std::map<const JsonNode*,int> ids;
  std::function<Value(const JsonNode::Ptr&,int,bool)> encode = [&](const JsonNode::Ptr& node, int depth, bool root) -> Value {
    if (!node) return {};
    const bool compound = std::holds_alternative<JsonNode::Array>(node->data) || std::holds_alternative<JsonNode::Object>(node->data);
    if (compound) {
      if (const auto found = ids.find(node.get()); found != ids.end()) return Value::Object{{"@r", found->second}};
    }
    if (++depth >= kMaxDepth) throw std::runtime_error("Object too deep");
    if (const auto* array = std::get_if<JsonNode::Array>(&node->data)) {
      const int id = ids[node.get()] = ++sequence;
      Value::Array body; for (const auto& child : *array) body.push_back(encode(child, depth + 1, false));
      if (root) return body;
      return Value::Object{{"@c", id}, {"@a", std::move(body)}};
    }
    if (const auto* object = std::get_if<JsonNode::Object>(&node->data)) {
      Value::Object body{{"@c", ids[node.get()] = ++sequence}};
      if (!node->constructorName.empty() && node->constructorName != "Object" && node->constructorName != "Array") body["@"] = node->constructorName;
      for (const auto& [key, child] : *object) if (key.empty() || key[0] != '@' || key.size() < 2) body[key] = encode(child, depth + 1, false);
      return body;
    }
    Value result; std::visit([&](const auto& primitive) { using Type = std::decay_t<decltype(primitive)>; if constexpr (!std::is_same_v<Type,JsonNode::Array> && !std::is_same_v<Type,JsonNode::Object>) result.data = primitive; }, node->data); return result;
  };
  return rawJson(encode(value, 0, true));
}
std::optional<std::string> JsonEx::stringifyGraphOptional(const JsonNode::Ptr& value) {
  if (value && std::holds_alternative<Value::Undefined>(value->data)) return std::nullopt;
  return stringifyGraph(value);
}
JsonNode::Ptr JsonEx::parseGraph(const std::string& json) {
  const auto raw = JsonParser(json).parse();
  std::map<int,JsonNode::Ptr> registry;
  std::function<void(const Value&,int)> index = [&](const Value& value, int depth) {
    if (depth > 512) throw std::invalid_argument("JSON nesting limit exceeded");
    if (const auto* object = std::get_if<Value::Object>(&value.data)) {
      if (const auto id = object->find("@c"); id != object->end()) {
        const double numberValue = id->second.number();
        if (!std::isfinite(numberValue) || numberValue < 1 || numberValue > std::numeric_limits<int>::max() || std::floor(numberValue) != numberValue) throw std::invalid_argument("invalid JSON object reference");
        const int number = static_cast<int>(numberValue); if (registry.contains(number)) throw std::invalid_argument("duplicate JSON object reference");
        registry[number] = std::make_shared<JsonNode>();
      }
      for (const auto& [key, child] : *object) if (key != "@c" && key != "@r") index(child, depth + 1);
    } else if (const auto* array = std::get_if<Value::Array>(&value.data)) for (const auto& child : *array) index(child, depth + 1);
  };
  index(raw, 0);
  JsonNode::Ptr rootArray;
  if (std::holds_alternative<Value::Array>(raw.data) && !registry.contains(1)) { rootArray = std::make_shared<JsonNode>(); registry[1] = rootArray; }
  std::function<JsonNode::Ptr(const Value&,int)> decode = [&](const Value& value, int depth) -> JsonNode::Ptr {
    if (depth > 512) throw std::invalid_argument("JSON nesting limit exceeded");
    if (const auto* object = std::get_if<Value::Object>(&value.data)) {
      if (const auto reference = object->find("@r"); reference != object->end() && std::holds_alternative<double>(reference->second.data)) {
        const double number = reference->second.number();
        if (!std::isfinite(number) || number < 1 || number > std::numeric_limits<int>::max() || std::floor(number) != number) throw std::invalid_argument("invalid JSON reference");
        const int id = static_cast<int>(number);
        const auto found = registry.find(id); if (found == registry.end()) throw std::invalid_argument("missing JSON reference"); return found->second;
      }
      auto node = value["@c"].null() ? std::make_shared<JsonNode>() : registry.at(value["@c"].integer());
      if (const auto body = object->find("@a"); body != object->end()) {
        if (!std::holds_alternative<Value::Array>(body->second.data)) throw std::invalid_argument("invalid JSON array wrapper");
        JsonNode::Array array; for (const auto& child : body->second.array()) array.push_back(decode(child, depth + 1)); node->data = std::move(array);
      } else {
        node->constructorName = value["@"].text(); JsonNode::Object fields;
        for (const auto& [key, child] : *object) if (key != "@" && key != "@c") fields[key] = decode(child, depth + 1); node->data = std::move(fields);
      }
      return node;
    }
    auto node = depth == 0 && rootArray ? rootArray : std::make_shared<JsonNode>();
    if (const auto* array = std::get_if<Value::Array>(&value.data)) { JsonNode::Array body; for (const auto& child : *array) body.push_back(decode(child, depth + 1)); node->data = std::move(body); }
    else std::visit([&](const auto& primitive) { using Type = std::decay_t<decltype(primitive)>; if constexpr (!std::is_same_v<Type,Value::Array> && !std::is_same_v<Type,Value::Object>) node->data = primitive; }, value.data);
    return node;
  };
  try { return decode(raw, 0); }
  catch (...) {
    for (const auto& [id,node] : registry) {
      (void)id;
      if (auto* array = std::get_if<JsonNode::Array>(&node->data)) array->clear();
      if (auto* object = std::get_if<JsonNode::Object>(&node->data)) object->clear();
    }
    throw;
  }
}
void JsonEx::destroyGraph(JsonNode::Ptr& value) {
  std::vector<JsonNode::Ptr> nodes;
  std::set<const JsonNode*> visited;
  std::function<void(const JsonNode::Ptr&)> collect = [&](const JsonNode::Ptr& node) {
    if (!node || !visited.insert(node.get()).second) return;
    nodes.push_back(node);
    if (const auto* array = std::get_if<JsonNode::Array>(&node->data)) for (const auto& child : *array) collect(child);
    if (const auto* object = std::get_if<JsonNode::Object>(&node->data)) for (const auto& [key, child] : *object) { (void)key; collect(child); }
  };
  collect(value);
  for (const auto& node : nodes) {
    if (auto* array = std::get_if<JsonNode::Array>(&node->data)) array->clear();
    if (auto* object = std::get_if<JsonNode::Object>(&node->data)) object->clear();
  }
  value.reset();
}
JsonGraph::~JsonGraph() { JsonEx::destroyGraph(root); }
std::optional<std::string> JsonEx::stringifyOptional(const Value& value) {
  if (value.isUndefined()) return std::nullopt;
  JsonGraph graph(fromValue(value)); return stringifyGraphOptional(graph.root);
}
std::string JsonEx::stringify(const Value& value) {
  const auto json = stringifyOptional(value);
  if (!json) throw std::invalid_argument("undefined has no JSON representation");
  return *json;
}
Value JsonEx::parse(const std::string& json) { JsonGraph graph(parseGraph(json)); return toValue(graph.root); }
void JsonEx::cleanMetadata(Value& value) {
  if (auto* object = std::get_if<Value::Object>(&value.data)) { object->erase("@"); object->erase("@c"); for (auto& [key, child] : *object) { (void)key; cleanMetadata(child); } }
  else if (auto* array = std::get_if<Value::Array>(&value.data)) for (auto& child : *array) cleanMetadata(child);
}
Value JsonEx::makeDeepCopy(const Value& value) { return parse(stringify(value)); }

namespace {
std::uint64_t millisecondsNow() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
}
}
void CacheEntry::free(bool byTTL) {
  freedByTTL = byTTL;
  if (!cached) return;
  cached = false;
  if (cache) cache->entries.erase(key);
}
void CacheEntry::allocate() {
  if (!cached) { if (cache) cache->entries[key] = shared_from_this(); cached = true; }
  touch();
}
void CacheEntry::setTimeToLive(std::uint64_t ticks, double seconds) { ttlTicks = ticks; ttlSeconds = seconds; }
bool CacheEntry::isStillAlive(std::uint64_t ticks, double seconds) const {
  return (!ttlTicks || touchTicks + ttlTicks < ticks) && (!ttlSeconds || touchSeconds + ttlSeconds < seconds);
}
bool CacheEntry::isStillAlive() const { return isStillAlive(cache ? cache->updateTicks : 0, cache ? cache->updateSeconds : 0); }
void CacheEntry::touch(std::uint64_t ticks, double seconds) {
  if (cached) { touchTicks = ticks; touchSeconds = seconds; }
  else if (freedByTTL) { freedByTTL = false; if (cache && !cache->entries.contains(key)) cache->entries[key] = shared_from_this(); }
}
void CacheEntry::touch() { touch(cache ? cache->updateTicks : 0, cache ? cache->updateSeconds : 0); }
CacheMap::CacheMap() : updateSeconds(static_cast<double>(millisecondsNow())) {}
void CacheMap::checkTTL() {
  std::vector<std::shared_ptr<CacheEntry>> expired;
  for (const auto& [key, entry] : entries) { (void)key; if (!entry->isStillAlive()) expired.push_back(entry); }
  for (const auto& entry : expired) entry->free(true);
}
CacheEntry* CacheMap::getItem(const std::string& key) { const auto found = entries.find(key); return found == entries.end() ? nullptr : found->second.get(); }
std::shared_ptr<CacheEntry> CacheMap::setItem(const std::string& key, std::size_t itemId, std::uint64_t ticks, double seconds) {
  auto entry = std::make_shared<CacheEntry>(); entry->cache = this; entry->key = key; entry->itemId = itemId;
  entry->setTimeToLive(ticks, seconds); entry->allocate(); return entry;
}
void CacheMap::update(std::uint64_t ticks, double delta) {
  updateTicks += ticks; updateSeconds += delta;
  if (updateSeconds >= lastCheckTTL + delayCheckTTL) { lastCheckTTL = updateSeconds; checkTTL(); }
}
void CacheMap::clear() {
  std::vector<std::shared_ptr<CacheEntry>> removed;
  for (const auto& [key, entry] : entries) { (void)key; removed.push_back(entry); }
  for (const auto& entry : removed) entry->free();
}
ImageCache::ImageCache() : clock(millisecondsNow) {}
void ImageCache::add(const std::string& key, std::size_t pixels, std::function<void()> release) {
  const auto found = items.find(key);
  const auto order = found == items.end() ? ++counter : found->second.order;
  if (found != items.end() && found->second.release) found->second.release();
  Entry entry; entry.key = key; entry.pixelCount = pixels; entry.touch = clock(); entry.order = order; entry.release = std::move(release);
  items[key] = std::move(entry); truncateCache();
}
ImageCache::Entry* ImageCache::get(const std::string& key) {
  const auto found = items.find(key); if (found == items.end()) return nullptr;
  found->second.touch = clock(); return &found->second;
}
void ImageCache::reserve(const std::string& key, std::size_t pixels, std::uint64_t id) {
  if (!items.contains(key)) { Entry entry; entry.key = key; entry.pixelCount = pixels; entry.touch = clock(); entry.order = ++counter; items[key] = std::move(entry); }
  items.at(key).reservationId = id;
}
void ImageCache::releaseReservation(std::uint64_t id) { for (auto& [key, entry] : items) { (void)key; if (entry.reservationId == id) entry.reservationId.reset(); } }
bool ImageCache::mustBeHeld(const Entry& entry) const { return !entry.requestOnly && ((entry.reservationId && *entry.reservationId) || !entry.ready); }
bool ImageCache::isReady() const {
  return std::none_of(items.begin(), items.end(), [](const auto& entry) { return !entry.second.requestOnly && !entry.second.ready; });
}
ImageCache::Entry* ImageCache::getErrorBitmap() {
  Entry* error = nullptr;
  for (auto& [key, entry] : items) { (void)key; if (entry.error && (!error || entry.order < error->order)) error = &entry; }
  return error;
}
void ImageCache::truncateCache() {
  std::vector<Entry*> ordered; for (auto& [key, entry] : items) { (void)key; ordered.push_back(&entry); }
  std::stable_sort(ordered.begin(), ordered.end(), [](const Entry* a, const Entry* b) { return a->touch != b->touch ? a->touch > b->touch : a->order < b->order; });
  double left = static_cast<double>(limit);
  std::vector<std::string> expired;
  for (const auto* entry : ordered) { if (left > 0 || mustBeHeld(*entry)) left -= entry->pixelCount; else expired.push_back(entry->key); }
  for (const auto& key : expired) { auto release = std::move(items.at(key).release); items.erase(key); if (release) release(); }
}
void ImageCache::clear() {
  auto old = std::move(items); items.clear();
  for (auto& [key, entry] : old) { (void)key; if (entry.release) entry.release(); }
}
void RequestQueue::enqueue(const std::string& key, std::function<void()> start, std::function<bool()> ready) { queue.push_back({key, false, false, std::move(start), std::move(ready)}); }
void RequestQueue::update() {
  if (queue.empty()) return;
  if (queue.front().isRequestReady ? queue.front().isRequestReady() : queue.front().completed) {
    queue.erase(queue.begin()); if (queue.empty()) return;
  }
  const auto start = queue.front().startRequest; queue.front().started = true;
  if (start) start();
}
void RequestQueue::raisePriority(const std::string& key) {
  const auto found = std::find_if(queue.begin(), queue.end(), [&](const Request& request) { return request.key == key; });
  if (found != queue.end()) { auto entry = std::move(*found); queue.erase(found); queue.insert(queue.begin(), std::move(entry)); }
}
void RequestQueue::clear() { queue.clear(); }
ResourceHandler& ResourceHandler::shared() { static ResourceHandler handler; return handler; }
ResourceHandler::Callback ResourceHandler::createLoader(const std::string& url, Callback retryMethod, Callback resignMethod, std::vector<int> intervals) {
  auto entry = std::make_shared<LoaderEntry>(); entry->url = url; entry->retryMethod = std::move(retryMethod); entry->resignMethod = std::move(resignMethod); entry->retryInterval = std::move(intervals);
  return [this, entry]() {
    if (entry->retryCount < entry->retryInterval.size()) { scheduled_.push_back({time_ + entry->retryInterval[entry->retryCount++], entry->retryMethod}); return; }
    if (entry->resignMethod) entry->resignMethod();
    if (!entry->url.empty()) {
      if (reloaders.empty()) { if (printLoadingError) printLoadingError(entry->url); if (stop) stop(); }
      reloaders.push_back([entry]() { entry->retryCount = 0; if (entry->retryMethod) entry->retryMethod(); });
    }
  };
}
void ResourceHandler::update(double milliseconds) {
  time_ += milliseconds;
  std::vector<Callback> ready;
  for (auto it = scheduled_.begin(); it != scheduled_.end();) {
    if (it->time <= time_) { ready.push_back(std::move(it->callback)); it = scheduled_.erase(it); } else ++it;
  }
  for (const auto& callback : ready) if (callback) callback();
}
void ResourceHandler::retry() {
  if (reloaders.empty()) return;
  if (eraseLoadingError) eraseLoadingError(); if (resume) resume();
  const auto callbacks = reloaders;
  for (const auto& callback : callbacks) if (callback) callback();
  reloaders.clear();
}
void ResourceHandler::clear() { reloaders.clear(); scheduled_.clear(); }

void Game_Item::setEquip(bool isWeaponFlag, int id) {
  dataClass = id <= 0 ? "" : (isWeaponFlag ? "weapon" : "armor");
  itemId = id <= 0 ? 0 : id;
}

bool Game_SelfSwitches::value(int mapId, int eventId, const std::string& ch) const {
  const std::string key = std::to_string(mapId) + "," + std::to_string(eventId) + "," + ch;
  const auto it = data.find(key);
  return it != data.end() && it->second;
}

void Game_SelfSwitches::setValue(int mapId, int eventId, const std::string& ch, bool val) {
  const std::string key = std::to_string(mapId) + "," + std::to_string(eventId) + "," + ch;
  if (val) data[key] = true;
  else data.erase(key);
}

}  // namespace pmjs::mv


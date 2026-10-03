#include "effects.hpp"
#include "media_service.hpp"

#include <Effekseer.h>
#include <Effekseer/Effekseer.EffectNode.h>
#include <EffekseerRendererGL.h>
#include <GLES3/gl3.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace pmjs {
namespace {

// Loading and renderer initialization also change bindings, outside Begin/EndRendering.
struct GlBindings {
  GLint program, framebuffer, vao, buffer, elements, activeTexture;
  GLint viewport[4];
  bool es3;
  struct Attribute {
    GLint enabled, buffer, size, stride, type, normalized;
    void* pointer;
  };
  std::vector<Attribute> attributes;
  std::array<GLint, 8> textures{}, samplers{};
  GlBindings() {
    glGetIntegerv(GL_CURRENT_PROGRAM, &program);
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &framebuffer);
    const auto version = reinterpret_cast<const char*>(glGetString(GL_VERSION));
    es3 = version && std::strncmp(version, "OpenGL ES 3", 11) == 0;
    if (es3) glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &vao);
    else {
      GLint count;
      glGetIntegerv(GL_MAX_VERTEX_ATTRIBS, &count);
      attributes.resize(count);
      for (GLint i = 0; i < count; ++i) {
        auto& a = attributes[i];
        glGetVertexAttribiv(i, GL_VERTEX_ATTRIB_ARRAY_ENABLED, &a.enabled);
        glGetVertexAttribiv(i, GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING, &a.buffer);
        glGetVertexAttribiv(i, GL_VERTEX_ATTRIB_ARRAY_SIZE, &a.size);
        glGetVertexAttribiv(i, GL_VERTEX_ATTRIB_ARRAY_STRIDE, &a.stride);
        glGetVertexAttribiv(i, GL_VERTEX_ATTRIB_ARRAY_TYPE, &a.type);
        glGetVertexAttribiv(i, GL_VERTEX_ATTRIB_ARRAY_NORMALIZED, &a.normalized);
        glGetVertexAttribPointerv(i, GL_VERTEX_ATTRIB_ARRAY_POINTER, &a.pointer);
      }
    }
    glGetIntegerv(GL_ARRAY_BUFFER_BINDING, &buffer);
    glGetIntegerv(GL_ELEMENT_ARRAY_BUFFER_BINDING, &elements);
    glGetIntegerv(GL_ACTIVE_TEXTURE, &activeTexture);
    glGetIntegerv(GL_VIEWPORT, viewport);
    for (std::size_t i = 0; i < textures.size(); ++i) {
      glActiveTexture(GL_TEXTURE0 + i);
      glGetIntegerv(GL_TEXTURE_BINDING_2D, &textures[i]);
      if (es3) glGetIntegerv(GL_SAMPLER_BINDING, &samplers[i]);
    }
    glActiveTexture(activeTexture);
  }
  ~GlBindings() {
    glUseProgram(program);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    if (es3) glBindVertexArray(vao);
    else {
      for (std::size_t i = 0; i < attributes.size(); ++i) {
        const auto& a = attributes[i];
        glBindBuffer(GL_ARRAY_BUFFER, a.buffer);
        if (a.buffer) glVertexAttribPointer(i, a.size, a.type, a.normalized, a.stride, a.pointer);
        if (a.enabled) glEnableVertexAttribArray(i);
        else glDisableVertexAttribArray(i);
      }
    }
    glBindBuffer(GL_ARRAY_BUFFER, buffer);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, elements);
    for (std::size_t i = 0; i < textures.size(); ++i) {
      glActiveTexture(GL_TEXTURE0 + i);
      glBindTexture(GL_TEXTURE_2D, textures[i]);
      if (es3) glBindSampler(i, samplers[i]);
    }
    glActiveTexture(activeTexture);
    glViewport(viewport[0], viewport[1], viewport[2], viewport[3]);
  }
};

class Reader final : public Effekseer::FileReader {
 public:
  explicit Reader(std::vector<std::uint8_t> bytes) : bytes_(std::move(bytes)) {}
  std::size_t Read(void* buffer, std::size_t size) override {
    size = std::min(size, bytes_.size() - position_);
    if (size) std::memcpy(buffer, bytes_.data() + position_, size);
    position_ += size;
    return size;
  }
  void Seek(int position) override {
    if (position < 0 || static_cast<std::size_t>(position) > bytes_.size()) {
      throw std::runtime_error("invalid effect file seek");
    }
    position_ = static_cast<std::size_t>(position);
  }
  int GetPosition() const override { return static_cast<int>(position_); }
  std::size_t GetLength() const override { return bytes_.size(); }
 private:
  std::vector<std::uint8_t> bytes_;
  std::size_t position_ = 0;
};

class Files final : public Effekseer::FileInterface {
 public:
  explicit Files(Vfs& vfs) : vfs_(vfs) {}
  Effekseer::FileReaderRef OpenRead(const char16_t* path) override {
    const auto name = std::filesystem::path(path).generic_string();
    auto bytes = vfs_.readBytes(name);
    if (!bytes || bytes->size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
      error = "cannot load effect resource: " + name;
      return nullptr;
    }
    return Effekseer::MakeRefPtr<Reader>(std::move(*bytes));
  }
  Effekseer::FileReaderRef TryOpenRead(const char16_t* path) override {
    const auto previous = error;
    auto result = OpenRead(path);
    error = previous;
    return result;
  }
  Effekseer::FileWriterRef OpenWrite(const char16_t*) override { return nullptr; }
  std::string error;
 private:
  Vfs& vfs_;
};

class Wave final : public Effekseer::SoundData {
 public:
  explicit Wave(std::string source) : path(std::move(source)) {}
  std::string path;
};

class WaveLoader final : public Effekseer::SoundLoader {
 public:
  WaveLoader(Vfs& vfs, MediaService& media, Effekseer::RefPtr<Files> files)
    : vfs_(vfs), media_(media), files_(files) {}
  Effekseer::SoundDataRef Load(const char16_t* path) override {
    const auto name = std::filesystem::path(path).generic_string();
    const auto source = vfs_.resolve(name);
    std::string error;
    const auto voice = source ? media_.loadAudio(source->string(), &error, {AudioIntent::effect, name, *source}) : 0;
    if (!voice) {
      files_->error = "cannot load effect sound: " + name + ": " + error;
      return nullptr;
    }
    media_.release(voice);
    return Effekseer::MakeRefPtr<Wave>(source->string());
  }
 private:
  Vfs& vfs_;
  MediaService& media_;
  Effekseer::RefPtr<Files> files_;
};

class WavePlayer final : public Effekseer::SoundPlayer {
  struct Voice { std::uint32_t media; Effekseer::SoundTag tag; std::uint64_t order; };
 public:
  explicit WavePlayer(MediaService& media) : media_(media) {}
  ~WavePlayer() override { StopAll(); }
  Effekseer::SoundHandle Play(Effekseer::SoundTag tag, const InstanceParameter& p) override {
    if (p.Mode3D) throw std::runtime_error("Effekseer spatial sound is unsupported");
    const auto wave = p.Data.DownCast<Wave>();
    if (wave.Get() == nullptr) return nullptr;
    std::erase_if(voices_, [&](const auto& item) {
      if (media_.isPlaying(item.second->media)) return false;
      media_.release(item.second->media);
      return true;
    });
    // MZ's Effekseer backend has sixteen sound voices and reuses the oldest.
    if (voices_.size() == 16) {
      const auto oldest = std::min_element(voices_.begin(), voices_.end(), [](const auto& a, const auto& b) {
        return a.second->order < b.second->order;
      });
      media_.release(oldest->second->media);
      voices_.erase(oldest);
    }
    std::string error;
    const auto id = media_.loadAudio(wave->path, &error, {AudioIntent::effect, wave->path, wave->path});
    if (!id) throw std::runtime_error("cannot play effect sound: " + error);
    media_.setParameters(id, p.Volume, std::pow(2.0F, p.Pitch), p.Pan);
    media_.play(id, false, 0);
    auto voice = std::make_unique<Voice>(Voice{id, tag, nextVoice_++});
    const auto handle = voice.get();
    voices_.emplace(handle, std::move(voice));
    return handle;
  }
  void Stop(Effekseer::SoundHandle handle, Effekseer::SoundTag tag) override {
    const auto found = voices_.find(handle);
    if (found == voices_.end() || found->second->tag != tag) return;
    media_.release(found->second->media);
    voices_.erase(found);
  }
  void Pause(Effekseer::SoundHandle handle, Effekseer::SoundTag tag, bool paused) override {
    const auto found = voices_.find(handle);
    if (found != voices_.end() && found->second->tag == tag) media_.setSuspended(found->second->media, paused);
  }
  bool CheckPlaying(Effekseer::SoundHandle handle, Effekseer::SoundTag tag) override {
    const auto found = voices_.find(handle);
    return found != voices_.end() && found->second->tag == tag && media_.isPlaying(found->second->media);
  }
  void StopTag(Effekseer::SoundTag tag) override {
    std::erase_if(voices_, [&](const auto& item) {
      if (item.second->tag != tag) return false;
      media_.release(item.second->media);
      return true;
    });
  }
  void PauseTag(Effekseer::SoundTag tag, bool paused) override {
    for (const auto& [handle, voice] : voices_) {
      (void)handle;
      if (voice->tag == tag) media_.setSuspended(voice->media, paused);
    }
  }
  bool CheckPlayingTag(Effekseer::SoundTag tag) override {
    return std::any_of(voices_.begin(), voices_.end(), [&](const auto& item) {
      return item.second->tag == tag && media_.isPlaying(item.second->media);
    });
  }
  void StopAll() override {
    for (const auto& [handle, voice] : voices_) { (void)handle; media_.release(voice->media); }
    voices_.clear();
  }
  std::uint32_t count() const { return static_cast<std::uint32_t>(voices_.size()); }
 private:
  MediaService& media_;
  std::uint64_t nextVoice_ = 0;
  std::unordered_map<Effekseer::SoundHandle, std::unique_ptr<Voice>> voices_;
};

template <typename Map>
auto& lookup(Map& map, std::uint32_t id, const char* what) {
  const auto found = map.find(id);
  if (found == map.end()) throw std::runtime_error(std::string("stale effect ") + what);
  return found->second;
}

}  // namespace

struct Effects::Impl {
  struct Context {
    Effekseer::ManagerRef manager;
    EffekseerRendererGL::RendererRef renderer;
    Effekseer::RefPtr<Files> files;
    Effekseer::RefPtr<WavePlayer> sound;
    float time = 0;
    float remainder = 0;
  };
  struct Effect { std::uint32_t context; Effekseer::EffectRef effect; };
  struct Handle { std::uint32_t context; Effekseer::Handle handle; };
  Impl(Vfs& fs, MediaService& audio) : vfs(fs), media(audio) {}
  Vfs& vfs;
  MediaService& media;
  std::uint32_t next = 1;
  std::unordered_map<std::uint32_t, Context> contexts;
  std::unordered_map<std::uint32_t, Effect> effects;
  std::unordered_map<std::uint32_t, Handle> handles;
  std::uint32_t id() {
    if (next == 0) throw std::runtime_error("effect IDs exhausted");
    return next++;
  }
};

Effects::Effects(Vfs& vfs, MediaService& media) : impl_(std::make_unique<Impl>(vfs, media)) {}
Effects::~Effects() = default;

std::uint32_t Effects::createContext() {
  const auto version = reinterpret_cast<const char*>(glGetString(GL_VERSION));
  if (!version || std::string(version).find("OpenGL ES ") == std::string::npos) {
    throw std::runtime_error("native Effekseer requires an OpenGL ES context");
  }
  GlBindings restore;
  Impl::Context context;
  context.manager = Effekseer::Manager::Create(4000);
  context.renderer = EffekseerRendererGL::Renderer::Create(10000, EffekseerRendererGL::OpenGLDeviceType::OpenGLES2);
  if (context.manager.Get() == nullptr || context.renderer.Get() == nullptr) throw std::runtime_error("Effekseer initialization failed");
  context.files = Effekseer::MakeRefPtr<Files>(impl_->vfs);
  auto& manager = context.manager;
  auto& renderer = context.renderer;
  renderer->SetRestorationOfStatesFlag(true);
  manager->SetSpriteRenderer(renderer->CreateSpriteRenderer());
  manager->SetRibbonRenderer(renderer->CreateRibbonRenderer());
  manager->SetRingRenderer(renderer->CreateRingRenderer());
  manager->SetTrackRenderer(renderer->CreateTrackRenderer());
  manager->SetModelRenderer(renderer->CreateModelRenderer());
  manager->SetEffectLoader(Effekseer::Effect::CreateEffectLoader(context.files));
  manager->SetTextureLoader(renderer->CreateTextureLoader(context.files));
  manager->SetModelLoader(renderer->CreateModelLoader(context.files));
  manager->SetCurveLoader(Effekseer::MakeRefPtr<Effekseer::CurveLoader>(context.files));
  manager->SetMaterialLoader(renderer->CreateMaterialLoader(context.files));
  context.sound = Effekseer::MakeRefPtr<WavePlayer>(impl_->media);
  manager->SetSoundPlayer(context.sound);
  manager->SetSoundLoader(Effekseer::MakeRefPtr<WaveLoader>(impl_->vfs, impl_->media, context.files));
  manager->SetCoordinateSystem(Effekseer::CoordinateSystem::RH);
  const auto id = impl_->id();
  impl_->contexts.emplace(id, std::move(context));
  return id;
}

void Effects::releaseContext(std::uint32_t context) {
  GlBindings restore;
  lookup(impl_->contexts, context, "context").manager->StopAllEffects();
  std::erase_if(impl_->handles, [=](const auto& item) { return item.second.context == context; });
  std::erase_if(impl_->effects, [=](const auto& item) { return item.second.context == context; });
  impl_->contexts.erase(context);
}

std::uint32_t Effects::load(std::uint32_t contextId, const std::string& path, float scale) {
  GlBindings restore;
  auto& context = lookup(impl_->contexts, contextId, "context");
  context.files->error.clear();
  const auto utf16 = std::filesystem::path(path).u16string();
  auto effect = Effekseer::Effect::Create(context.manager, utf16.c_str(), scale);
  if (!context.files->error.empty()) throw std::runtime_error(context.files->error);
  if (effect.Get() == nullptr) throw std::runtime_error("invalid effect: " + path);
  const auto require = [&](int count, auto get, const char* kind) {
    for (int i = 0; i < count; ++i) if ((effect.Get()->*get)(i).Get() == nullptr) {
      throw std::runtime_error(std::string("invalid effect ") + kind + " resource: " + path);
    }
  };
  require(effect->GetColorImageCount(), &Effekseer::Effect::GetColorImage, "color texture");
  require(effect->GetNormalImageCount(), &Effekseer::Effect::GetNormalImage, "normal texture");
  require(effect->GetDistortionImageCount(), &Effekseer::Effect::GetDistortionImage, "distortion texture");
  require(effect->GetModelCount(), &Effekseer::Effect::GetModel, "model");
  require(effect->GetMaterialCount(), &Effekseer::Effect::GetMaterial, "material");
  require(effect->GetCurveCount(), &Effekseer::Effect::GetCurve, "curve");
  require(effect->GetWaveCount(), &Effekseer::Effect::GetWave, "sound");
  static_cast<Effekseer::EffectNodeImplemented*>(effect->GetRoot())->Traverse([](auto* node) {
    if (node->SoundType == Effekseer::ParameterSoundType_Use &&
        node->Sound.PanType == Effekseer::ParameterSoundPanType_3D) {
      throw std::runtime_error("Effekseer spatial sound is unsupported");
    }
    return true;
  });
  const auto id = impl_->id();
  impl_->effects.emplace(id, Impl::Effect{contextId, effect});
  return id;
}

void Effects::release(std::uint32_t context, std::uint32_t effect) {
  GlBindings restore;
  if (lookup(impl_->effects, effect, "resource").context != context) {
    throw std::runtime_error("effect belongs to another context");
  }
  impl_->effects.erase(effect);
}

std::uint32_t Effects::play(std::uint32_t contextId, std::uint32_t effectId,
                            const std::array<float, 3>& location) {
  const auto& effect = lookup(impl_->effects, effectId, "resource");
  auto& context = lookup(impl_->contexts, contextId, "context");
  if (effect.context != contextId) throw std::runtime_error("effect belongs to another context");
  const auto handle = context.manager->Play(effect.effect, location[0], location[1], location[2]);
  if (handle < 0) throw std::runtime_error("Effekseer particle capacity exhausted");
  const auto id = impl_->id();
  impl_->handles.emplace(id, Impl::Handle{contextId, handle});
  return id;
}

void Effects::update(std::uint32_t contextId, float frames) {
  auto& context = lookup(impl_->contexts, contextId, "context");
  frames += context.remainder;
  context.remainder = frames - std::floor(frames);
  for (int frame = 0; frame < static_cast<int>(frames); ++frame) context.manager->Update(1.0F);
  context.time += frames / 60.0F;
  context.renderer->SetTime(context.time);
}

void Effects::stopAll(std::uint32_t context) {
  lookup(impl_->contexts, context, "context").manager->StopAllEffects();
}

bool Effects::validHandle(std::uint32_t handle) const { return impl_->handles.contains(handle); }
bool Effects::exists(std::uint32_t id) const {
  const auto found = impl_->handles.find(id);
  return found != impl_->handles.end() &&
    lookup(impl_->contexts, found->second.context, "context").manager->Exists(found->second.handle);
}

void Effects::control(std::uint32_t id, const std::string& operation, const std::array<float, 4>& v) {
  const auto handle = lookup(impl_->handles, id, "handle");
  auto& manager = lookup(impl_->contexts, handle.context, "context").manager;
  const auto h = handle.handle;
  if (operation == "location") manager->SetLocation(h, v[0], v[1], v[2]);
  else if (operation == "rotation") manager->SetRotation(h, v[0], v[1], v[2]);
  else if (operation == "scale") manager->SetScale(h, v[0], v[1], v[2]);
  else if (operation == "speed") manager->SetSpeed(h, v[0]);
  else if (operation == "target") manager->SetTargetLocation(h, v[0], v[1], v[2]);
  else if (operation == "seed") {
    if (static_cast<double>(v[0]) < std::numeric_limits<int>::min() ||
        static_cast<double>(v[0]) > std::numeric_limits<int>::max()) {
      throw std::runtime_error("invalid effect random seed");
    }
    manager->SetRandomSeed(h, static_cast<int>(v[0]));
  }
  else if (operation == "paused") manager->SetPaused(h, v[0] != 0);
  else if (operation == "shown") manager->SetShown(h, v[0] != 0);
  else if (operation == "stop") manager->StopEffect(h);
  else if (operation == "stopRoot") manager->StopRoot(h);
  else if (operation == "release") { manager->StopEffect(h); impl_->handles.erase(id); }
  else throw std::runtime_error("unknown effect handle operation: " + operation);
}

void Effects::draw(const EffectDraw& draw) {
  if (!exists(draw.handle)) return;
  GlBindings restore;
  const auto handle = lookup(impl_->handles, draw.handle, "handle");
  auto& context = lookup(impl_->contexts, handle.context, "context");
  Effekseer::Matrix44 projection, camera;
  std::memcpy(projection.Values, draw.projection.data(), sizeof(projection.Values));
  std::memcpy(camera.Values, draw.camera.data(), sizeof(camera.Values));
  context.renderer->SetProjectionMatrix(projection);
  context.renderer->SetCameraMatrix(camera);
  glViewport(static_cast<int>(draw.viewport[0]), static_cast<int>(draw.viewport[1]),
             static_cast<int>(draw.viewport[2]), static_cast<int>(draw.viewport[3]));
  context.renderer->BeginRendering();
  context.manager->DrawHandle(handle.handle);
  context.renderer->EndRendering();
}

std::array<std::uint32_t, 4> Effects::counts() const {
  std::uint32_t voices = 0;
  for (const auto& [id, context] : impl_->contexts) { (void)id; voices += context.sound->count(); }
  return {static_cast<std::uint32_t>(impl_->contexts.size()),
          static_cast<std::uint32_t>(impl_->effects.size()),
          static_cast<std::uint32_t>(impl_->handles.size()), voices};
}

}  // namespace pmjs

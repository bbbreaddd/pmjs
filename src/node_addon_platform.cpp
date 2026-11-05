#include "node_addon_internal.hpp"
#include <cmath>
#include <system_error>
#include <cerrno>

namespace pmjs::addon {
namespace {
std::uint64_t readPosition(napi_env env, napi_value value) {
  const double position = asNumber(env, value);
  if (!std::isfinite(position) || position < 0 || position > 9007199254740991.0 ||
      std::floor(position) != position) throw std::runtime_error("read position must be a non-negative safe integer");
  return static_cast<std::uint64_t>(position);
}
struct ReaderOwner {
  std::shared_ptr<pmjs::FileReader> reader;
  bool reading = false;
};
ReaderOwner& fileReader(napi_env env, napi_callback_info info) {
  napi_value self;
  check(env, napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr), "cannot read file receiver");
  void* reader = nullptr;
  check(env, napi_unwrap(env, self, &reader), "invalid file reader");
  if (!reader) throw std::runtime_error("invalid file reader");
  return *static_cast<ReaderOwner*>(reader);
}
const char* fileErrorCode(int code) {
  switch (code) {
    case EBADF: return "EBADF";
    case EISDIR: return "EISDIR";
    case EACCES: return "EACCES";
    case EINVAL: return "EINVAL";
    case EIO: return "EIO";
    case ENOENT: return "ENOENT";
    default: return "EIO";
  }
}
napi_value throwFileError(napi_env env, const std::exception& error) {
  const auto* system = dynamic_cast<const std::system_error*>(&error);
  napi_throw_error(env, system ? fileErrorCode(system->code().value()) : nullptr, error.what());
  return nullptr;
}
napi_value readFileChunk(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  const auto length = readPosition(env, args.at(0));
  if (length > 0xffffffffU) throw std::runtime_error("read size exceeds buffer limit");
  auto& owner = fileReader(env, info);
  if (!owner.reader) throw std::system_error(EBADF, std::generic_category(), "read");
  if (owner.reading) throw std::runtime_error("file read already in progress");
  const auto bytes = owner.reader->read(static_cast<std::size_t>(length));
  napi_value result;
  check(env, napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &result), "cannot create file chunk");
  return result;
} catch (const std::exception& error) { return throwFileError(env, error); }
napi_value closeFileReader(napi_env env, napi_callback_info info) try {
  // An active worker retains the descriptor until its completion on the main thread.
  fileReader(env, info).reader.reset();
  return undefined(env);
} catch (const std::exception& error) { return throwFileError(env, error); }

enum class FileOperation { bytes, open, chunk };
struct AsyncFileRead {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  napi_ref receiver = nullptr;
  std::shared_ptr<State> owner;
  std::shared_ptr<pmjs::FileReader> reader;
  ReaderOwner* receiverOwner = nullptr;
  FileOperation operation = FileOperation::bytes;
  std::string path, error;
  int errorCode = EIO;
  std::uint64_t start = 0;
  std::size_t length = 0;
  std::vector<std::uint8_t> bytes;
  bool missing = false;
  ~AsyncFileRead() {
    if (receiverOwner) receiverOwner->reading = false;
    if (receiver) napi_delete_reference(env, receiver);
    if (work) napi_delete_async_work(env, work);
  }
};
void rejectFileRead(napi_env env, napi_deferred deferred, const std::string& message, int code) {
  bool pending = false;
  napi_value error;
  napi_is_exception_pending(env, &pending);
  if (pending) napi_get_and_clear_last_exception(env, &error);
  else napi_create_error(env, string(env, fileErrorCode(code)), string(env, message), &error);
  napi_reject_deferred(env, deferred, error);
}
napi_value rejectedFileRead(napi_env env, const std::exception& error) {
  napi_value promise, original;
  napi_deferred deferred;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (pending) napi_get_and_clear_last_exception(env, &original);
  const auto* system = dynamic_cast<const std::system_error*>(&error);
  check(env, napi_create_promise(env, &deferred, &promise), "cannot create file promise");
  if (pending) napi_reject_deferred(env, deferred, original);
  else rejectFileRead(env, deferred, error.what(), system ? system->code().value() : EIO);
  return promise;
}
napi_value readFileChunkAsync(napi_env env, napi_callback_info info);
napi_value wrapReader(napi_env env, std::shared_ptr<pmjs::FileReader> reader) {
  auto owner = std::make_unique<ReaderOwner>();
  owner->reader = std::move(reader);
  napi_value result = moduleObject(env);
  method(env, result, "read", readFileChunk);
  method(env, result, "readAsync", readFileChunkAsync);
  method(env, result, "close", closeFileReader);
  check(env, napi_wrap(env, result, owner.get(), [](napi_env, void* value, void*) {
    delete static_cast<ReaderOwner*>(value);
  }, nullptr, nullptr), "cannot attach file reader");
  owner.release();
  return result;
}
void executeFileRead(napi_env, void* opaque) noexcept {
  auto& load = *static_cast<AsyncFileRead*>(opaque);
  try {
    if (load.operation != FileOperation::chunk) {
      load.reader = load.owner->vfs.openRead(load.path, load.start);
      if (!load.reader) { load.missing = true; return; }
    }
    if (load.operation == FileOperation::chunk) load.bytes = load.reader->read(load.length);
    else if (load.operation == FileOperation::bytes) {
      for (;;) {
        auto chunk = load.reader->read(64 * 1024);
        if (chunk.empty()) break;
        load.bytes.insert(load.bytes.end(), chunk.begin(), chunk.end());
      }
    }
  } catch (const std::system_error& error) {
    load.error = error.what(); load.errorCode = error.code().value();
  } catch (const std::exception& error) { load.error = error.what(); }
  catch (...) { load.error = "file read failed"; }
}
void completeFileRead(napi_env env, napi_status status, void* opaque) {
  std::unique_ptr<AsyncFileRead> load(static_cast<AsyncFileRead*>(opaque));
  try {
    if (status != napi_ok || !load->error.empty()) {
      rejectFileRead(env, load->deferred, load->error.empty() ? "file read cancelled" : load->error, load->errorCode);
      return;
    }
    napi_value result = null(env);
    if (!load->missing) {
      if (load->operation == FileOperation::open) result = wrapReader(env, std::move(load->reader));
      else check(env, napi_create_buffer_copy(env, load->bytes.size(), load->bytes.data(), nullptr, &result),
        "cannot create file bytes");
    }
    napi_resolve_deferred(env, load->deferred, result);
  } catch (const std::exception& error) {
    rejectFileRead(env, load->deferred, error.what(), EIO);
  }
}
napi_value queueFileRead(napi_env env, std::unique_ptr<AsyncFileRead> load) {
  load->env = env;
  napi_value promise;
  check(env, napi_create_promise(env, &load->deferred, &promise), "cannot create file promise");
  try {
    check(env, napi_create_async_work(env, nullptr, string(env, "pmjs.file.read"),
      executeFileRead, completeFileRead, load.get(), &load->work), "cannot create file work");
    check(env, napi_queue_async_work(env, load->work), "cannot queue file read");
    load.release();
  } catch (const std::exception& error) {
    rejectFileRead(env, load->deferred, error.what(), EIO);
  }
  return promise;
}
napi_value readFileChunkAsync(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  auto load = std::make_unique<AsyncFileRead>();
  load->operation = FileOperation::chunk;
  load->length = readPosition(env, args.at(0));
  if (load->length > 0xffffffffU) throw std::runtime_error("read size exceeds buffer limit");
  auto& owner = fileReader(env, info);
  if (!owner.reader) throw std::system_error(EBADF, std::generic_category(), "read");
  if (owner.reading) throw std::runtime_error("file read already in progress");
  napi_value self;
  check(env, napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr), "cannot read file receiver");
  check(env, napi_create_reference(env, self, 1, &load->receiver), "cannot retain file reader");
  load->reader = owner.reader;
  load->receiverOwner = &owner;
  owner.reading = true;
  return queueFileRead(env, std::move(load));
} catch (const std::exception& error) { return rejectedFileRead(env, error); }
napi_value openRead(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2);
  const auto start = args.size() > 1 ? readPosition(env, args[1]) : 0;
  auto reader = host(env).vfs.openRead(asString(env, args.at(0)), start);
  return reader ? wrapReader(env, std::move(reader)) : null(env);
} catch (const std::exception& error) { return throwFileError(env, error); }
napi_value openReadAsync(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2);
  host(env);
  auto load = std::make_unique<AsyncFileRead>();
  load->owner = state;
  load->operation = FileOperation::open;
  load->path = asString(env, args.at(0));
  load->start = args.size() > 1 ? readPosition(env, args[1]) : 0;
  return queueFileRead(env, std::move(load));
} catch (const std::exception& error) { return rejectedFileRead(env, error); }
napi_value readBytesAsync(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  host(env);
  auto load = std::make_unique<AsyncFileRead>();
  load->owner = state;
  load->path = asString(env, args.at(0));
  return queueFileRead(env, std::move(load));
} catch (const std::exception& error) { return rejectedFileRead(env, error); }
}

napi_value updateWritableOverlay(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  auto strings = [&](napi_value array) {
    std::uint32_t count;
    check(env, napi_get_array_length(env, array, &count), "overlay update requires arrays");
    std::vector<std::string> values;
    for (std::uint32_t i = 0; i < count; ++i) {
      napi_value value;
      check(env, napi_get_element(env, array, i, &value), "cannot read overlay update");
      values.push_back(asString(env, value));
    }
    return values;
  };
  host(env).vfs.updateWritableOverlay(strings(args.at(0)), strings(args.at(1)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value mountWritableOverlay(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  host(env).vfs.mountWritableOverlay(asString(env, args.at(0)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value readText(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  auto value = host(env).vfs.readText(asString(env, args.at(0)));
  if (!value) { napi_value result; napi_get_null(env, &result); return result; }
  return string(env, *value);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value readBytes(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  auto value = host(env).vfs.readBytes(asString(env, args.at(0)));
  if (!value) { napi_value result; napi_get_null(env, &result); return result; }
  void* destination = nullptr;
  napi_value result;
  napi_create_arraybuffer(env, value->size(), &destination, &result);
  if (!value->empty()) std::memcpy(destination, value->data(), value->size());
  return result;
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value exists(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  return boolean(env, host(env).vfs.exists(asString(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value resolvePath(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  const auto value = host(env).vfs.resolvePath(asString(env, args.at(0)));
  if (value) return string(env, value->string());
  napi_value result;
  napi_get_null(env, &result);
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value isDirectory(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  return boolean(env, host(env).vfs.isDirectory(asString(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value inventory(napi_env env, napi_callback_info) try {
  const auto files = host(env).vfs.inventory();
  napi_value result;
  check(env, napi_create_array_with_length(env, files.size(), &result), "cannot create file inventory");
  for (std::size_t i = 0; i < files.size(); ++i)
    check(env, napi_set_element(env, result, i, string(env, files[i])), "cannot set inventory entry");
  return result;
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }

napi_value readDirectory(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  auto entries = host(env).vfs.readDirectory(asString(env, args.at(0)));
  if (!entries) throw std::runtime_error("cannot read directory");
  napi_value result;
  check(env, napi_create_array_with_length(env, entries->size(), &result), "cannot create directory entries");
  for (std::size_t index = 0; index < entries->size(); ++index) {
    check(env, napi_set_element(env, result, index, string(env, (*entries)[index])), "cannot set directory entry");
  }
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value setTextInput(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  host(env).platform.setTextInput(asBoolean(env, args.at(0)));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value inputSnapshot(napi_env env, napi_callback_info) try {
  auto& platform = host(env).platform;
  napi_value result = moduleObject(env);
  auto integers = [&](const char* name, const std::vector<int>& values) {
    napi_value array;
    check(env, napi_create_array_with_length(env, values.size(), &array), "cannot create input array");
    for (std::size_t i = 0; i < values.size(); ++i)
      check(env, napi_set_element(env, array, i, uint32(env, values[i])), "cannot set input value");
    check(env, napi_set_named_property(env, result, name, array), "cannot set input array");
  };
  integers("keysDown", platform.keysDown());
  integers("keysPressed", platform.keysPressed());
  napi_value events;
  check(env, napi_create_array_with_length(env, platform.keyEvents().size(), &events), "cannot create key events");
  for (std::size_t i = 0; i < platform.keyEvents().size(); ++i) {
    const auto& key = platform.keyEvents()[i];
    napi_value event = moduleObject(env);
    check(env, napi_set_named_property(env, event, "keyCode", uint32(env, key.keyCode)), "cannot set key code");
    check(env, napi_set_named_property(env, event, "down", boolean(env, key.down)), "cannot set key state");
    check(env, napi_set_named_property(env, event, "repeat", boolean(env, key.repeat)), "cannot set repeat");
    check(env, napi_set_named_property(env, event, "capsLock", boolean(env, key.capsLock)), "cannot set caps lock");
    check(env, napi_set_named_property(env, event, "code", string(env, key.code)), "cannot set code");
    check(env, napi_set_named_property(env, event, "key", string(env, key.key)), "cannot set key");
    if (!key.text.empty())
      check(env, napi_set_named_property(env, event, "text", string(env, key.text)), "cannot set key text");
    check(env, napi_set_named_property(env, event, "shift", boolean(env, key.shift)), "cannot set shift");
    check(env, napi_set_named_property(env, event, "ctrl", boolean(env, key.ctrl)), "cannot set ctrl");
    check(env, napi_set_named_property(env, event, "alt", boolean(env, key.alt)), "cannot set alt");
    check(env, napi_set_named_property(env, event, "meta", boolean(env, key.meta)), "cannot set meta");
    check(env, napi_set_element(env, events, i, event), "cannot set key event");
  }
  check(env, napi_set_named_property(env, result, "keyEvents", events), "cannot set key events");
  platform.clearKeyEvents();
  napi_value pointers;
  check(env, napi_create_array_with_length(env, platform.pointerEvents().size(), &pointers), "cannot create pointer events");
  for (std::size_t i = 0; i < platform.pointerEvents().size(); ++i) {
    const auto& source = platform.pointerEvents()[i];
    napi_value event = moduleObject(env);
    check(env, napi_set_named_property(env, event, "type", string(env, source.type)), "cannot set pointer type");
    check(env, napi_set_named_property(env, event, "x", number(env, source.x)), "cannot set pointer x");
    check(env, napi_set_named_property(env, event, "y", number(env, source.y)), "cannot set pointer y");
    check(env, napi_set_named_property(env, event, "button", uint32(env, source.button)), "cannot set pointer button");
    check(env, napi_set_named_property(env, event, "buttons", uint32(env, source.buttons)), "cannot set pointer buttons");
    check(env, napi_set_named_property(env, event, "deltaX", number(env, source.deltaX)), "cannot set pointer delta x");
    check(env, napi_set_named_property(env, event, "deltaY", number(env, source.deltaY)), "cannot set pointer delta y");
    check(env, napi_set_named_property(env, event, "cancelled", boolean(env, source.cancelled)), "cannot set pointer cancellation");
    check(env, napi_set_element(env, pointers, i, event), "cannot set pointer event");
  }
  check(env, napi_set_named_property(env, result, "pointerEvents", pointers), "cannot set pointer events");
  platform.clearPointerEvents();
  const auto pads = platform.gamepads();
  napi_value gamepads;
  check(env, napi_create_array_with_length(env, pads.size(), &gamepads), "cannot create gamepads");
  for (std::size_t index = 0; index < pads.size(); ++index) {
    napi_value pad = moduleObject(env);
    check(env, napi_set_named_property(env, pad, "index", uint32(env, pads[index].index)), "cannot set pad index");
    check(env, napi_set_named_property(env, pad, "instance", uint32(env, pads[index].instance)), "cannot set pad instance");
    check(env, napi_set_named_property(env, pad, "connected", boolean(env, pads[index].connected)), "cannot set pad connection");
    check(env, napi_set_named_property(env, pad, "id", string(env, pads[index].id)), "cannot set pad id");
    auto padIntegers = [&](const char* name, const std::vector<int>& values) {
      napi_value array;
      check(env, napi_create_array_with_length(env, values.size(), &array), "cannot create pad buttons");
      for (std::size_t i = 0; i < values.size(); ++i)
        check(env, napi_set_element(env, array, i, uint32(env, values[i])), "cannot set pad button");
      check(env, napi_set_named_property(env, pad, name, array), "cannot set pad buttons");
    };
    padIntegers("buttonsDown", pads[index].buttonsDown);
    padIntegers("buttonsPressed", pads[index].buttonsPressed);
    napi_value padAxes;
    check(env, napi_create_array_with_length(env, pads[index].axes.size(), &padAxes), "cannot create pad axes");
    for (std::size_t i = 0; i < pads[index].axes.size(); ++i)
      check(env, napi_set_element(env, padAxes, i, number(env, pads[index].axes[i])), "cannot set pad axis");
    check(env, napi_set_named_property(env, pad, "axes", padAxes), "cannot set pad axes");
    check(env, napi_set_element(env, gamepads, index, pad), "cannot set gamepad");
  }
  check(env, napi_set_named_property(env, result, "gamepads", gamepads), "cannot set gamepads");
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value inputConsumePressed(napi_env env, napi_callback_info) try {
  host(env).platform.consumePressed();
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

void registerPlatformBindings(napi_env env, napi_value exports) {
  napi_value fs = moduleObject(env);
  method(env, fs, "mountWritableOverlay", mountWritableOverlay);
  method(env, fs, "updateWritableOverlay", updateWritableOverlay);
  method(env, fs, "readText", readText);
  method(env, fs, "readBytes", readBytes);
  method(env, fs, "readBytesAsync", readBytesAsync);
  method(env, fs, "openRead", openRead);
  method(env, fs, "openReadAsync", openReadAsync);
  method(env, fs, "readDirectory", readDirectory);
  method(env, fs, "inventory", inventory);
  method(env, fs, "exists", exists);
  method(env, fs, "resolvePath", resolvePath);
  method(env, fs, "isDirectory", isDirectory);
  napi_value input = moduleObject(env);
  method(env, input, "snapshot", inputSnapshot);
  method(env, input, "setTextInput", setTextInput);
  method(env, input, "consumePressed", inputConsumePressed);
  check(env, napi_set_named_property(env, exports, "fs", fs), "cannot export fs module");
  check(env, napi_set_named_property(env, exports, "input", input), "cannot export input module");
}

}  // namespace pmjs::addon

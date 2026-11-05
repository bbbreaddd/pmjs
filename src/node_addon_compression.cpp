#include "node_addon_internal.hpp"

#include <limits>
#include <string_view>

namespace pmjs::addon {
namespace {
constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

std::u16string inputString(napi_env env, napi_value input) {
  std::size_t length = 0;
  check(env, napi_get_value_string_utf16(env, input, nullptr, 0, &length), "expected string");
  std::u16string result(length + 1, 0);
  check(env, napi_get_value_string_utf16(env, input, result.data(), result.size(), &length), "cannot read string");
  result.resize(length);
  return result;
}

napi_value outputString(napi_env env, const std::u16string& input) {
  napi_value result;
  check(env, napi_create_string_utf16(env, input.data(), input.size(), &result), "cannot create string");
  return result;
}

struct Writer {
  std::u16string words;
  unsigned value = 0, position = 0;
  void bit(unsigned input) {
    value = (value << 1) | input;
    if (++position == 16) { words.push_back(static_cast<char16_t>(value)); value = position = 0; }
  }
  void bits(unsigned count, std::size_t input) {
    for (unsigned i = 0; i < count; ++i) { bit(input & 1); input >>= 1; }
  }
};

std::u16string compress(const std::u16string& input) {
  std::unordered_map<std::uint64_t, std::size_t> dictionary;
  std::vector<std::size_t> characters(65536, 0);
  std::vector<int> literals(3, -1);
  std::size_t next = 3, remaining = 2;
  unsigned width = 2;
  Writer writer;
  auto grow = [&] { if (--remaining == 0) { remaining = std::size_t{1} << width; ++width; } };
  auto emit = [&](std::size_t code) {
    if (literals[code] >= 0) {
      const unsigned value = static_cast<unsigned>(literals[code]);
      writer.bits(width, value < 256 ? 0 : 1);
      writer.bits(value < 256 ? 8 : 16, value);
      literals[code] = -1;
      grow();
    } else writer.bits(width, code);
    grow();
  };
  std::size_t word = 0;
  for (char16_t unit : input) {
    if (!characters[unit]) { characters[unit] = next++; literals.push_back(unit); }
    if (!word) { word = characters[unit]; continue; }
    const auto combined = (static_cast<std::uint64_t>(word) << 16) | unit;
    const auto found = dictionary.find(combined);
    if (found != dictionary.end()) { word = found->second; continue; }
    emit(word);
    dictionary.emplace(combined, next++);
    literals.push_back(-1);
    word = characters[unit];
  }
  if (word) emit(word);
  writer.bits(width, 2);
  do { writer.bit(0); } while (writer.position != 0);
  std::string bytes;
  for (char16_t unit : writer.words) { bytes.push_back(unit >> 8); bytes.push_back(unit & 255); }
  std::u16string encoded;
  for (std::size_t i = 0; i < bytes.size(); i += 3) {
    const unsigned a = static_cast<unsigned char>(bytes[i]);
    const unsigned b = i + 1 < bytes.size() ? static_cast<unsigned char>(bytes[i + 1]) : 0;
    const unsigned c = i + 2 < bytes.size() ? static_cast<unsigned char>(bytes[i + 2]) : 0;
    encoded.push_back(alphabet[a >> 2]); encoded.push_back(alphabet[((a & 3) << 4) | (b >> 4)]);
    encoded.push_back(i + 1 < bytes.size() ? alphabet[((b & 15) << 2) | (c >> 6)] : '=');
    encoded.push_back(i + 2 < bytes.size() ? alphabet[c & 63] : '=');
  }
  return encoded;
}

struct Reader {
  const std::u16string& words;
  std::size_t index = 1;
  unsigned position = 32768, value;
  explicit Reader(const std::u16string& input) : words(input), value(input.front()) {}
  std::size_t bits(unsigned count) {
    if (count >= std::numeric_limits<std::size_t>::digits) throw std::runtime_error("invalid LZString code width");
    std::size_t result = 0;
    for (unsigned i = 0; i < count; ++i) {
      if (value & position) result |= std::size_t{1} << i;
      position >>= 1;
      if (position == 0) { position = 32768; value = index < words.size() ? words[index] : 0; ++index; }
    }
    return result;
  }
};

std::optional<std::u16string> decompress(const std::u16string& encoded, bool& undefinedResult) {
  std::vector<int> codes;
  for (char16_t unit : encoded) {
    const auto at = unit < 128 ? alphabet.find(static_cast<char>(unit)) : std::string_view::npos;
    if (at != std::string_view::npos) codes.push_back(static_cast<int>(at));
  }
  // The legacy Base64 wrapper pairs decoded bytes into big-endian words.
  std::u16string words;
  unsigned pending = 0;
  std::size_t count = 0;
  for (std::size_t i = 0; i < codes.size(); i += 4) {
    auto code = [&](std::size_t offset) { return i + offset < codes.size() ? codes[i + offset] : 0; };
    const int a = code(0), b = code(1), c = code(2), d = code(3);
    const unsigned first = (a << 2) | (b >> 4), second = ((b & 15) << 4) | (c >> 2), third = ((c & 3) << 6) | d;
    if (count % 2 == 0) {
      pending = first << 8;
      if (c != 64) words.push_back(static_cast<char16_t>(pending | second));
      if (d != 64) pending = third << 8;
    } else {
      words.push_back(static_cast<char16_t>(pending | first));
      if (c != 64) pending = second << 8;
      if (d != 64) words.push_back(static_cast<char16_t>(pending | third));
    }
    count += 3;
  }
  if (words.empty()) return std::nullopt;
  Reader reader(words);
  const auto initial = reader.bits(2);
  if (initial == 2) return std::u16string{};
  bool missingWord = initial == 3;
  std::u16string word = missingWord ? u"undefined"
    : std::u16string(1, static_cast<char16_t>(reader.bits(initial == 0 ? 8 : 16)));
  std::vector<std::u16string> dictionary(3);
  dictionary.push_back(missingWord ? std::u16string{} : word);
  auto output = word;
  bool missingOutput = missingWord;
  std::size_t remaining = 4;
  unsigned width = 3;
  auto grow = [&] { if (remaining == 0) { remaining = std::size_t{1} << width; ++width; } };
  for (;;) {
    if (reader.index > words.size()) return std::u16string{};
    auto code = reader.bits(width);
    if (code == 2) { undefinedResult = missingOutput; return output; }
    if (code < 2) {
      dictionary.emplace_back(1, static_cast<char16_t>(reader.bits(code == 0 ? 8 : 16)));
      code = dictionary.size() - 1;
      --remaining;
    }
    grow();
    std::u16string entry;
    if (code < dictionary.size() && !dictionary[code].empty()) entry = dictionary[code];
    else if (code == dictionary.size()) {
      if (missingWord) throw std::invalid_argument("invalid LZString dictionary entry");
      entry = word + word.front();
    }
    else return std::nullopt;
    output += entry;
    missingOutput = false;
    dictionary.push_back(word + entry.front());
    --remaining;
    word = std::move(entry);
    missingWord = false;
    grow();
  }
}

napi_value compressLZString(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  if (args.empty()) return throwTypeError(env, "expected string");
  return outputString(env, compress(inputString(env, args[0])));
} catch (const std::exception& error) { return throwException(env, error); }

napi_value decompressLZString(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  if (args.empty()) return throwTypeError(env, "expected string");
  bool undefinedResult = false;
  const auto result = decompress(inputString(env, args[0]), undefinedResult);
  if (undefinedResult) return undefined(env);
  return result ? outputString(env, *result) : null(env);
} catch (const std::exception& error) { return throwException(env, error); }
}

void registerCompressionBindings(napi_env env, napi_value exports) {
  auto compression = moduleObject(env);
  method(env, compression, "compressLZString", compressLZString);
  method(env, compression, "decompressLZString", decompressLZString);
  check(env, napi_set_named_property(env, exports, "compression", compression), "cannot register compression");
}
}

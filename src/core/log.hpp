#pragma once

#include <chrono>
#include <cstdio>
#include <ctime>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>

namespace pmjs {

enum class LogLevel { Info, Warning, Error };

class Log {
 public:
  explicit Log(LogLevel level = LogLevel::Info) : level_(level) {}
  Log(const Log&) = delete;
  Log& operator=(const Log&) = delete;

  template <typename T>
  Log& operator<<(const T& value) {
    buffer_ << value;
    return *this;
  }

  Log& operator<<(std::ostream& (*manipulator)(std::ostream&)) {
    manipulator(buffer_);
    return *this;
  }

  ~Log() noexcept {
    try {
      const auto now = std::chrono::system_clock::now();
      const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count() % 1000;
      const std::time_t time = std::chrono::system_clock::to_time_t(now);
      std::tm utc{};
      gmtime_r(&time, &utc);
      const char* levelText = level_ == LogLevel::Error ? "ERROR" :
                              level_ == LogLevel::Warning ? "WARN" : "INFO";
      char prefix[40];
      const int prefixLen = std::snprintf(
          prefix, sizeof(prefix),
          "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ %s ",
          utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday,
          utc.tm_hour, utc.tm_min, utc.tm_sec,
          static_cast<int>(milliseconds), levelText);
      std::string text = buffer_.str();
      if (!text.empty() && text.back() == '\n') text.pop_back();
      std::string output;
      const std::size_t prefixSize = prefixLen > 0 ? static_cast<std::size_t>(prefixLen) : 0;
      output.reserve(prefixSize + text.size() + 1);
      std::size_t start = 0;
      do {
        const auto end = text.find('\n', start);
        output.append(prefix, prefixSize);
        output.append(text, start, end == std::string::npos ? text.size() - start : end - start);
        output.push_back('\n');
        if (end == std::string::npos) break;
        start = end + 1;
      } while (start < text.size());
      static std::mutex mutex;
      const std::lock_guard lock(mutex);
      std::cerr.write(output.data(), static_cast<std::streamsize>(output.size()));
      std::cerr.flush();
    } catch (...) {
      // Logging must not replace an exception already unwinding.
    }
  }

 private:
  LogLevel level_;
  std::ostringstream buffer_;
};

}  // namespace pmjs

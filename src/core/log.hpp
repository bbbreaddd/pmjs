#pragma once

#include <chrono>
#include <ctime>
#include <iomanip>
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
      std::ostringstream prefix;
      prefix << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S.")
             << std::setfill('0') << std::setw(3) << milliseconds << "Z "
             << (level_ == LogLevel::Error ? "ERROR" : level_ == LogLevel::Warning ? "WARN" : "INFO") << ' ';
      std::string text = buffer_.str();
      if (!text.empty() && text.back() == '\n') text.pop_back();
      static std::mutex mutex;
      const std::lock_guard lock(mutex);
      std::size_t start = 0;
      do {
        const auto end = text.find('\n', start);
        std::cerr << prefix.str() << text.substr(start, end - start) << '\n';
        if (end == std::string::npos) break;
        start = end + 1;
      } while (start < text.size());
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

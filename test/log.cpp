#include "core/log.hpp"

#include <regex>
#include <stdexcept>
#include <thread>
#include <vector>

int main() {
  std::ostringstream captured;
  auto* previous = std::cerr.rdbuf(captured.rdbuf());
  pmjs::Log() << "[pmjs] started count=" << 2;
  pmjs::Log(pmjs::LogLevel::Warning) << "[pmjs] fallback\n";
  pmjs::Log(pmjs::LogLevel::Error) << "[pmjs] failed\n  at script.js:12";
  std::vector<std::thread> writers;
  for (int index = 0; index < 3; ++index) {
    writers.emplace_back([index] {
      for (int message = 0; message < 20; ++message)
        pmjs::Log() << "[worker] id=" << index << " message=" << message;
    });
  }
  for (auto& writer : writers) writer.join();
  std::cerr.rdbuf(previous);

  const std::regex row(R"(^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR) .+$)");
  std::istringstream input(captured.str());
  std::string line;
  int count = 0;
  while (std::getline(input, line)) {
    if (!std::regex_match(line, row)) throw std::runtime_error("invalid log line: " + line);
    ++count;
    if (count == 1 && !line.ends_with("INFO [pmjs] started count=2")) throw std::runtime_error("missing info");
    if (count == 2 && !line.ends_with("WARN [pmjs] fallback")) throw std::runtime_error("missing warning");
    if (count == 3 && !line.ends_with("ERROR [pmjs] failed")) throw std::runtime_error("missing error");
    if (count == 4 && !line.ends_with("ERROR   at script.js:12")) throw std::runtime_error("missing stack line");
    if (count > 4 && line.find("INFO [worker] id=") == std::string::npos) throw std::runtime_error("interleaved log");
  }
  if (count != 64) throw std::runtime_error("lost or added log lines");
}

#include "text_backend.hpp"
#include <cstdlib>
#include <stdexcept>
#include <string>

int main() {
  unsetenv("PMJS_TEXT_BACKEND");
  if (std::string(pmjs::TextBackend().name()) != "freetype") return 1;
  for (const auto* choice : {"skia65", "unknown"}) {
    setenv("PMJS_TEXT_BACKEND", choice, 1);
    try { pmjs::TextBackend unavailable; return 2; }
    catch (const std::runtime_error& error) {
      const std::string message = error.what();
      if (message.find("PMJS_TEXT_BACKEND") == std::string::npos) return 3;
      if (std::string(choice) == "skia65" && message.find("unavailable") == std::string::npos) return 4;
    }
  }
}

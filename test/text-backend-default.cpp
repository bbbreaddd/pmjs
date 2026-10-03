#include "text_backend.hpp"
#include <cstdlib>
#include <stdexcept>
#include <string>

int main() {
  unsetenv("PMJS_TEXT_BACKEND");
  if (std::string(pmjs::TextBackend().name()) != "skia65") return 1;
  setenv("PMJS_TEXT_BACKEND", "freetype", 1);
  if (std::string(pmjs::TextBackend().name()) != "freetype") return 2;
  setenv("PMJS_TEXT_BACKEND", "invalid", 1);
  try { pmjs::TextBackend backend; return 3; }
  catch (const std::runtime_error&) {}
}

#include "mv_engine.hpp"
#include "mv_windows.hpp"
#include <algorithm>
#include <cctype>

namespace pmjs::mv {
bool Session::updateMessageText(bool ok, bool cancel) {
  auto& message = message_;
  if (message.openness < 255) return true;
  if (!message.revealPrepared) {
    message.expandedLines.clear();
    for (const auto& line : message.lines) message.expandedLines.push_back(Window_Base::processEscapeCodes(line.text(),*this));
    message.revealLengths.assign(message.lines.size(),0); message.revealPrepared = true;
  }
  if (message.revealPage != message.firstLine) {
    message.revealPage = message.firstLine; message.revealLine = message.firstLine; message.revealOffset = 0;
    message.revealFinished = false; message.textPaused = false; message.finalPause = false;
    message.lineFast = false; message.showFast = false; message.pauseSkip = false; message.textWait = 0; message.revealedCount = 0;
  }
  if (message.textWait > 0) { --message.textWait; return true; }
  if (message.textPaused) {
    if (ok || cancel) { message.textPaused = false; if (message.finalPause) return false; }
    return true;
  }
  const auto finishPage = [&] {
    message.revealFinished = true;
    const bool lastPage = message.pageEnd() >= static_cast<int>(message.lines.size());
    if (lastPage && (!message.choices.empty() || ui_.maxDigits > 0 || ui_.variableId > 0)) return false;
    if (message.pauseSkip && lastPage) { acknowledge(); return true; }
    message.textPaused = true; message.finalPause = true; message.textWait = 10;
    return true;
  };
  if (message.revealFinished) return finishPage();
  if (ok || cancel) message.showFast = true;
  while (message.revealLine < message.pageEnd()) {
    if (message.pauseIndex < message.pauses.size() && message.revealedCount >= message.pauses[message.pauseIndex]) {
      ++message.pauseIndex; message.textPaused = true; message.textWait = 10; return true;
    }
    const auto& text = message.expandedLines[message.revealLine];
    if (message.revealOffset >= text.size()) {
      ++message.revealLine; message.revealOffset = 0; message.lineFast = false;
      if (!message.showFast) break;
      continue;
    }
    const auto at = message.revealOffset;
    const auto lead = static_cast<unsigned char>(text[at]);
    bool glyph = true;
    if (lead == 0x1b && at+1 < text.size()) {
      const char code = std::toupper(static_cast<unsigned char>(text[at+1]));
      message.revealOffset += 2; glyph = false;
      if ((code >= 'A' && code <= 'Z') && message.revealOffset < text.size() && text[message.revealOffset]=='[') {
        const auto end = text.find(']',message.revealOffset+1);
        if (end != std::string::npos) message.revealOffset = end+1;
      }
      if (code == '.') message.textWait = 15;
      else if (code == '|') message.textWait = 60;
      else if (code == '!') { message.textPaused = true; message.textWait = 10; }
      else if (code == '>') message.lineFast = true;
      else if (code == '<') message.lineFast = false;
      else if (code == '^') message.pauseSkip = true;
      else if (code == '$') message.goldWindow = true;
      else if (code == 'I') glyph = true;
    } else {
      const std::size_t bytes = (lead&0xe0)==0xc0 ? 2 : (lead&0xf0)==0xe0 ? 3 : (lead&0xf8)==0xf0 ? 4 : 1;
      message.revealOffset = std::min(text.size(),at+bytes);
    }
    message.revealLengths[message.revealLine] = message.revealOffset;
    if (glyph) ++message.revealedCount;
    messageAge_ = message.revealedCount+8;
    if (message.revealLine + 1 == message.pageEnd() && message.revealOffset >= text.size()) { finishPage(); return true; }
    if (message.textWait > 0 || message.textPaused || (!message.showFast && !message.lineFast)) break;
  }
  if (message.revealLine >= message.pageEnd()) finishPage();
  return true;
}
}  // namespace pmjs::mv

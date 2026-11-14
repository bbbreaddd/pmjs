#include "mv_engine.hpp"
#include "mv_windows.hpp"
#include <algorithm>
#include <cctype>
#include <stdexcept>

namespace pmjs::mv {
void Session::dispatchMessage(const std::string& method, const Value::Array& arguments) {
  const auto scripted = runtimeHooks_ && runtimeHooks_->message ? runtimeHooks_->message(method, arguments) : std::optional<bool>{};
  if (!scripted) invokeMessageBase(method, arguments);
}
bool Session::messageBusy() {
  const auto scripted = runtimeHooks_ && runtimeHooks_->message ? runtimeHooks_->message("isBusy", {}) : std::optional<bool>{};
  return scripted ? *scripted : invokeMessageBase("isBusy").boolean();
}
Value Session::runtimeMessageField(const std::string& field, const std::optional<Value>& value) {
  if (field == "_faceName") { if (value) message_.faceName = value->text(); return message_.faceName; }
  int* target = nullptr;
  if (field == "_faceIndex") target = &message_.faceIndex;
  else if (field == "_background") target = &message_.background;
  else if (field == "_positionType") target = &message_.position;
  else if (field == "_choiceBackground") target = &message_.choiceBackground;
  else if (field == "_choicePositionType") target = &message_.choicePosition;
  else throw std::invalid_argument("message field is not bound: " + field);
  if (value) *target = value->integer();
  return *target;
}
Value Session::invokeMessageBase(const std::string& method, const Value::Array& args) {
  const auto argument = [&](std::size_t index) -> const Value& {
    if (index >= args.size()) throw std::invalid_argument("missing message argument");
    return args[index];
  };
  if (method == "clear") {
    const auto openness = message_.openness, previous = message_.previousOpenness;
    const bool started = message_.windowStarted, closing = message_.closing;
    message_ = {}; message_.openness = openness; message_.previousOpenness = previous;
    message_.windowStarted = started; message_.closing = closing;
    messageAge_ = 0; messageOwnerSerial_ = 0;
  }
  else if (method == "add") {
    message_.lines.push_back(argument(0)); message_.busy = true;
    if (message_.closing && closingMessage_ && closingMessage_->background == message_.background && closingMessage_->position == message_.position)
      message_.closing = false;
    message_.revealPrepared = false; message_.revealPage = -1;
  } else if (method == "setFaceImage") { message_.faceName = argument(0).text(); message_.faceIndex = argument(1).integer(); }
  else if (method == "setBackground") message_.background = argument(0).integer();
  else if (method == "setPositionType") message_.position = argument(0).integer();
  else if (method == "setChoices") {
    message_.choices = argument(0).array(); message_.defaultChoice = argument(1).integer(); message_.cancelChoice = argument(2).integer();
    message_.busy = !message_.lines.empty() || !message_.choices.empty() || message_.numberVariableId > 0 || message_.itemVariableId > 0;
  }
  else if (method == "setChoiceBackground") message_.choiceBackground = argument(0).integer();
  else if (method == "setChoicePositionType") message_.choicePosition = argument(0).integer();
  else if (method == "choiceDefaultType") return message_.defaultChoice;
  else if (method == "choiceCancelType") return message_.cancelChoice;
  else if (method == "choiceBackground") return message_.choiceBackground;
  else if (method == "choicePositionType") return message_.choicePosition;
  else if (method == "faceName") return message_.faceName;
  else if (method == "faceIndex") return message_.faceIndex;
  else if (method == "background") return message_.background;
  else if (method == "positionType") return message_.position;
  else if (method == "hasText") return !message_.lines.empty();
  else if (method == "isBusy") return message_.busy;
  else if (method == "isChoice") return !message_.choices.empty();
  else if (method == "isNumberInput") return message_.numberVariableId > 0;
  else if (method == "isItemChoice") return message_.itemVariableId > 0;
  else if (method == "isScrollMode") return message_.scrolling;
  else if (method == "scrollSpeed") return message_.scrollSpeed;
  else if (method == "scrollNoFast") return message_.scrollNoFast;
  else if (method == "layoutLines") { Value::Array lines; for (const auto& line : message_.expandedLines) lines.emplace_back(line); return lines; }
  else if (method == "setScroll") { message_.scrolling = true; message_.scrollSpeed = argument(0).number(); message_.scrollNoFast = argument(1).boolean(); }
  else if (method == "allText") {
    std::string text;
    for (const auto& line : message_.lines) { if (!text.empty()) text += '\n'; text += line.text(); }
    return text;
  } else throw std::invalid_argument("message method is not bound: " + method);
  return Value::undefined();
}
void Session::setupChoices(Interpreter& context, const Value& parameters) {
  dispatchInterpreterControl(context, "setupChoices", {parameters});
}
void Session::setupChoicesBase(Interpreter& context, const Value& parameters) {
  if (!context.serial) context.serial = ++nextInterpreterSerial_;
  messageOwnerSerial_ = context.serial;
  const int count = static_cast<int>(parameters[0].array().size());
  const int cancel = parameters[1].integer() >= count ? -2 : parameters[1].integer();
  dispatchMessage("setChoices", {parameters[0], parameters[2], cancel});
  dispatchMessage("setChoiceBackground", {parameters[4]}); dispatchMessage("setChoicePositionType", {parameters[3].null() ? Value(2) : parameters[3]});
  message_.choiceIndent = context.runtime->indent;
  if (runtimeHooks_ && runtimeHooks_->setupChoiceCallback) runtimeHooks_->setupChoiceCallback(context.runtime);
}
void Session::jumpTo(Interpreter& context, int index) {
  dispatchInterpreterControl(context, "jumpTo", {index});
}
void Session::jumpToBase(Interpreter& context, int index) {
  if (index < 0 || index >= static_cast<int>(context.list.size()) || context.index < 0 || context.index >= static_cast<int>(context.list.size()))
    throw std::invalid_argument("jump target or current position is outside the command list");
  int indent = context.runtime->indent;
  for (int i = std::min(index, context.index); i <= std::max(index, context.index); ++i) {
    const int next = context.list[i]["indent"].integer();
    if (next != indent) { context.branches[indent] = Value{}; indent = next; }
  }
  context.index = index;
}
void Session::dispatchInterpreterControl(Interpreter& context, const std::string& method, const Value::Array& arguments) {
  const auto object = context.runtime;
  if (!runtimeHooks_ || !runtimeHooks_->interpreterControl || !runtimeHooks_->interpreterControl(object, method, arguments))
    invokeInterpreterControl(object, method, arguments);
}
void Session::invokeInterpreterControl(const std::shared_ptr<RuntimeInterpreter>& object, const std::string& method, const Value::Array& args) {
  InterpreterOperation operation(activeInterpreterOperations_, object);
  auto* context = findRuntimeInterpreter(object);
  if (!context) throw std::runtime_error("interpreter is no longer attached to the session");
  if (args.size() != 1) throw std::invalid_argument("interpreter control requires one argument");
  if (method == "jumpTo") jumpToBase(*context, args[0].integer());
  else if (method == "setupChoices") setupChoicesBase(*context, args[0]);
  else if (method == "setupNumInput" || method == "setupItemChoice") {
    if (!context->serial) context->serial = ++nextInterpreterSerial_;
    messageOwnerSerial_ = context->serial;
    dialogEventCommand({method == "setupNumInput" ? 103 : 104, 0, args[0]}, *context);
  } else throw std::invalid_argument("interpreter control is not bound: " + method);
}
bool Session::updateMessageText(bool ok, bool cancel) {
  auto& message = message_;
  if (message.lines.empty()) { Window_Message::startInput(*this); return false; }
  if (!message.revealPrepared) {
    std::string text;
    for (std::size_t index = 0; index < message.lines.size(); ++index) {
      if (index) text += message.pageBreaks.contains(static_cast<int>(index)) ? '\f' : '\n';
      text += message.lines[index].text();
    }
    text = Window_Base::processEscapeCodes(text,*this);
    if (messageTextLayoutResolver_) text = messageTextLayoutResolver_(text, !message.faceName.empty());
    message.expandedLines.clear();
    std::set<int> updatedBreaks;
    std::size_t start = 0;
    for (;;) {
      const auto boundary = text.find_first_of("\n\f",start);
      message.expandedLines.push_back(text.substr(start,boundary == std::string::npos ? boundary : boundary-start));
      if (boundary == std::string::npos) break;
      start = boundary + 1;
      if (text[boundary] == '\f') {
        updatedBreaks.insert(static_cast<int>(message.expandedLines.size()));
        if (start < text.size() && text[start] == '\n') ++start;
        if (start == text.size()) break;
      }
    }
    int pageStart = 0;
    std::string pageText;
    for (int index = 0; index < static_cast<int>(message.expandedLines.size()); ++index) {
      if (updatedBreaks.contains(index)) { pageStart = index; pageText.clear(); }
      const auto& line = message.expandedLines[index];
      const auto candidate = pageText + (index > pageStart ? "\n" : "") + line;
      const bool trailingNewline = index + 1 == static_cast<int>(message.expandedLines.size()) && line.empty() && !updatedBreaks.contains(static_cast<int>(message.expandedLines.size()));
      if (index > pageStart && !trailingNewline && Window_Base::textHeight(candidate) > 144) {
        updatedBreaks.insert(index); pageStart = index; pageText = line;
      } else pageText = candidate;
    }
    message.pageBreaks = std::move(updatedBreaks);
    message.revealLengths.assign(message.expandedLines.size(),0); message.revealPrepared = true;
  }
  if (message.closing || message.openness < 255) return true;
  if (message.revealPage != message.firstLine) {
    message.revealPage = message.firstLine; message.revealLine = message.firstLine; message.revealOffset = 0;
    message.revealFinished = false; message.textPaused = false; message.finalPause = false;
    Window_Message::clearFlags(message); message.textWait = 0; message.revealedCount = 0;
  }
  if (message.textWait > 0) { --message.textWait; return true; }
  if (message.textPaused) {
    if (ok || cancel) { message.textPaused = false; if (message.finalPause) return false; }
    return true;
  }
  const auto finishPage = [&] {
    message.revealFinished = true;
    const bool lastPage = message.pageEnd() >= static_cast<int>(message.expandedLines.size());
    if (lastPage && Window_Message::startInput(*this)) return false;
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
      if (message.revealLine + 1 == static_cast<int>(message.expandedLines.size()) && message.expandedLines.back().empty() && !message.pageBreaks.contains(static_cast<int>(message.expandedLines.size()))) ++message.revealLine;
      if (!message.showFast) break;
      continue;
    }
    const auto at = message.revealOffset;
    const auto lead = static_cast<unsigned char>(text[at]);
    bool glyph = true;
    if (lead == 0x1b) {
      const auto code = Window_Base::obtainEscapeCode(text,message.revealOffset);
      glyph = false;
      if (code == "C" || code == "I") Window_Base::obtainEscapeParam(text,message.revealOffset);
      if (code == ".") message.textWait = 15;
      else if (code == "|") message.textWait = 60;
      else if (code == "!") { message.textPaused = true; message.textWait = 10; }
      else if (code == ">") message.lineFast = true;
      else if (code == "<") message.lineFast = false;
      else if (code == "^") message.pauseSkip = true;
      else if (code == "$") message.goldWindow = true;
      else if (code == "I") glyph = true;
    } else {
      const std::size_t bytes = (lead&0xe0)==0xc0 ? 2 : (lead&0xf0)==0xe0 ? 3 : (lead&0xf8)==0xf0 ? 4 : 1;
      message.revealOffset = std::min(text.size(),at+bytes);
    }
    message.revealLengths[message.revealLine] = message.revealOffset;
    if (glyph) ++message.revealedCount;
    messageAge_ = message.revealedCount+8;
    if (message.revealLine + 1 == message.pageEnd() && message.revealOffset >= text.size() && message.pageEnd() >= static_cast<int>(message.expandedLines.size())) { finishPage(); return true; }
    if (message.textWait > 0 || message.textPaused || (!message.showFast && !message.lineFast)) break;
  }
  if (message.revealLine >= message.pageEnd()) finishPage();
  return true;
}
}  // namespace pmjs::mv

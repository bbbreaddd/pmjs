#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <deque>
#include <vector>

namespace pmjs {

// Event timestamps use context time, independently of a source's playhead.
class GainAutomation {
 public:
  enum class Kind { set, linear };
  explicit GainAutomation(double initial = 1) : current_(initial), lastGain_(initial) {}
  bool setValue(double value, double now) {
    if (!std::isfinite(value) || !std::isfinite(now) || now < 0) return false;
    current_ = value;
    cached_ = false;
    return true;
  }
  double value() const { return current_; }
  std::size_t eventCount() const { return events_.size(); }
  double valueAt(double time) const {
    const auto next = std::upper_bound(events_.begin(), events_.end(), time,
      [](double timestamp, const Event& event) { return timestamp < event.time; });
    const double previousTime = next == events_.begin() ? 0 : std::prev(next)->time;
    const double previousValue = next == events_.begin() ? current_ : std::prev(next)->value;
    if (next != events_.end() && next != events_.begin() &&
        next->kind == Kind::linear && next->time > previousTime) {
      const double fraction = std::clamp((time - previousTime) / (next->time - previousTime), 0.0, 1.0);
      return previousValue + (next->value - previousValue) * fraction;
    }
    return previousValue;
  }
  bool schedule(Kind kind, double value, double time, double now) {
    if (!std::isfinite(value) || !std::isfinite(time) || time < 0 ||
        !std::isfinite(now) || now < 0) return false;
    time = std::max(time, now);
    if (kind == Kind::linear && events_.empty()) {
      events_.push_back({Kind::set, now, current_, true});
    }
    pending_ = true;
    auto position = std::lower_bound(events_.begin(), events_.end(), time,
      [](const Event& event, double timestamp) { return event.time < timestamp; });
    for (; position != events_.end() && position->time == time; ++position) {
      if (position->kind == kind) {
        position->value = value;
        position->pending = true;
        invalidate();
        return true;
      }
    }
    events_.insert(position, {kind, time, value, true});
    invalidate();
    return true;
  }
  bool cancel(double time) {
    if (!std::isfinite(time) || time < 0) return false;
    const auto first = std::lower_bound(events_.begin(), events_.end(), time,
      [](const Event& event, double timestamp) { return event.time < timestamp; });
    events_.erase(first, events_.end());
    invalidate();
    return true;
  }
  // Shared voices reuse each block so automation advances only once.
  const std::vector<double>& renderBlock(std::uint64_t firstFrame, int frames) {
    if (cached_ && firstFrame == blockFrame_ && frames == static_cast<int>(block_.size())) return block_;
    const double now = static_cast<double>(firstFrame) / 48000;
    bool reordered = false;
    if (pending_) for (auto& event : events_) if (event.pending) {
      if (event.time < now) { event.time = now; reordered = true; }
      event.pending = false;
    }
    pending_ = false;
    if (reordered) {
      std::stable_sort(events_.begin(), events_.end(),
        [](const Event& left, const Event& right) { return left.time < right.time; });
      cursor_ = 0;
    }
    block_.resize(frames);
    const float firstGain = processed_ ? lastGain_ : static_cast<float>(current_);
    if (frames > 0 && events_.empty() && std::abs(firstGain - current_) < 0.001F) {
      automated_ = false;
      dezipper_ = false;
      lastGain_ = static_cast<float>(current_);
      std::fill(block_.begin(), block_.end(), lastGain_);
      processed_ = true;
    } else for (int frame = 0; frame < frames; ++frame) {
      const auto outputFrame = firstFrame + frame;
      const double time = static_cast<double>(outputFrame) / 48000;
      if (frame == 0 || outputFrame % 128 == 0) {
        const auto nextBlockFrame = (outputFrame / 128 + 1) * 128;
        automated_ = !events_.empty() && (events_.front().kind == Kind::linear ||
          events_.front().time <= static_cast<double>(nextBlockFrame) / 48000);
        if (automated_) prune(time);
        if (!processed_) lastGain_ = static_cast<float>(current_);
        dezipper_ = std::abs(lastGain_ - current_) >= 0.001F;
      }
      if (automated_) {
        while (cursor_ < events_.size() && events_[cursor_].time <= time) ++cursor_;
        double nextValue = cursor_ ? events_[cursor_ - 1].value : current_;
        if (cursor_ && cursor_ < events_.size() && events_[cursor_].kind == Kind::linear) {
          const auto& previous = events_[cursor_ - 1];
          const auto& next = events_[cursor_];
          const double fraction = std::clamp((time - previous.time) / (next.time - previous.time), 0.0, 1.0);
          nextValue += (next.value - previous.value) * fraction;
        }
        current_ = static_cast<float>(nextValue);
        lastGain_ = static_cast<float>(current_);
      } else {
        if (dezipper_) lastGain_ += (static_cast<float>(current_) - lastGain_) * 0.005F;
        else lastGain_ = static_cast<float>(current_);
      }
      block_[frame] = lastGain_;
      processed_ = true;
    }
    blockFrame_ = firstFrame;
    cached_ = true;
    return block_;
  }
 private:
  void invalidate() { cached_ = false; cursor_ = 0; }
  void prune(double time) {
    if (events_.empty()) return;
    // Keep enough history to interpolate active ramps.
    if (events_.back().time + 192.0 / 48000 < time) {
      events_.clear();
      cursor_ = 0;
      return;
    }
    const auto next = std::lower_bound(events_.begin(), events_.end(), time,
      [](const Event& event, double timestamp) { return event.time < timestamp; });
    const auto past = static_cast<std::size_t>(next - events_.begin());
    const auto removed = past > 3 ? past - 3 : 0;
    for (std::size_t index = 0; index < removed; ++index) events_.pop_front();
    cursor_ = cursor_ > removed ? cursor_ - removed : 0;
  }
  struct Event { Kind kind; double time, value; bool pending; };
  double current_;
  float lastGain_;
  bool processed_ = false, automated_ = false, cached_ = false, dezipper_ = false, pending_ = false;
  std::size_t cursor_ = 0;
  std::uint64_t blockFrame_ = 0;
  std::deque<Event> events_;
  std::vector<double> block_;
};

} // namespace pmjs

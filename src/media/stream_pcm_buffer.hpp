#pragma once
#include <algorithm>
#include <cstddef>
#include <initializer_list>
#include <iterator>
#include <stdexcept>
#include <utility>
#include <vector>
namespace pmjs {
// Producer appends and callback consumes under the existing voice mutex.
// Only producer-side growth allocates; consuming samples does not free blocks.
class StreamPcmBuffer {
 public:
  StreamPcmBuffer() = default;
  StreamPcmBuffer(const StreamPcmBuffer&) = default;
  StreamPcmBuffer& operator=(const StreamPcmBuffer&) = default;
  StreamPcmBuffer(StreamPcmBuffer&& other) noexcept
      : storage_(std::move(other.storage_)), head_(other.head_), size_(other.size_) {
    other.head_ = other.size_ = 0;
  }
  StreamPcmBuffer& operator=(StreamPcmBuffer&& other) noexcept {
    if (this != &other) {
      storage_ = std::move(other.storage_);
      head_ = other.head_;
      size_ = other.size_;
      other.head_ = other.size_ = 0;
    }
    return *this;
  }
  StreamPcmBuffer& operator=(std::initializer_list<float> values) {
    assign(values.begin(), values.end());
    return *this;
  }
  void append(std::initializer_list<float> values) { append(values.begin(), values.end()); }
  std::size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }
  std::size_t capacity() const { return storage_.size(); }
  float operator[](std::size_t index) const {
    index += head_;
    if (index >= storage_.size()) index -= storage_.size();
    return storage_[index];
  }
  void pop_front() {
    if (++head_ == storage_.size()) head_ = 0;
    --size_;
  }
  void clear() {
    std::vector<float>().swap(storage_);
    head_ = size_ = 0;
  }
  void push_back(float value) { append(&value, &value + 1); }
  template <std::forward_iterator Iterator>
  void assign(Iterator first, Iterator last) {
    clear();
    append(first, last);
  }
  template <std::forward_iterator Iterator>
  void append(Iterator first, Iterator last) {
    const auto distance = std::distance(first, last);
    if (distance < 0) throw std::length_error("invalid stream PCM range");
    const auto count = static_cast<std::size_t>(distance);
    if (count > storage_.max_size() - size_) throw std::length_error("stream PCM buffer too large");
    if (size_ + count > storage_.size()) {
      std::vector<float> grown(
          std::max(size_ + count, (storage_.size() >= 48000 ? 96000 : storage_.size() * 2)));
      for (std::size_t i = 0; i < size_; ++i) grown[i] = (*this)[i];
      storage_.swap(grown);
      head_ = 0;
    }
    if (!count) return;
    std::size_t tail = head_ + size_;
    if (tail >= storage_.size()) tail -= storage_.size();
    const auto leading = std::min(count, storage_.size() - tail);
    std::copy_n(first, leading, storage_.begin() + tail);
    std::advance(first, leading);
    std::copy(first, last, storage_.begin());
    size_ += count;
  }

 private:
  std::vector<float> storage_;
  std::size_t head_ = 0, size_ = 0;
};
}  // namespace pmjs

#include "media/stream_pcm_buffer.hpp"

#include <deque>
#include <iostream>
#include <new>
#include <random>

namespace {
bool failAllocation = false;
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
void compare(const pmjs::StreamPcmBuffer& actual, const std::deque<float>& expected) {
  require(actual.size() == expected.size(), "PCM queue length differs");
  for (std::size_t i = 0; i < expected.size(); ++i)
    require(actual[i] == expected[i], "PCM queue order differs");
}
}

extern "C" void* __real__Znwm(std::size_t);
extern "C" void* __wrap__Znwm(std::size_t size) {
  if (failAllocation) throw std::bad_alloc();
  return __real__Znwm(size);
}

int main() try {
  pmjs::StreamPcmBuffer queue;
  const float initial[]{1, 2, 3, 4};
  queue.append(initial, initial + 4);
  queue.pop_front(); queue.pop_front();
  queue.append(initial, initial + 2);
  const auto before = queue;
  failAllocation = true;
  bool failed = false;
  try { queue.append(initial, initial + 4); }
  catch (const std::bad_alloc&) { failed = true; }
  failAllocation = false;
  require(failed && queue.capacity() == before.capacity(), "failed growth changed capacity");
  compare(queue, {3, 4, 1, 2});
  failed = false;
  try { queue.append(initial + 1, initial); }
  catch (const std::length_error&) { failed = true; }
  require(failed, "reversed input range was accepted");
  compare(queue, {3, 4, 1, 2});
  queue.clear();
  require(queue.empty() && queue.capacity() == 0, "clear retained PCM storage");

  std::deque<float> reference;
  std::mt19937 random(78237);
  for (int operation = 0; operation < 20000; ++operation) {
    switch (random() % 7) {
      case 0: case 1: case 2: {
        std::vector<float> values(random() % 500);
        for (auto& value : values) value = static_cast<float>(random() % 1048576) / 1048576;
        queue.append(values.begin(), values.end());
        reference.insert(reference.end(), values.begin(), values.end());
        break;
      }
      case 3: {
        std::size_t count = std::min<std::size_t>(random() % 500, reference.size());
        while (count--) { queue.pop_front(); reference.pop_front(); }
        break;
      }
      case 4:
        if (random() % 32 == 0) {
          queue.clear(); reference.clear();
          require(queue.capacity() == 0, "clear retained capacity after wrapping");
        }
        break;
      case 5: {
        auto copy = queue;
        auto moved = std::move(copy);
        require(copy.empty(), "move retained logical samples");
        copy.push_back(0.5F);
        require(copy.size() == 1 && copy[0] == 0.5F, "moved-from queue is not reusable");
        queue = std::move(moved);
        require(moved.empty(), "move assignment retained logical samples");
        copy = queue;
        compare(copy, reference);
        break;
      }
      case 6:
        if (random() % 32 == 0) { queue = {1, 2, 3}; reference = {1, 2, 3}; }
        break;
    }
    compare(queue, reference);
  }
  queue.clear();
  std::vector<float> full(96000, 0.25F);
  queue.append(full.begin(), full.end());
  const auto capacity = queue.capacity();
  failAllocation = true;
  for (int block = 0; block < 100; ++block) {
    for (int sample = 0; sample < 2048; ++sample) queue.pop_front();
    queue.append(full.begin(), full.begin() + 2048);
  }
  failAllocation = false;
  require(queue.capacity() == capacity && capacity == 96000, "steady refill grew the full queue");
  std::cout << "PCM queue ordering, ownership, allocation failure and steady reuse passed\n";
} catch (const std::exception& error) {
  failAllocation = false;
  std::cerr << error.what() << '\n';
  return 1;
}

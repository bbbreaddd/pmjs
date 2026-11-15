#pragma once

#include <cassert>
#include <cstddef>
#include <memory>
#include <unordered_map>
#include <utility>

namespace pmjs {

class MemoryCharge;

class MemoryLedger {
 public:
  std::size_t bytes() const { return bytes_; }

 private:
  friend class MemoryCharge;
  struct Entry { std::size_t bytes, references; };
  std::unordered_map<const void*, Entry> entries_;
  std::size_t bytes_ = 0;

  void retain(const void* key, std::size_t bytes) {
    const auto [entry, inserted] = entries_.try_emplace(key, Entry{bytes, 0});
    assert(entry->second.bytes == bytes);
    ++entry->second.references;
    if (inserted) bytes_ += bytes;
  }
  void resize(const void* key, std::size_t bytes) noexcept {
    const auto entry = entries_.find(key);
    assert(entry != entries_.end());
    bytes_ = bytes_ - entry->second.bytes + bytes;
    entry->second.bytes = bytes;
  }
  void release(const void* key) noexcept {
    const auto entry = entries_.find(key);
    assert(entry != entries_.end());
    if (--entry->second.references == 0) {
      bytes_ -= entry->second.bytes;
      entries_.erase(entry);
    }
  }
};

// Charges share the ledger's lifetime, but never keep resource storage alive.
class MemoryCharge {
 public:
  MemoryCharge() = default;
  MemoryCharge(const MemoryCharge&) = delete;
  MemoryCharge& operator=(const MemoryCharge&) = delete;
  MemoryCharge(MemoryCharge&& other) noexcept
      : ledger_(std::move(other.ledger_)), key_(std::exchange(other.key_, nullptr)),
        ownedBytes_(std::exchange(other.ownedBytes_, 0)) {}
  MemoryCharge& operator=(MemoryCharge&& other) noexcept {
    if (this != &other) {
      reset();
      ledger_ = std::move(other.ledger_);
      key_ = std::exchange(other.key_, nullptr);
      ownedBytes_ = std::exchange(other.ownedBytes_, 0);
    }
    return *this;
  }
  ~MemoryCharge() { reset(); }

  void set(std::shared_ptr<MemoryLedger> ledger, const void* key, std::size_t bytes) {
    if (!ledger || !key) { reset(); return; }
    if (ledger == ledger_ && key == key_) {
      ledger->resize(key, bytes);
      return;
    }
    ledger->retain(key, bytes);
    reset();
    ledger_ = std::move(ledger);
    key_ = key;
  }
  void reset() noexcept {
    if (key_) ledger_->release(std::exchange(key_, nullptr));
    if (ledger_) ledger_->bytes_ -= std::exchange(ownedBytes_, 0);
    ledger_.reset();
  }
  void setOwned(std::shared_ptr<MemoryLedger> ledger, std::size_t bytes) noexcept {
    reset();
    ledger_ = std::move(ledger);
    if (ledger_) { ledger_->bytes_ += bytes; ownedBytes_ = bytes; }
  }
  void resize(std::size_t bytes) noexcept {
    assert(ledger_);
    if (key_) ledger_->resize(key_, bytes);
    else {
      ledger_->bytes_ = ledger_->bytes_ - ownedBytes_ + bytes;
      ownedBytes_ = bytes;
    }
  }

 private:
  std::shared_ptr<MemoryLedger> ledger_;
  const void* key_ = nullptr;
  std::size_t ownedBytes_ = 0;
};

}  // namespace pmjs

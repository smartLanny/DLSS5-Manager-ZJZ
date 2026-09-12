#pragma once
#include <windows.h>

namespace mfgunlock {

// Callbacks may run under the loader lock or reenter discovery. A competing
// caller leaves the current owner to finish and can retry through a later event.
class TryPatchGuard final {
 public:
  explicit TryPatchGuard(SRWLOCK& lock) noexcept
      : lock_(&lock), acquired_(TryAcquireSRWLockExclusive(lock_) != 0) {}
  ~TryPatchGuard() noexcept {
    if (acquired_) ReleaseSRWLockExclusive(lock_);
  }
  TryPatchGuard(const TryPatchGuard&) = delete;
  TryPatchGuard& operator=(const TryPatchGuard&) = delete;
  explicit operator bool() const noexcept { return acquired_; }

 private:
  SRWLOCK* const lock_;
  const bool acquired_;
};

}  // namespace mfgunlock

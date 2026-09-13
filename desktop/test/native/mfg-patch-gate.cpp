#include "../../native/mfgunlock/patch_gate.hpp"
#include <atomic>
#include <barrier>
#include <cstdio>
#include <thread>
#include <vector>

int main() {
  SRWLOCK lock = SRWLOCK_INIT;
  std::atomic_bool blocked_caller_returned{false};
  {
    const mfgunlock::TryPatchGuard owner(lock);
    if (!owner) return 1;
    const mfgunlock::TryPatchGuard reentry(lock);
    if (reentry) return 2;
    std::thread contender([&] {
      const mfgunlock::TryPatchGuard guard(lock);
      if (!guard) blocked_caller_returned.store(true, std::memory_order_release);
    });
    // Joining while the owner still holds the gate proves contention returns
    // without waiting for a callback that may own the Windows loader lock.
    contender.join();
    if (!blocked_caller_returned.load(std::memory_order_acquire)) return 3;
  }
  try {
    const mfgunlock::TryPatchGuard guard(lock);
    if (!guard) return 4;
    throw 1;
  } catch (int) {}
  {
    const mfgunlock::TryPatchGuard guard(lock);
    if (!guard) return 5;
  }

  constexpr int workers = 16, rounds = 100, sites_per_round = 2000;
  std::barrier start(workers), done(workers);
  std::atomic_bool patched{false};
  std::atomic_int writer_count{0}, failures{0};
  std::vector<int> sites;
  std::vector<std::thread> threads;
  for (int worker = 0; worker < workers; ++worker) threads.emplace_back([&, worker] {
    for (int round = 0; round < rounds; ++round) {
      if (worker == 0) { sites.clear(); patched.store(false); writer_count.store(0); }
      start.arrive_and_wait();
      {
        const mfgunlock::TryPatchGuard guard(lock);
        if (guard && !patched.load(std::memory_order_acquire)) {
          ++writer_count;
          for (int i = 0; i < sites_per_round; ++i) sites.push_back(i);
          patched.store(true, std::memory_order_release);
        }
      }
      done.arrive_and_wait();
      if (worker == 0 && (writer_count.load() != 1 || sites.size() != sites_per_round)) ++failures;
      start.arrive_and_wait();
    }
  });
  for (auto& thread : threads) thread.join();
  if (failures.load() != 0) return 6;
  std::printf("{\"passed\":true,\"threads\":%d,\"rounds\":%d,\"sitesPerRound\":%d,\"singleWriter\":true,\"nonblockingContention\":true,\"reentryRejected\":true,\"exceptionReleased\":true}\n",
              workers, rounds, sites_per_round);
  return 0;
}

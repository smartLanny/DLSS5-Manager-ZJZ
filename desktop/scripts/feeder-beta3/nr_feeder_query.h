#pragma once
#include <cstdint>
// Read-only provider transport counters, independent from the Core UI.
struct NrFeederDx9Status {
    std::uint32_t size,enabled;
    std::uint64_t presents,submitted,copied,nr_completed,disabled_presents,scene_depth_frames;
};
static_assert(sizeof(NrFeederDx9Status)==56);

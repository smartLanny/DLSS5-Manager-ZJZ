'use strict';

// This is an evidence catalogue, not a filename allowlist. A row is used only
// after a verified Steam identity AND a linked, trusted native integration have
// independently been established. Unknown titles retain their native baseline.
const OFFICIAL_GAMES = Object.freeze([
  Object.freeze({ id: 'cyberpunk-2077', steamAppId: '1091500', exe: 'Cyberpunk2077.exe', api: 'dx12',
    fg: Object.freeze({ multipliers: Object.freeze([2, 3, 4, 5, 6]), dynamic: true }),
    source: 'https://www.nvidia.com/en-us/geforce/news/nvidia-rtx-games-engines-apps/',
    checkedAt: '2026-09-10', evidence: 'NVIDIA DLSS Multi Frame Generation entry: NV, 6X' }),
  Object.freeze({ id: '007-first-light', steamAppId: '3768760', exe: '007FirstLight.exe', api: 'dx12',
    fg: Object.freeze({ multipliers: Object.freeze([2, 3, 4, 5, 6]), dynamic: true }),
    source: 'https://www.nvidia.com/en-au/geforce/news/007-first-light-dlss-4-5-dynamic-multi-frame-gen-6x-super-res/',
    checkedAt: '2026-09-10', evidence: 'NVIDIA confirms native DLSS 4.5 Dynamic Multi Frame Generation and 6X Mode, including RTX 50 Laptop GPUs.' })
]);

// A mod must have an explicit reviewed integration contract before it can
// supply native-override support. In particular, discovering a Luma addon next
// to NVIDIA DLLs is not such a contract. Entries are code-pinned, never loaded
// from the game's config or supplied over renderer IPC.
const TRUSTED_MODS = Object.freeze([]);
module.exports = { OFFICIAL_GAMES, TRUSTED_MODS };

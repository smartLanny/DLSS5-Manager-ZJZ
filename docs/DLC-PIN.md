# DLC pin table (draft)

| Component | Default pin | Rollback | Update source | Notes |
| --- | --- | --- | --- | --- |
| MFG Unlock (40) | **0.9** | 0.7-zh-CN | mavismmg/MFGAdaUnlock-RenoDx releases | Prefer 0.9 per owner 2026-09-12 |
| Bridge | game-recipe | 1.4.11 (BG3) | pin manifest | Never force latest; #224 |
| Feeder | optional | — | changelog gate | Main OTA may omit |
| nvngx_dlssnr | 310.8.SF-v2 | — | rhi-repo / NVIDIA | No bump without evidence |
| DLSS/SL stack | evaluate 310.9.1+SL2.14.1 | current field | separate A/B | Not tied to #190 |

Manager should periodically check these sources (RHI-like) — see mgr#13/#26/#6.

# DLSS5 Compatibility List (evidence-based)

Inspired by [OptiScaler Compatibility List](https://github.com/optiscaler/OptiScaler/wiki/Compatibility-List).

This is **not** a marketing "all games work" list. Rows require F8 / verified materials.
Oral group chat claims do **not** land as OK.

## Status legend

| Status | Meaning |
| --- | --- |
| **OK** | Verified pass on stated build + GPU/driver |
| **Partial** | Runs with known bypass / flicker / format / HDR limits |
| **No** | Confirmed ineffective or full safe-bypass on that build |
| **Untested** | Missing fresh F8 for that build |

## Verified OK (owner pass matrix)

| Game | API | Build | GPU/driver | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| The Blood of Dawnwalker | DX12 | beta0.4.6-hotfix.1 | 5090M / 61062 | OK | Visible NR delta |
| Crimson Desert | DX12 | beta0.4.6-hotfix.1 | 5090M / 61062 | OK | |
| Crimson Desert | DX12 | 0.5-dev14 | 5090M / 61062 | OK | RR → auto RR-NR |
| Ananta / HTGame | DX12 | 0.5-dev14 | 5090M / 61062 | OK | RR→RR-NR; face dark: lighting protect ~0.2 |
| Cyberpunk 2077 | DX12 | 0.5-dev14 | 5090M / 61062 | OK* | *RR-NR path; RR forced RR-NR may still flicker |
| Baldur'''s Gate 3 | DX11 | 0.4.6 / 0.4.7 | 5090M / 61062 | OK | Bridge version matters |
| Red Dead Redemption 2 | DX12 | beta0.4.7 | 5090M / 61062 | OK | |

## Known evidence (not OK-checked)

| Game | Build | Status | Notes |
| --- | --- | --- | --- |
| Yan Yun | 0.5-dline13 | Partial | Occasional flicker; SR→NR color contract |
| Watch Dogs Legion | 0.5 D14 | Partial | Intermittent format + FPS drop track |
| Zenless Zone Zero | 0.4.7beta | No | Output format; D13 theoretical fix needs F8 |
| Helldivers 2 | 0.4.2 | No (old) | No post-0.4.6 F8 yet — do not mark fixed |
| Wuthering Waves | 0.4.7beta | Partial | RR on → rr-safe-bypass (depth projection) |
| NBA 2K27 | 0.4.7beta | Untested* | *Need F8 with enable left on |
| Starfield / DS1 / DS2 | 0.4.x | Partial | command-state / exposure contracts |

## How to get a row

Game + plugin build + one-line symptom + **F8 TXT**. Screenshots optional.

Tracking: lab issue **#255**. Pass-only machine rows stay in the private pass matrix.

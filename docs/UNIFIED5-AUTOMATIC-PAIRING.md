# Explicit Unified5 selection

Beta6 keeps `0.4.7beta` as the new-install default. Choosing the exact shipped
`0.5-dline21-unified5` is the opt-in to experimental compatibility pairing;
there is no second experimental-consent gate. File/architecture/API checks and
the ordinary operation preview still apply. Existing receipts remain pinned.

The Core is sourced from `38f5fff6fb6b20ce5fb09b0cca5020fcc4d9171d`.
Its pinned external consumer implements `NRExternalProviderV1`, source-frame
claims, exact-fence completion, present color/depth/motion input and the unified
multi-pass pipeline. This interface evidence permits composition; it is not an
in-game success assertion. Capabilities are granted only to the exact pinned
Core digest during that game's explicit operation.

Routes currently packaged:

| Input | Selection after choosing Unified5 |
| --- | --- |
| DX12 native | No extra Bridge or Feeder |
| DX11 native input | Official Bridge 1.4.13-pre8, exact shipped identity |
| DX11 without native input | External-V1 Feeder 0.15.1 legacy adapter |
| Vulkan | External-V1 Vulkan Feeder profile |

Upstream Bridge supports Vulkan, but this package's automatic Vulkan owner is
the deployable Feeder profile. Do not report that as an installed Vulkan Bridge.
HoYoShade and other backends still require a matching declared provider route;
selecting a Core does not invent a missing backend adapter.

Per-operation Core/provider context is shared by preview, source validation and
apply. It is not written to global preferences or provider defaults. Installed
Feeder recipes and Vulkan bindings preserve their Core for subsequent reads.
The `experimental-core-routing` module owns candidate eligibility and ordering.

Acceptance separates renderer interaction, isolated real-file deployment,
ordinary application startup and actual in-game rendering. The last remains
owner testing. Historical `0.3.3.7` remains unavailable rather than relabelled.

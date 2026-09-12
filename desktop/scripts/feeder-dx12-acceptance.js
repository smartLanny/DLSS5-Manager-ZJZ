'use strict';

// Bounded evidence for the unchanged binary pairing. This is not game/quality acceptance.
module.exports = Object.freeze({
  status: 'controlled-callback-candidate',
  compileLinkVerified: true,
  controlledDx12Verified: true,
  controlledResizeVerified: true,
  realGameVerified: false,
  scope: 'RTX 5090 Laptop; x64 DX12 real ReShade callback; RGBA8 UNORM confirmed sRGB; initial 640x360 and one resize to 768x432; Synthetic post-process guides',
  evidenceSummarySha256: '3dbdb51972e0ade859982bb649aebac8f988955de6b6c8f15305411971e9539d',
  evidenceIdentitySha256: '808c4c7936c5c73e4d29a5c96ae94c1b1dbff1e712423e3c09bf7017cb5649ec',
  hostSha256: '8ad0d8e9528396a2aa8998e03bec8c91b3cf5402c5741eb819a5b6dab8490f49',
  providerSha256: '05f6c6d720378c05ff49332498cf065682806e4742cef473f150e0b844c12aa7',
  note: 'NR completed and recorded same-frame writeback through the project Core. No HDR/BGRA, DX11, x86, native SR/FG injection or real-game image-quality acceptance.'
});

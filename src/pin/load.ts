import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Failures } from "../failures.js";
import { findRepoRoot } from "../repo-root.js";
import type { PinComponent, PinManifest } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw Failures.manifestInvalid(`${field} 必须是非空字符串`);
  }
  return value;
}

export function parsePinManifest(raw: unknown): PinManifest {
  if (!isRecord(raw)) throw Failures.manifestInvalid("根节点必须是对象");
  if (raw.schemaVersion !== 1) throw Failures.manifestInvalid("schemaVersion 必须为 1");
  if (!isRecord(raw.checkCadence)) throw Failures.manifestInvalid("缺少 checkCadence");
  if (!Array.isArray(raw.components) || raw.components.length === 0) {
    throw Failures.manifestInvalid("components 不能为空");
  }

  const cadence = raw.checkCadence;
  const manifest: PinManifest = {
    schemaVersion: 1,
    updatedAt: requireString(raw.updatedAt, "updatedAt"),
    checkCadence: {
      onLaunch: cadence.onLaunch === true,
      manualCommand: requireString(cadence.manualCommand, "checkCadence.manualCommand"),
      periodicHours: typeof cadence.periodicHours === "number" ? cadence.periodicHours : 24,
      autoInstall: false,
      metadataOnlyByDefault: cadence.metadataOnlyByDefault !== false,
      notes: requireString(cadence.notes, "checkCadence.notes"),
    },
    components: raw.components.map((item, index) => parseComponent(item, index)),
  };

  assertOwnerPins(manifest);
  return manifest;
}

function parseComponent(item: unknown, index: number): PinComponent {
  if (!isRecord(item)) throw Failures.manifestInvalid(`components[${index}] 必须是对象`);
  if (!isRecord(item.updateSource)) {
    throw Failures.manifestInvalid(`components[${index}].updateSource 必须是对象`);
  }
  const source = item.updateSource;
  return {
    id: requireString(item.id, `components[${index}].id`),
    displayName: requireString(item.displayName, `components[${index}].displayName`),
    slot: requireString(item.slot, `components[${index}].slot`),
    defaultPin: requireString(item.defaultPin, `components[${index}].defaultPin`),
    priority: item.priority === "rollback-only" ? "rollback-only" : "default",
    rollbacks: Array.isArray(item.rollbacks) ? item.rollbacks.map(String) : [],
    gamePins: isRecord(item.gamePins)
      ? Object.fromEntries(Object.entries(item.gamePins).map(([k, v]) => [k, String(v)]))
      : undefined,
    neverForce: Array.isArray(item.neverForce) ? item.neverForce.map(String) : undefined,
    neverAutoBump: item.neverAutoBump !== false,
    evaluate: typeof item.evaluate === "string" ? item.evaluate : undefined,
    updateSource: {
      kind: requireString(source.kind, "updateSource.kind") as PinComponent["updateSource"]["kind"],
      owner: typeof source.owner === "string" ? source.owner : undefined,
      repo: typeof source.repo === "string" ? source.repo : undefined,
      pageUrl: typeof source.pageUrl === "string" ? source.pageUrl : null,
      metadataUrl: typeof source.metadataUrl === "string" ? source.metadataUrl : null,
    },
    policy: requireString(item.policy, `components[${index}].policy`),
    labRef: typeof item.labRef === "string" ? item.labRef : undefined,
    notes: requireString(item.notes, `components[${index}].notes`),
  };
}

export function assertOwnerPins(manifest: PinManifest): void {
  const mfg = manifest.components.find((c) => c.id === "mfg-unlock");
  if (!mfg || mfg.defaultPin !== "0.9") {
    throw Failures.manifestInvalid("MFG Unlock 默认/优先 pin 必须是 0.9");
  }
  const oldMfgRollback = (mfg.rollbacks ?? []).some(
    (value) => value === "0.7" || value.startsWith("0.7") || value === "0.6.1" || value.startsWith("0.6.1"),
  );
  if (oldMfgRollback) {
    throw Failures.manifestInvalid("MFG Unlock 0.7/0.6.1 不得作为安装或回退选项");
  }

  const bridge = manifest.components.find((c) => c.id === "bridge");
  if (!bridge) throw Failures.manifestInvalid("缺少 Bridge 组件");
  if (bridge.gamePins?.bg3 !== "1.4.11") {
    throw Failures.manifestInvalid("Bridge / BG3 必须 pin 在 1.4.11");
  }
  const blocked = new Set(bridge.neverForce ?? []);
  if (!blocked.has("latest") || !blocked.has("1.4.13-pre")) {
    throw Failures.manifestInvalid("Bridge.neverForce 必须包含 latest 与 1.4.13-pre");
  }
}

export function loadPinManifest(root = findRepoRoot()): PinManifest {
  const text = readFileSync(join(root, "config", "pins.json"), "utf8");
  return parsePinManifest(JSON.parse(text) as unknown);
}

export function getComponent(manifest: PinManifest, id: string): PinComponent {
  const found = manifest.components.find((c) => c.id === id);
  if (!found) throw Failures.pinNotFound(id);
  return found;
}

export function resolvePin(component: PinComponent, gameId?: string): string {
  if (gameId && component.gamePins?.[gameId]) return component.gamePins[gameId];
  return component.defaultPin;
}

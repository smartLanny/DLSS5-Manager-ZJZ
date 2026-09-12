import { Failures } from "../failures.js";
import { resolvePin } from "../pin/load.js";
import type { PinComponent, PinManifest, ReleaseHint, UpdateReport } from "../types.js";

export interface CheckOptions {
  live?: boolean;
  gameId?: string;
  fetchImpl?: typeof fetch;
}

interface GithubRelease {
  tag_name?: string;
  name?: string;
  published_at?: string;
}

function normalizeTag(tag: string): string {
  return tag.replace(/^v/i, "").trim();
}

function isBlockedBridge(component: PinComponent, tag: string): boolean {
  const blocked = new Set((component.neverForce ?? []).map(normalizeTag));
  const normalized = normalizeTag(tag);
  return blocked.has(normalized) || blocked.has(tag) || normalized === "latest";
}

export function decideUpdate(component: PinComponent, pin: string, sourceLatest: string | null): UpdateReport {
  if (component.id === "bridge" && sourceLatest && isBlockedBridge(component, sourceLatest)) {
    return {
      componentId: component.id,
      pin,
      sourceKind: component.updateSource.kind,
      sourceLatest,
      action: "blocked-latest",
      message: `源站出现 ${sourceLatest}，按 lab #224 丢弃。继续使用 pin ${pin}。`,
    };
  }

  if (component.policy === "optional-changelog-gate") {
    return {
      componentId: component.id,
      pin,
      sourceKind: component.updateSource.kind,
      sourceLatest,
      action: "skip-optional",
      message: "Feeder 未过 changelog 门，主 OTA 省略。",
    };
  }

  if (!sourceLatest) {
    return {
      componentId: component.id,
      pin,
      sourceKind: component.updateSource.kind,
      sourceLatest: null,
      action: "metadata-unavailable",
      message: `保持 pin ${pin}（无可用源站版本，或本次只打印计划）。`,
    };
  }

  return {
    componentId: component.id,
    pin,
    sourceKind: component.updateSource.kind,
    sourceLatest,
    action: "keep-pin",
    message:
      normalizeTag(sourceLatest) === normalizeTag(pin)
        ? `源站 tag ${sourceLatest} 与 pin 一致。`
        : `源站最新 ${sourceLatest}，本壳仍钉 ${pin}，不自动 bump。`,
  };
}

async function listGithubReleases(
  url: string,
  fetchImpl: typeof fetch,
): Promise<ReleaseHint[]> {
  const res = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "dlss5-manager-zjz" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw Failures.downloadBlocked(`GitHub Releases HTTP ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  return data.slice(0, 8).map((item) => {
    const rel = item as GithubRelease;
    return {
      tag: String(rel.tag_name ?? ""),
      name: String(rel.name ?? rel.tag_name ?? ""),
      publishedAt: rel.published_at ?? null,
    };
  }).filter((item) => item.tag);
}

export async function checkUpdates(manifest: PinManifest, options: CheckOptions = {}): Promise<UpdateReport[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const reports: UpdateReport[] = [];

  for (const component of manifest.components) {
    const pin = resolvePin(component, options.gameId);
    if (component.id === "bridge" && options.gameId === "bg3" && pin !== "1.4.11") {
      throw Failures.bridgeLatestForbidden(pin);
    }

    let sourceLatest: string | null = null;
    let releases: ReleaseHint[] | undefined;

    if (options.live && component.updateSource.kind === "github-releases" && component.updateSource.metadataUrl) {
      releases = await listGithubReleases(component.updateSource.metadataUrl, fetchImpl);
      sourceLatest = releases[0]?.tag ?? null;
    } else if (options.live && component.updateSource.kind === "pin-manifest") {
      sourceLatest = pin;
    }

    const report = decideUpdate(component, pin, sourceLatest);
    if (releases) report.releases = releases;
    reports.push(report);
  }

  return reports;
}

export function refuseBinaryDownload(kind = "NVIDIA/NR 二进制"): never {
  throw Failures.binaryForbidden(kind);
}

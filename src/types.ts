export type UpdateSourceKind =
  | "github-releases"
  | "pin-manifest"
  | "changelog-gate"
  | "rhi-or-nvidia";

export interface UpdateSource {
  kind: UpdateSourceKind;
  owner?: string;
  repo?: string;
  pageUrl: string | null;
  metadataUrl: string | null;
}

export interface PinComponent {
  id: string;
  displayName: string;
  slot: string;
  defaultPin: string;
  priority?: "default" | "rollback-only";
  rollbacks?: string[];
  gamePins?: Record<string, string>;
  neverForce?: string[];
  neverAutoBump: boolean;
  evaluate?: string;
  updateSource: UpdateSource;
  policy: string;
  labRef?: string;
  notes: string;
}

export interface CheckCadence {
  onLaunch: boolean;
  manualCommand: string;
  periodicHours: number;
  autoInstall: false;
  metadataOnlyByDefault: boolean;
  notes: string;
}

export interface PinManifest {
  schemaVersion: 1;
  updatedAt: string;
  checkCadence: CheckCadence;
  components: PinComponent[];
}

export interface FetchPlan {
  componentId: string;
  displayName: string;
  pin: string;
  method: "GET";
  metadataUrl: string | null;
  pageUrl: string | null;
  downloadsBinaries: false;
  autoApply: false;
  cadenceHours: number;
  how: string;
}

export interface ReleaseHint {
  tag: string;
  name: string;
  publishedAt: string | null;
}

export interface UpdateReport {
  componentId: string;
  pin: string;
  sourceKind: UpdateSourceKind;
  sourceLatest: string | null;
  action: "keep-pin" | "skip-optional" | "blocked-latest" | "metadata-unavailable";
  message: string;
  releases?: ReleaseHint[];
}

export interface GameCandidate {
  id: string;
  title: string;
  store: "steam" | "epic" | "manual";
  installPath: string | null;
  recipeId: string | null;
}

export interface Recipe {
  id: string;
  title: string;
  gameId?: string;
  pins: Record<string, string>;
  optionalSlots: string[];
  notes: string;
}

export interface FailureShape {
  code: string;
  message: string;
  hint: string;
}

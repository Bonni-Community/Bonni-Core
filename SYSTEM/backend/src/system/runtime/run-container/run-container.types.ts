export type RunContainerSlot = "active" | "candidate" | "emergency";

export type RuntimeIdentityBase = {
  createdAt: string;
  systemVersion: string;
  schemaVersion: string;
  userCount: number;
};

export type RuntimeIdentity = RuntimeIdentityBase & {
  /**
   * Internal technical integrity key. Do not expose this value in the System UI.
   */
  stateKey: string;
};

export type PublicRuntimeIdentity = RuntimeIdentityBase;

export type RunContainerStatus = {
  ok: boolean;
  slot: RunContainerSlot;
  root: string;
  identity?: PublicRuntimeIdentity;
  databaseIdentity?: PublicRuntimeIdentity | null;
  matchesDatabase: boolean | null;
  message: string;
};

export type BuildRunContainerCandidateOptions = {
  reason?: string;
  requestedBy?: string;
};

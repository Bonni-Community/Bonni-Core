import { env } from "../config/env.js";
import { isLocalToServerSyncAllowed } from "./database-context.js";

export type DataOperationMode = typeof env.DATABASE_OPERATION_MODE;
export type DataSyncDirection = "local-to-server";
export type StorageRecoveryTarget = "local" | "local-then-server" | "server-direct";
// Rückwärtskompatibler Name für ältere Importe aus dem Datenbank-Fassadenmodul.
export type TimecapsuleRecoveryTarget = StorageRecoveryTarget;

export function assertManualLocalToServerSyncAllowed() {
  if (!isLocalToServerSyncAllowed()) {
    throw new Error(
      "Manual Local → Server synchronization is not allowed in the current database operation mode.",
    );
  }
}

export function assertServerToLocalSyncBlocked(): never {
  throw new Error("Server → Local synchronization is intentionally blocked by architecture rule.");
}

export function getDatabaseSyncPolicy() {
  return {
    operationMode: env.DATABASE_OPERATION_MODE,
    syncMode: env.DATABASE_SYNC_MODE,
    direction: "local-to-server" as DataSyncDirection,
    automaticSyncAllowed: false,
    serverToLocalAllowed: false,
    storageRecoveryTargets: [
      "local",
      "local-then-server",
      "server-direct",
    ] as StorageRecoveryTarget[],
    recommendedStorageRecoveryTarget: "local" as StorageRecoveryTarget,
  };
}

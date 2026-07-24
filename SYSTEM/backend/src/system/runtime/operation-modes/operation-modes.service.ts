import { getDatabaseOperationStatus, getDatabaseSyncPolicy } from "../../../core/database/database.js";

export async function getOperationModesStatus() {
  return {
    ok: true,
    area: "operation-modes",
    database: getDatabaseOperationStatus(),
    syncPolicy: getDatabaseSyncPolicy(),
    timecapsule: {
      installed: false,
      recoveryTargets: [],
      recommendedRecoveryTarget: null,
      pendingRecords: 0,
      storageRoot: null,
      sync: { enabled: false, reason: "TIMECAPSULE_ADDON_NOT_INSTALLED" },
    },
  };
}

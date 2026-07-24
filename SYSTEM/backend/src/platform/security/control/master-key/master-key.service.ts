import {
  acknowledgeContinueWithoutBootStick,
  getPersonalDataMasterKeyStatus,
  initializePersonalDataMasterKeyStorage,
  listPersonalDataMasterKeyStorageLocations,
  loadPersonalDataMasterKeyFromFile,
  setPersonalDataDeveloperBootWithoutMasterKey,
} from "../../crypto/index.js";
import type {
  BootWithoutKeyDecisionBody,
  DeveloperBootModeBody,
  InitializeMasterKeyStorageBody,
  LoadMasterKeyFromFileBody,
} from "./master-key.schemas.js";

export function getMasterKeyControlStatus() {
  const status = getPersonalDataMasterKeyStatus();

  return {
    ok: true,
    area: "security/master-key",
    status,
    bootHint: status.loaded
      ? "PERSONAL_DATA_MASTER_KEY_LOADED"
      : status.bootStickRequired
        ? "BOOT_STICK_REQUIRED_LOGIN_LOCKED"
        : "MASTER_KEY_NOT_REQUIRED_OR_NOT_CONFIGURED",
    actions: {
      canContinueLocked: status.bootStickRequired && !status.loaded,
      canEnableDeveloperBoot: status.developerBootAllowed && !status.loaded,
      canDisableDeveloperBoot: status.developerBootEnabled,
      developerBootKeepsMemberLoginLocked: true,
      canLoadFromFile: true,
      canInitializeStorage: true,
      formatsBlockDevices: false,
    },
  };
}

export function listMasterKeyStorageLocations() {
  return {
    ok: true,
    area: "security/master-key/storage-locations",
    note: "System zeigt auswählbare, gemountete Speicherorte an. Es formatiert keine Blockgeräte blind.",
    locations: listPersonalDataMasterKeyStorageLocations(),
  };
}

export function decideBootWithoutKey(input: BootWithoutKeyDecisionBody) {
  if (input.continueWithoutBootStick && input.confirmationPhrase !== "OHNE BOOT STICK FORTFAHREN") {
    throw Object.assign(new Error("CONFIRMATION_PHRASE_REQUIRED"), {
      statusCode: 400,
      details: { expected: "OHNE BOOT STICK FORTFAHREN" },
    });
  }

  return {
    ok: true,
    area: "security/master-key/boot-decision",
    continuedWithoutBootStick: input.continueWithoutBootStick,
    status: acknowledgeContinueWithoutBootStick(input.continueWithoutBootStick),
  };
}

export function setDeveloperBootMode(input: DeveloperBootModeBody) {
  if (input.enabled && input.confirmationPhrase !== "ENTWICKLER MODUS AKTIVIEREN") {
    throw Object.assign(new Error("CONFIRMATION_PHRASE_REQUIRED"), {
      statusCode: 400,
      details: { expected: "ENTWICKLER MODUS AKTIVIEREN" },
    });
  }

  const status = setPersonalDataDeveloperBootWithoutMasterKey(input.enabled);

  return {
    ok: true,
    area: "security/master-key/developer-boot",
    developerBootEnabled: status.developerBootEnabled,
    developerBootActive: status.developerBootActive,
    reason: input.reason || null,
    status,
    note: status.developerBootActive
      ? "Entwickler-Boot ist aktiv: Admin-/Fachaccounts können sich anmelden, Member-Logins bleiben gesperrt, verschlüsselte Personendaten bleiben gesperrt."
      : "Entwickler-Boot ist deaktiviert oder nicht nötig.",
  };
}

export function loadMasterKey(input: LoadMasterKeyFromFileBody) {
  loadPersonalDataMasterKeyFromFile(input.filePath);

  return {
    ok: true,
    area: "security/master-key/load",
    status: getPersonalDataMasterKeyStatus(),
  };
}

export function initializeMasterKeyStorage(input: InitializeMasterKeyStorageBody) {
  const result = initializePersonalDataMasterKeyStorage(input);

  return {
    ok: true,
    area: "security/master-key/initialize-storage",
    result,
    status: getPersonalDataMasterKeyStatus(),
  };
}

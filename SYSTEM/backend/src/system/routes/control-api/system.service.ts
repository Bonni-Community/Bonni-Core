import { getLocalAuthProviderStatus } from "../../../platform/auth/providers/local/index.js";
import { getOidcAuthProviderStatus } from "../../../platform/auth/providers/oidc/index.js";
import { getDatabaseOperationStatus } from "../../../core/database/database.js";

export type SystemSection = {
  key: string;
  label: string;
  route: string;
  localAvailable: boolean;
  status: "active" | "prepared";
};

export const systemSections: SystemSection[] = [
  {
    key: "monitoring",
    label: "Systemüberwachung",
    route: "/api/system/monitoring",
    localAvailable: true,
    status: "active",
  },
  {
    key: "modules",
    label: "Apps / Add-ons / Plug-ins",
    route: "/api/system/modules",
    localAvailable: true,
    status: "active",
  },
  {
    key: "registry",
    label: "Registry",
    route: "/api/system/registry",
    localAvailable: true,
    status: "active",
  },
  {
    key: "operation-modes",
    label: "Operation Modes",
    route: "/api/system/operation-modes",
    localAvailable: true,
    status: "prepared",
  },
  {
    key: "diagnostics",
    label: "Diagnostics",
    route: "/api/system/diagnostics",
    localAvailable: true,
    status: "active",
  },
  {
    key: "settings",
    label: "Settings",
    route: "/api/system/settings",
    localAvailable: true,
    status: "active",
  },
  {
    key: "security",
    label: "Sicherheit & Datenschutz",
    route: "/api/system/security/overview",
    localAvailable: true,
    status: "active",
  },
  {
    key: "users",
    label: "Users",
    route: "/api/system/users",
    localAvailable: true,
    status: "prepared",
  },
  {
    key: "backup",
    label: "Backup & Wiederherstellung",
    route: "/api/system/backup",
    localAvailable: true,
    status: "active",
  },
  {
    key: "update-center",
    label: "Update-Center",
    route: "/api/system/update-center",
    localAvailable: true,
    status: "active",
  },
  {
    key: "licenses",
    label: "Licenses",
    route: "/api/system/licenses",
    localAvailable: true,
    status: "prepared",
  },
];

export function getSystemStatus() {
  return {
    ok: true,
    area: "system",
    localAlwaysAvailable: true,
    local: getLocalAuthProviderStatus(),
    oidc: getOidcAuthProviderStatus(),
    database: getDatabaseOperationStatus(),
    sections: systemSections,
  };
}
